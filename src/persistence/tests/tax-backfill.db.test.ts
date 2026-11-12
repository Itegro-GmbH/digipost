// Real Postgres for the tax field backfill (src/modules/documents/README.md, "Tax field
// backfill"): which documents qualify, that two concurrent clicks never queue a document twice,
// that the write only lands while every tax field is still empty, and the whole way from the
// button to the ledger: an Apple Ireland invoice processed before the tax fields existed is
// proposed as reverse charge flagged `tax_unverified`; once its printed German VAT is read, the
// untouched proposal becomes `vst19` with `foreign_supplier_with_vat`.
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createTestPaymentProvider } from "@/modules/billing";
import { createFakeDocumentAnalyzer, createFakeOcrEngine } from "@/modules/documents";
import { createFakeIntakeClassifier } from "@/modules/intake";
import { createFakeLedgerBookingAdvisor } from "@/modules/ledger";
import { getDb } from "@/persistence/foundation/client";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { contacts, documentContacts } from "@/persistence/schema/contacts";
import { documents } from "@/persistence/schema/documents";
import { jobs } from "@/persistence/schema/jobs";
import { createBillingUseCases } from "@/persistence/use-cases/billing-use-cases";
import { createContactUseCases } from "@/persistence/use-cases/contacts-use-cases";
import { createDocumentUseCases } from "@/persistence/use-cases/documents-use-cases";
import { createLedgerUseCases } from "@/persistence/use-cases/ledger-use-cases";
import { JOB_KINDS } from "@/platform/jobs";
import { createFakeObjectStorage } from "@/platform/object-storage/tests/support/fake-object-storage";

const db = getDb();
const repos = createDrizzleRepositories(db);
const uow = createDrizzleUnitOfWork(db);

/** The OCR text of Apple's developer invoice, in the printed-line shape the fake analyzer reads. */
const APPLE_OCR = ["Apple Distribution International Ltd.", "Rechnung", "Apple Developer Program", "Rechnungsbetrag: 99,00 EUR", "Netto 19 %: 83,19 EUR", "USt 19 %: 15,81 EUR"].join("\n");

function setup() {
  const { storage } = createFakeObjectStorage();
  const documentsUseCases = createDocumentUseCases({
    repos,
    uow,
    objectStorage: storage,
    billing: createBillingUseCases({ repos, uow, paymentProvider: createTestPaymentProvider() }),
    contacts: createContactUseCases({ repos, uow }),
    ocrEngine: createFakeOcrEngine(),
    analyzer: createFakeDocumentAnalyzer(),
    intakeClassifier: createFakeIntakeClassifier(),
  });
  const ledger = createLedgerUseCases({ repos, uow, bookingAdvisor: createFakeLedgerBookingAdvisor() });
  return { storage, documentsUseCases, ledger };
}

async function oldDocument(workspaceId: string, overrides: Partial<typeof documents.$inferInsert> = {}) {
  const [row] = await db
    .insert(documents)
    .values({
      workspaceId,
      originalFileName: "rechnung.pdf",
      mimeType: "application/pdf",
      pageCount: 1,
      sizeBytes: 1,
      storageKey: `workspaces/${workspaceId}/documents/${randomUUID()}/original.pdf`,
      kind: "incoming_invoice",
      direction: "incoming",
      status: "done",
      documentDate: "2026-07-01",
      title: "Rechnung",
      totalAmountCents: 9900,
      currency: "EUR",
      ocrText: APPLE_OCR,
      ...overrides,
    })
    .returning();
  return row!;
}

describe("the tax field backfill against Postgres", () => {
  it("counts and marks only qualifying documents, never the same one twice under concurrent clicks", async () => {
    const workspace = await repos.workspace.create({ name: `Backfill ${randomUUID()}` });
    const other = await repos.workspace.create({ name: `Other ${randomUUID()}` });
    const qualifying = await Promise.all(Array.from({ length: 6 }, () => oldDocument(workspace.id)));
    await oldDocument(workspace.id, { manualKind: "receipt", kind: "letter" }); // effective kind counts
    await oldDocument(workspace.id, { reverseCharge: false }); // already has a tax field
    await oldDocument(workspace.id, { kind: "letter" });
    await oldDocument(workspace.id, { totalAmountCents: null });
    await oldDocument(workspace.id, { ocrText: null });
    await oldDocument(workspace.id, { status: "processing" });
    await oldDocument(other.id);

    expect(await repos.document.countTaxBackfillCandidates(workspace.id)).toBe(7);
    const now = new Date();
    const [a, b] = await Promise.all([
      uow.transaction((tx) => tx.document.markTaxBackfillRequested(workspace.id, { limit: 5, now })),
      uow.transaction((tx) => tx.document.markTaxBackfillRequested(workspace.id, { limit: 5, now })),
    ]);
    const marked = [...a, ...b];
    expect(new Set(marked).size).toBe(marked.length);
    expect(marked.length).toBe(7);
    expect(qualifying.every((doc) => marked.includes(doc.id))).toBe(true);
    expect(await repos.document.countTaxBackfillCandidates(workspace.id)).toBe(0);
  });

  it("writes the tax fields only while all of them are still empty", async () => {
    const workspace = await repos.workspace.create({ name: `Backfill ${randomUUID()}` });
    const empty = await oldDocument(workspace.id);
    const filled = await oldDocument(workspace.id, { taxTotalCents: 1 });
    const fields = { taxBreakdown: [{ ratePercent: 19, netCents: 8319, taxCents: 1581 }], netTotalCents: null, taxTotalCents: null, passThroughCents: null, reverseCharge: null, serviceDate: null, servicePeriodFrom: null, servicePeriodTo: null, taxCheck: null };
    expect(await repos.document.fillEmptyTaxFields(workspace.id, empty.id, fields)).toBe(true);
    expect(await repos.document.fillEmptyTaxFields(workspace.id, filled.id, fields)).toBe(false);
    expect(await repos.document.fillEmptyTaxFields(randomUUID(), empty.id, fields)).toBe(false);
    const [row] = await db.select().from(documents).where(eq(documents.id, filled.id));
    expect(row).toMatchObject({ taxBreakdown: null, taxTotalCents: 1 });
  });

  it("turns an Apple Ireland invoice's tax_unverified reverse charge into its printed German VAT", async () => {
    const { storage, documentsUseCases, ledger } = setup();
    const workspace = await repos.workspace.create({ name: `Itegro ${randomUUID()}` });
    const workspaceId = workspace.id;
    const [apple] = await db.insert(contacts).values({ workspaceId, name: "Apple Distribution International Ltd.", nameNormalized: "apple distribution international", country: "IE", vatId: "IE9700053D", source: "manual" }).returning();
    const doc = await oldDocument(workspaceId, { title: "Apple Developer Program" });
    await db.insert(documentContacts).values({ documentId: doc.id, contactId: apple!.id, role: "sender" });
    const pdf = await PDFDocument.create();
    pdf.addPage([595.28, 841.89]);
    await storage.putObject({ key: doc.storageKey, body: await pdf.save(), contentType: "application/pdf" });

    await ledger.setSettings({ workspaceId, settings: { enabled: true, vatPeriod: "month", vatBasis: "soll", startDate: "2026-01-01" } });
    await ledger.syncProposals({ workspaceId });
    const proposal = async () => (await ledger.listEntries(workspaceId, { dismissed: "include" })).find((entry) => entry.sourceKey === `doc:${doc.id}`)!;
    expect((await proposal()).warnings).toContain("tax_unverified");
    expect((await proposal()).lines[0]).toMatchObject({ amountCents: 9900, taxCode: "rc13b" });

    expect(await documentsUseCases.requestTaxFieldBackfill({ workspaceId })).toEqual({ queued: 1, remaining: 0 });
    const queued = await db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId));
    expect(queued.filter((job) => job.kind === JOB_KINDS.backfillTaxFields).map((job) => job.payload)).toEqual([{ workspaceId, documentId: doc.id }]);
    expect(await documentsUseCases.requestTaxFieldBackfill({ workspaceId })).toEqual({ queued: 0, remaining: 0 });

    expect(await documentsUseCases.backfillDocumentTaxFields({ workspaceId, documentId: doc.id })).toEqual({ filled: true });
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row).toMatchObject({ taxBreakdown: [{ ratePercent: 19, netCents: 8319, taxCents: 1581 }], title: "Apple Developer Program", totalAmountCents: 9900 });
    // A second run of the same job changes nothing.
    expect(await documentsUseCases.backfillDocumentTaxFields({ workspaceId, documentId: doc.id })).toEqual({ filled: false });

    const sync = await ledger.syncProposals({ workspaceId });
    expect(sync.updated).toBe(1);
    const updated = await proposal();
    expect(updated.warnings).toEqual(["foreign_supplier_with_vat"]);
    expect(updated.lines.slice(0, 2).map((line) => [line.accountNumber, line.amountCents, line.taxCode])).toEqual([
      ["6837", 8319, "vst19"],
      ["1406", 1581, "vst19"],
    ]);
  });
});
