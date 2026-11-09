// `createInvoiceUseCases` (decisions/0079-outgoing-invoices.md) with typed fakes: no database,
// no vi.mock. The renderer is a fake here (its own test runs the real library); the document
// side is a stub of the three `DocumentUseCases` methods invoicing calls. The Unit of Work rolls
// the fake repositories back when its work throws, like Postgres would.
import { describe, expect, it, vi } from "vitest";

import { emptyDraftContent, InvoiceValidationError, type InvoiceDraftContent, type InvoiceRenderer } from "@/modules/invoicing";
import type { Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import type { DocumentUseCases } from "@/persistence/use-cases/documents-use-cases";
import { createInvoiceUseCases, INVOICE_ERROR, InvoiceInvalidError } from "@/persistence/use-cases/invoices-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { createFakeInvoiceRepository } from "@/persistence/tests/support/fake-invoices-repositories";
import { createFakeWorkspaceRepository, workspaceRow } from "@/persistence/tests/support/fake-workspaces-repositories";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";
import { createFakeObjectStorage } from "@/platform/object-storage/tests/support/fake-object-storage";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const USER = { userId: "33333333-3333-4333-8333-333333333333", userEmail: "anna@muster.de" };
// 2026-11-05 10:00 in Berlin.
const NOW = new Date("2026-11-05T09:00:00Z");

const COMPLETE: InvoiceDraftContent = {
  ...emptyDraftContent(),
  buyer: { name: "Kunde KG", addressLine1: "Weg 2", addressLine2: "", postalCode: "50667", city: "Köln", country: "DE", vatId: "", email: "", orderReference: "", buyerReference: "" },
  lines: [{ name: "Beratung", description: "", quantity: "2", unit: "HUR", unitPrice: "95.00", vatRate: "19" }],
};

function fakeRenderer(overrides: Partial<InvoiceRenderer> = {}): InvoiceRenderer {
  return {
    check: vi.fn(async () => ({ violations: [], totals: { netCents: 19000, vatCents: 3610, grossCents: 22610 } })),
    render: vi.fn(async (input) => {
      const sign = input.type === "correction" ? -1 : 1;
      return { pdf: new TextEncoder().encode(`%PDF ${input.number}`), xml: `<xml>${input.number}</xml>`, pageCount: 1, totals: { netCents: sign * 19000, vatCents: sign * 3610, grossCents: sign * 22610 } };
    }),
    ...overrides,
  };
}

function setup(options: { renderer?: InvoiceRenderer; companyIncomplete?: boolean; documents?: Partial<DocumentUseCases> } = {}) {
  const { repo: workspace } = createFakeWorkspaceRepository([
    workspaceRow({
      id: WORKSPACE_ID,
      name: "Muster GmbH",
      companyAddressLine1: options.companyIncomplete ? null : "Hauptstraße 1",
      companyPostalCode: "10115",
      companyCity: "Berlin",
      companyVatId: "DE123456789",
      companyIbans: ["DE89370400440532013000"],
    }),
    workspaceRow({ id: OTHER_WORKSPACE_ID, name: "Andere GmbH" }),
  ]);
  const invoiceFake = createFakeInvoiceRepository();
  const contact = { findById: async () => null, list: async () => ({ items: [], hasMore: false }) };
  const document = { findById: async () => null };
  const repos = withUnusedRepositories({ workspace, invoice: invoiceFake.repo, contact, document } as unknown as Partial<Repositories>);
  const uow: UnitOfWork = {
    async transaction(work) {
      const snapshot = invoiceFake.snapshot();
      try {
        return await work(repos);
      } catch (err) {
        invoiceFake.restore(snapshot);
        throw err;
      }
    },
  };
  const { storage, objects } = createFakeObjectStorage();
  let documentCount = 0;
  const documents = {
    precheckQuota: vi.fn(async () => undefined),
    createForIssuedInvoice: vi.fn(async (_repos: Repositories, input: { workspaceId: string; pdfBytes: Uint8Array }) => {
      documentCount += 1;
      const storageKey = `workspaces/${input.workspaceId}/documents/doc-${documentCount}/original.pdf`;
      await storage.putObject({ key: storageKey, body: input.pdfBytes, contentType: "application/pdf" });
      return { documentId: `doc-${documentCount}`, storageKey };
    }),
    linkIssuedInvoiceCounterparty: vi.fn(async () => undefined),
    ...options.documents,
  };
  const renderer = options.renderer ?? fakeRenderer();
  let ids = 0;
  const useCases = createInvoiceUseCases({
    repos,
    uow,
    objectStorage: storage,
    renderer,
    documents: documents as unknown as DocumentUseCases,
    now: () => NOW,
    generateId: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++ids).padStart(12, "0")}`,
  });
  return { useCases, invoices: invoiceFake.state.invoices, objects, documents, renderer };
}

async function draftWith(useCases: ReturnType<typeof setup>["useCases"], content: InvoiceDraftContent = COMPLETE) {
  const { id } = await useCases.createDraft({ workspaceId: WORKSPACE_ID, userId: USER.userId });
  await useCases.updateDraft({ workspaceId: WORKSPACE_ID, draftId: id, content });
  return id;
}

describe("createInvoiceUseCases (decisions/0079-outgoing-invoices.md)", () => {
  it("prefills a new draft with the workspace's first own IBAN", async () => {
    const { useCases } = setup();
    const { id } = await useCases.createDraft({ workspaceId: WORKSPACE_ID, userId: USER.userId });
    expect((await useCases.getDraft(WORKSPACE_ID, id))?.content.paymentIban).toBe("DE89370400440532013000");
  });

  it("never returns another workspace's draft", async () => {
    const { useCases } = setup();
    const id = await draftWith(useCases);
    expect(await useCases.getDraft(OTHER_WORKSPACE_ID, id)).toBeNull();
    await expect(useCases.deleteDraft(OTHER_WORKSPACE_ID, id)).rejects.toMatchObject({ code: INVOICE_ERROR.notFound });
  });

  it("numbers finalized invoices <year>-<sequence>, in order, and deletes the draft", async () => {
    const { useCases, invoices, objects, documents } = setup();
    const first = await useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId: await draftWith(useCases), ...USER });
    const second = await useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId: await draftWith(useCases), ...USER });

    expect(invoices.map((row) => [row.number, row.issueDate, row.type])).toEqual([
      ["2026-0001", "2026-11-05", "invoice"],
      ["2026-0002", "2026-11-05", "invoice"],
    ]);
    expect(await useCases.listDrafts(WORKSPACE_ID)).toEqual([]);
    const issued = await useCases.getInvoice(WORKSPACE_ID, first.invoiceId);
    expect(issued).toMatchObject({ number: "2026-0001", grossCents: 22610, dueDate: "2026-11-19", documentId: null, events: [{ kind: "issued", actorEmail: USER.userEmail }] });
    // PDF + XML archived under the workspace prefix, plus the inbox document's copy.
    expect([...objects.keys()].filter((key) => key.includes("/invoices/"))).toHaveLength(4);
    expect(documents.createForIssuedInvoice).toHaveBeenCalledTimes(2);
    expect(documents.linkIssuedInvoiceCounterparty).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID, buyer: expect.objectContaining({ name: "Kunde KG" }) }));
    expect(second.invoiceId).not.toBe(first.invoiceId);
  });

  it("refuses to finalize while the company profile lacks what section 14 UStG requires", async () => {
    const { useCases, invoices } = setup({ companyIncomplete: true });
    const draftId = await draftWith(useCases);
    await expect(useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId, ...USER })).rejects.toMatchObject({ code: INVOICE_ERROR.companyProfileIncomplete });
    expect(invoices).toHaveLength(0);
  });

  it("refuses an incomplete draft with its violations, before taking a number", async () => {
    const { useCases, invoices, documents } = setup();
    const draftId = await draftWith(useCases, { ...COMPLETE, lines: [{ ...COMPLETE.lines[0]!, unitPrice: "" }] });
    const err = await useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId, ...USER }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceInvalidError);
    expect((err as InvoiceInvalidError).violations.map((v) => v.rule)).toContain("DP-INV-004");
    expect(invoices).toHaveLength(0);
    expect(documents.precheckQuota).not.toHaveBeenCalled();
  });

  it("hands the number back and removes every written object when rendering fails", async () => {
    let fail = true;
    const renderer = fakeRenderer({
      render: vi.fn(async (input) => {
        if (fail) throw new InvoiceValidationError([{ rule: "BR-CO-10", path: "lines[0]", message: "" }]);
        return { pdf: new Uint8Array([1]), xml: `<xml>${input.number}</xml>`, pageCount: 1, totals: { netCents: 1, vatCents: 0, grossCents: 1 } };
      }),
    });
    const { useCases, invoices, objects } = setup({ renderer });
    const draftId = await draftWith(useCases);

    await expect(useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId, ...USER })).rejects.toBeInstanceOf(InvoiceInvalidError);
    expect(invoices).toHaveLength(0);
    expect(objects.size).toBe(0);
    expect(await useCases.getDraft(WORKSPACE_ID, draftId)).not.toBeNull();

    fail = false;
    await useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId, ...USER });
    expect(invoices.map((row) => row.number)).toEqual(["2026-0001"]);
  });

  it("rolls everything back when the inbox document hits the quota", async () => {
    const { useCases, invoices, objects } = setup({
      documents: {
        createForIssuedInvoice: vi.fn(async () => {
          throw new UseCaseError("quota_monthly_exceeded");
        }),
      },
    });
    const draftId = await draftWith(useCases);
    await expect(useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId, ...USER })).rejects.toMatchObject({ code: "quota_monthly_exceeded" });
    expect(invoices).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("a second finalize of the same draft finds it gone", async () => {
    const { useCases, invoices } = setup();
    const draftId = await draftWith(useCases);
    await useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId, ...USER });
    await expect(useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId, ...USER })).rejects.toMatchObject({ code: INVOICE_ERROR.notFound });
    expect(invoices).toHaveLength(1);
  });

  it("cancels an invoice with a new numbered correction invoice and leaves the original untouched", async () => {
    const { useCases, invoices, renderer } = setup();
    const { invoiceId } = await useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId: await draftWith(useCases), ...USER });
    const originalBefore = { ...invoices[0]! };

    const { invoiceId: cancellationId } = await useCases.cancelInvoice({ workspaceId: WORKSPACE_ID, invoiceId, ...USER });

    expect(invoices[0]).toEqual(originalBefore);
    const cancellation = await useCases.getInvoice(WORKSPACE_ID, cancellationId);
    expect(cancellation).toMatchObject({ number: "2026-0002", type: "cancellation", cancelsId: invoiceId, cancelsNumber: "2026-0001", grossCents: -22610, dueDate: null });
    expect(vi.mocked(renderer.render).mock.calls[1]![0]).toMatchObject({ type: "correction", precedingInvoices: [{ number: "2026-0001" }] });
    const original = await useCases.getInvoice(WORKSPACE_ID, invoiceId);
    expect(original).toMatchObject({ cancelledById: cancellationId, cancelledByNumber: "2026-0002" });
    expect(original?.events.map((event) => event.kind)).toEqual(["issued", "cancelled"]);
  });

  it("refuses to cancel twice, or to cancel a cancellation", async () => {
    const { useCases, invoices } = setup();
    const { invoiceId } = await useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId: await draftWith(useCases), ...USER });
    const { invoiceId: cancellationId } = await useCases.cancelInvoice({ workspaceId: WORKSPACE_ID, invoiceId, ...USER });

    await expect(useCases.cancelInvoice({ workspaceId: WORKSPACE_ID, invoiceId, ...USER })).rejects.toMatchObject({ code: INVOICE_ERROR.alreadyCancelled });
    await expect(useCases.cancelInvoice({ workspaceId: WORKSPACE_ID, invoiceId: cancellationId, ...USER })).rejects.toMatchObject({ code: INVOICE_ERROR.notCancellable });
    expect(invoices).toHaveLength(2);
  });

  it("never cancels another workspace's invoice", async () => {
    const { useCases } = setup();
    const { invoiceId } = await useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId: await draftWith(useCases), ...USER });
    await expect(useCases.cancelInvoice({ workspaceId: OTHER_WORKSPACE_ID, invoiceId, ...USER })).rejects.toMatchObject({ code: INVOICE_ERROR.notFound });
    expect(await useCases.getInvoiceFile(OTHER_WORKSPACE_ID, invoiceId, "pdf")).toBeNull();
  });

  it("serves the archived files and streams every one into the archive, oldest first", async () => {
    const { useCases } = setup();
    const { invoiceId } = await useCases.finalizeDraft({ workspaceId: WORKSPACE_ID, draftId: await draftWith(useCases), ...USER });
    await useCases.cancelInvoice({ workspaceId: WORKSPACE_ID, invoiceId, ...USER });

    const pdf = await useCases.getInvoiceFile(WORKSPACE_ID, invoiceId, "pdf");
    expect(pdf).toMatchObject({ fileName: "Rechnung-2026-0001.pdf", contentType: "application/pdf" });
    expect(new TextDecoder().decode(pdf!.bytes)).toBe("%PDF 2026-0001");

    const names: string[] = [];
    for await (const entry of useCases.archiveEntries(WORKSPACE_ID)) names.push(entry.name);
    expect(names).toEqual(["rechnungen/Rechnung-2026-0001.pdf", "rechnungen/Rechnung-2026-0001.xml", "rechnungen/Storno-2026-0002.pdf", "rechnungen/Storno-2026-0002.xml"]);
    expect(await useCases.countIssued(WORKSPACE_ID)).toBe(2);
  });

  it("drops a contact id that does not belong to the workspace", async () => {
    const { useCases } = setup();
    const { id } = await useCases.createDraft({ workspaceId: WORKSPACE_ID, userId: USER.userId });
    const saved = await useCases.updateDraft({ workspaceId: WORKSPACE_ID, draftId: id, content: { ...COMPLETE, contactId: "44444444-4444-4444-8444-444444444444" } });
    expect(saved.content.contactId).toBeNull();
  });
});
