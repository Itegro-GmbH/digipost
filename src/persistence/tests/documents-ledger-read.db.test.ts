// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3): `DocumentRepository.listForLedger`
// (decisions/0080-ledger-double-entry-bookkeeping.md, phase 2) and the tax fields `markDone`
// writes. The counterparty pick, the confirmed-links aggregate and the workspace scoping are
// SQL, so only a real database proves them. Every test uses its own workspaces.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { normalizeName } from "@/modules/contacts";
import { EMPTY_TAX_FIELDS } from "@/modules/documents";
import { getDb } from "@/persistence/foundation/client";
import { createDrizzleAccountRepository, createDrizzleTransactionRepository } from "@/persistence/repositories/drizzle/accounts-repository";
import { createDrizzleContactRepository } from "@/persistence/repositories/drizzle/contacts-repository";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleDocumentTransactionRepository } from "@/persistence/repositories/drizzle/payments-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import type { CreateDocumentTransactionRow, MarkDocumentDoneInput } from "@/persistence/repositories/contracts";
import { documentContacts } from "@/persistence/schema/contacts";
import { documents } from "@/persistence/schema/documents";

const db = getDb();
const documentRepo = createDrizzleDocumentRepository(db);
const contactRepo = createDrizzleContactRepository(db);
const accountRepo = createDrizzleAccountRepository(db);
const transactionRepo = createDrizzleTransactionRepository(db);
const documentTransactionRepo = createDrizzleDocumentTransactionRepository(db);

async function createTestWorkspace(): Promise<{ id: string }> {
  return createDrizzleWorkspaceRepository(db).create({ name: `Ledger Read Co ${randomUUID()}` });
}

async function createDocument(workspaceId: string, originalFileName = "beleg.pdf"): Promise<string> {
  const row = await documentRepo.create({
    id: randomUUID(),
    workspaceId,
    uploadedByUserId: null,
    originalFileName,
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: 100,
    storageKey: `workspaces/${workspaceId}/documents/${randomUUID()}/original.pdf`,
    fileHash: randomUUID(),
  });
  return row.id;
}

function doneInput(overrides: Partial<MarkDocumentDoneInput> = {}): MarkDocumentDoneInput {
  return {
    ocrText: "Rechnung",
    ocrBlocks: null,
    title: "Rechnung",
    sender: "Druckerei Muster GmbH",
    documentDate: "2026-03-31",
    summary: null,
    searchablePdfKey: `searchable-${randomUUID()}.pdf`,
    direction: "incoming",
    invoiceNumber: "RE-1",
    totalAmountCents: 18188,
    currency: "EUR",
    dueDate: "2099-01-01",
    paymentIban: null,
    paymentReference: null,
    paidNote: null,
    ...EMPTY_TAX_FIELDS,
    taxCheck: null,
    kind: "incoming_invoice",
    paymentStatus: "open",
    ...overrides,
  };
}

async function linkContact(
  workspaceId: string,
  documentId: string,
  role: "sender" | "recipient",
  fields: { name: string; vatId?: string | null; country?: string | null },
  createdAt = new Date("2026-01-01T00:00:00Z"),
) {
  const contact = await contactRepo.create({
    workspaceId,
    name: fields.name,
    nameNormalized: normalizeName(fields.name),
    vatId: fields.vatId ?? null,
    country: fields.country ?? null,
    source: "auto",
    verifiedAt: null,
  });
  await db.insert(documentContacts).values({ documentId, contactId: contact.id, role, createdAt });
  return contact;
}

async function createBankTransaction(workspaceId: string, bookingDate: string, amountCents: number) {
  const bank = await accountRepo.create({ workspaceId, type: "bank", name: "Bank", iban: null, bic: null, currency: "EUR", holder: null, platform: null });
  const [row] = await transactionRepo.insertManyIdempotent([
    {
      workspaceId,
      accountId: bank.id,
      bookingDate,
      valueDate: null,
      amountCents,
      currency: "EUR",
      creditDebit: amountCents < 0 ? "debit" : "credit",
      counterpartyName: "Druckerei Muster GmbH",
      counterpartyIban: null,
      counterpartyBic: null,
      remittanceText: "RE-1",
      endToEndId: null,
      mandateId: null,
      creditorId: null,
      bankTxCode: null,
      bankReference: null,
      idempotencyKey: `key-${randomUUID()}`,
      importBatchId: null,
      sourceDocumentId: null,
      raw: null,
    },
  ]);
  return row!;
}

function linkRow(workspaceId: string, documentId: string, transactionId: string, status: "confirmed" | "suggested", allocatedAmountCents: number): CreateDocumentTransactionRow {
  return {
    workspaceId,
    documentId,
    transactionId,
    status,
    kind: "exact",
    confidence: 100,
    reasons: [],
    explanation: null,
    matchedBy: "auto",
    allocatedAmountCents,
    arbiterCacheKey: null,
    decidedAt: status === "confirmed" ? new Date() : null,
    decidedByUserId: null,
  };
}

describe("DocumentRepository.listForLedger (decisions/0080, phase 2)", () => {
  it("returns the tax fields markDone wrote, the counterparty contact, and only confirmed links", async () => {
    const workspace = await createTestWorkspace();
    const documentId = await createDocument(workspace.id);
    await documentRepo.markDone(
      workspace.id,
      documentId,
      doneInput({
        taxBreakdown: [
          { ratePercent: 19, netCents: 10788, taxCents: 2050 },
          { ratePercent: 7, netCents: 5000, taxCents: 350 },
        ],
        netTotalCents: 15788,
        taxTotalCents: 2400,
        passThroughCents: 0,
        reverseCharge: false,
        serviceDate: "2026-03-15",
        servicePeriodFrom: "2026-03-01",
        servicePeriodTo: "2026-03-31",
        taxCheck: "consistent",
      }),
    );
    // Our own company is also linked (as the recipient); only the sender is the counterparty
    // of an incoming document.
    const supplier = await linkContact(workspace.id, documentId, "sender", { name: "Druckerei Muster GmbH", vatId: "DE123456789", country: "DE" });
    await linkContact(workspace.id, documentId, "recipient", { name: "Eigene GmbH", vatId: "DE987654321", country: "DE" });

    const later = await createBankTransaction(workspace.id, "2026-04-20", -8188);
    const earlier = await createBankTransaction(workspace.id, "2026-04-10", -10000);
    const suggested = await createBankTransaction(workspace.id, "2026-04-15", -18188);
    await documentTransactionRepo.createConfirmed(linkRow(workspace.id, documentId, later.id, "confirmed", 8188));
    await documentTransactionRepo.createConfirmed(linkRow(workspace.id, documentId, earlier.id, "confirmed", 10000));
    await documentTransactionRepo.upsertSuggestion(linkRow(workspace.id, documentId, suggested.id, "suggested", 18188));

    const rows = await documentRepo.listForLedger(workspace.id);
    expect(rows).toEqual([
      {
        id: documentId,
        kind: "incoming_invoice",
        direction: "incoming",
        status: "done",
        documentDate: "2026-03-31",
        effectiveDate: "2026-03-31",
        title: "Rechnung",
        sender: "Druckerei Muster GmbH",
        summary: null,
        originalFileName: "beleg.pdf",
        invoiceNumber: "RE-1",
        totalAmountCents: 18188,
        currency: "EUR",
        platform: null,
        paymentStatus: "open",
        taxBreakdown: [
          { ratePercent: 19, netCents: 10788, taxCents: 2050 },
          { ratePercent: 7, netCents: 5000, taxCents: 350 },
        ],
        netTotalCents: 15788,
        taxTotalCents: 2400,
        passThroughCents: 0,
        reverseCharge: false,
        serviceDate: "2026-03-15",
        servicePeriodFrom: "2026-03-01",
        servicePeriodTo: "2026-03-31",
        taxCheck: "consistent",
        contactId: supplier.id,
        contactName: "Druckerei Muster GmbH",
        contactVatId: "DE123456789",
        contactCountry: "DE",
        // Oldest booking first, suggestions left out.
        confirmedTransactions: [
          { transactionId: earlier.id, allocatedAmountCents: 10000 },
          { transactionId: later.id, allocatedAmountCents: 8188 },
        ],
      },
    ]);
  });

  it("takes the recipient of an outgoing document, a human's kind, and nulls for an unprocessed one", async () => {
    const workspace = await createTestWorkspace();
    const outgoing = await createDocument(workspace.id, "ausgang.pdf");
    await documentRepo.markDone(workspace.id, outgoing, doneInput({ direction: "outgoing", kind: "outgoing_invoice", documentDate: "2026-02-01", reverseCharge: true }));
    await linkContact(workspace.id, outgoing, "sender", { name: "Eigene GmbH" });
    await linkContact(workspace.id, outgoing, "recipient", { name: "Kunde Ireland Ltd", vatId: "IE9692928F", country: "IE" });
    // decisions/0072: a human's kind wins over the stored classification.
    await db.update(documents).set({ manualKind: "receipt" }).where(eq(documents.id, outgoing));
    const uploaded = await createDocument(workspace.id, "neu.pdf");

    const rows = await documentRepo.listForLedger(workspace.id);
    const byFile = new Map(rows.map((row) => [row.originalFileName, row]));
    expect(byFile.get("ausgang.pdf")).toMatchObject({ kind: "receipt", reverseCharge: true, contactName: "Kunde Ireland Ltd", contactCountry: "IE" });
    expect(byFile.get("neu.pdf")).toMatchObject({
      id: uploaded,
      status: "uploaded",
      kind: "letter",
      taxBreakdown: null,
      taxCheck: null,
      contactId: null,
      confirmedTransactions: [],
    });
  });

  it("filters by the inclusive effective-date range, either bound optional", async () => {
    const workspace = await createTestWorkspace();
    for (const [file, documentDate] of [
      ["mai.pdf", "2026-05-31"],
      ["juni.pdf", "2026-06-01"],
      ["juli.pdf", "2026-07-01"],
    ] as const) {
      const id = await createDocument(workspace.id, file);
      await documentRepo.markDone(workspace.id, id, doneInput({ documentDate }));
    }
    const files = async (from?: string, to?: string) => (await documentRepo.listForLedger(workspace.id, from, to)).map((row) => row.originalFileName);

    expect(await files("2026-06-01", "2026-06-30")).toEqual(["juni.pdf"]);
    expect(await files("2026-06-01")).toEqual(["juni.pdf", "juli.pdf"]);
    expect(await files(undefined, "2026-06-01")).toEqual(["mai.pdf", "juni.pdf"]);
    expect(await files()).toEqual(["mai.pdf", "juni.pdf", "juli.pdf"]);
  });

  it("is workspace-scoped: no other workspace's documents, contacts or links", async () => {
    const workspace = await createTestWorkspace();
    const other = await createTestWorkspace();
    const ours = await createDocument(workspace.id, "unser.pdf");
    await documentRepo.markDone(workspace.id, ours, doneInput());
    const theirs = await createDocument(other.id, "fremd.pdf");
    await documentRepo.markDone(other.id, theirs, doneInput());
    await linkContact(other.id, theirs, "sender", { name: "Fremder Lieferant" });
    // A link row pointing from our document to another workspace's contact must never surface
    // that contact (defense in depth: nothing in the product writes such a row).
    await linkContact(other.id, ours, "sender", { name: "Fremder Kontakt", vatId: "DE000000000" });
    const theirTransaction = await createBankTransaction(other.id, "2026-04-01", -18188);
    await documentTransactionRepo.createConfirmed(linkRow(other.id, theirs, theirTransaction.id, "confirmed", 18188));

    const rows = await documentRepo.listForLedger(workspace.id);
    expect(rows.map((row) => row.originalFileName)).toEqual(["unser.pdf"]);
    expect(rows[0]).toMatchObject({ contactId: null, contactName: null, contactVatId: null, confirmedTransactions: [] });
    expect((await documentRepo.listForLedger(other.id)).map((row) => row.originalFileName)).toEqual(["fremd.pdf"]);
  });
});
