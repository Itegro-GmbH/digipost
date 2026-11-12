// Real Postgres, the proposal engine end to end (decisions/0080-ledger-double-entry-bookkeeping.md,
// phase 3): `syncProposals` reads documents, bank transactions, settlement lines and issued
// invoices through their owners' read methods, asks the (fake) AI advisor once per document,
// writes idempotent proposals, never books a clearing account's own transactions, matches what
// books and pays the same document, learns rules, and counts their hits.
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createFakeLedgerBookingAdvisor, type BookingAdviceQuestion, type LedgerBookingAdvisor } from "@/modules/ledger";
import { getDb } from "@/persistence/foundation/client";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { accounts, settlementLines, transactions } from "@/persistence/schema/accounts";
import { contacts, documentContacts } from "@/persistence/schema/contacts";
import { documents } from "@/persistence/schema/documents";
import { invoices } from "@/persistence/schema/invoices";
import { jobs } from "@/persistence/schema/jobs";
import { ledgerBookingAdvice } from "@/persistence/schema/ledger";
import { documentTransactions } from "@/persistence/schema/payments";
import { createLedgerUseCases } from "@/persistence/use-cases/ledger-use-cases";
import { JOB_KINDS } from "@/platform/jobs";

const db = getDb();
const USER = randomUUID();

/** The deterministic fake, counting what it is asked. */
function countingAdvisor(): LedgerBookingAdvisor & { asked: BookingAdviceQuestion[] } {
  const fake = createFakeLedgerBookingAdvisor();
  const asked: BookingAdviceQuestion[] = [];
  return {
    version: fake.version,
    asked,
    async advise(question) {
      asked.push(question);
      return fake.advise(question);
    },
  };
}

function ledgerWith(advisor: LedgerBookingAdvisor) {
  return createLedgerUseCases({ repos: createDrizzleRepositories(db), uow: createDrizzleUnitOfWork(db), bookingAdvisor: advisor });
}

async function contact(workspaceId: string, name: string, country = "DE", vatId: string | null = null) {
  const [row] = await db.insert(contacts).values({ workspaceId, name, nameNormalized: name.toLowerCase(), country, vatId, source: "manual" }).returning();
  return row!;
}

async function invoiceDocument(workspaceId: string, fields: { contactId?: string; title: string; total: number; date?: string; breakdown?: { ratePercent: number; netCents: number; taxCents: number }[]; kind?: "incoming_invoice" | "outgoing_invoice" | "payout_report"; direction?: "incoming" | "outgoing" | "unknown"; platform?: "apple" | "google" }) {
  const [row] = await db
    .insert(documents)
    .values({
      workspaceId,
      originalFileName: `${fields.title}.pdf`,
      mimeType: "application/pdf",
      pageCount: 1,
      sizeBytes: 1,
      storageKey: `k-${randomUUID()}`,
      kind: fields.kind ?? "incoming_invoice",
      direction: fields.direction ?? "incoming",
      platform: fields.platform ?? null,
      status: "done",
      documentDate: fields.date ?? "2026-07-01",
      title: fields.title,
      totalAmountCents: fields.kind === "payout_report" ? null : fields.total,
      currency: "EUR",
      taxBreakdown: fields.breakdown ?? null,
    })
    .returning();
  if (fields.contactId) await db.insert(documentContacts).values({ documentId: row!.id, contactId: fields.contactId, role: fields.direction === "outgoing" ? "recipient" : "sender" });
  return row!;
}

async function bankTx(workspaceId: string, accountId: string, amountCents: number, counterpartyName: string, bookingDate = "2026-07-05", transferGroupId: string | null = null) {
  const [row] = await db
    .insert(transactions)
    .values({ workspaceId, accountId, bookingDate, amountCents, creditDebit: amountCents >= 0 ? "credit" : "debit", counterpartyName, idempotencyKey: randomUUID(), transferGroupId })
    .returning();
  return row!;
}

async function confirm(workspaceId: string, documentId: string, transactionId: string, allocatedAmountCents: number) {
  await db.insert(documentTransactions).values({ workspaceId, documentId, transactionId, status: "confirmed", kind: "exact", confidence: 1, matchedBy: "user", allocatedAmountCents });
}

/** Itegro in miniature: Finom Main, Meta with its clearing account, Apple, IONOS, a customer. */
async function itegro() {
  const workspace = await createDrizzleWorkspaceRepository(db).create({ name: `Itegro GmbH ${randomUUID()}` });
  const workspaceId = workspace.id;
  const ionos = await contact(workspaceId, "IONOS SE");
  const meta = await contact(workspaceId, "Meta Platforms Ireland Ltd", "IE", "IE9692928F");
  const customer = await contact(workspaceId, "Kunde GmbH");
  const [bank] = await db.insert(accounts).values({ workspaceId, type: "bank", name: "Finom Main", iban: "DE89370400440532013000" }).returning();
  await db.insert(accounts).values({ workspaceId, type: "clearing", name: "Meta", contactId: meta.id });
  const [apple] = await db.insert(accounts).values({ workspaceId, type: "clearing", name: "Apple", platform: "apple" }).returning();

  // IONOS 1,50 paid by bank.
  const ionosDoc = await invoiceDocument(workspaceId, { contactId: ionos.id, title: "IONOS Rechnung", total: 150, breakdown: [{ ratePercent: 19, netCents: 126, taxCents: 24 }] });
  const ionosTx = await bankTx(workspaceId, bank!.id, -150, "IONOS SE");
  await confirm(workspaceId, ionosDoc.id, ionosTx.id, 150);

  // Meta: two charges 10 + 50, one reverse-charge invoice of 60 against the clearing account.
  const metaDoc = await invoiceDocument(workspaceId, { contactId: meta.id, title: "Meta Ads Rechnung", total: 6000, date: "2026-07-20" });
  const charge1 = await bankTx(workspaceId, bank!.id, -1000, "Meta Platforms Ireland Ltd", "2026-07-03");
  const charge2 = await bankTx(workspaceId, bank!.id, -5000, "Meta Platforms Ireland Ltd", "2026-07-18");

  // Apple: one July report (revenue 70,00, fees 11,80) and its payout of 58,20, paired by a
  // transfer group with the payout row on the Apple clearing account.
  const report = await invoiceDocument(workspaceId, { title: "Apple Juli", total: 0, kind: "payout_report", direction: "unknown", platform: "apple", date: "2026-07-31" });
  const group = randomUUID();
  const [clearingPayout] = await db
    .insert(transactions)
    .values({ workspaceId, accountId: apple!.id, bookingDate: "2026-08-28", amountCents: -5820, creditDebit: "debit", counterpartyName: "Apple", idempotencyKey: randomUUID(), transferGroupId: group })
    .returning();
  await db.insert(settlementLines).values([
    { workspaceId, clearingAccountId: apple!.id, sourceDocumentId: report.id, type: "revenue", externalLineId: "revenue:row1", grossCents: 7000, feeCents: 1180, netCents: 5820, bookingDate: "2026-07-15" },
    { workspaceId, clearingAccountId: apple!.id, sourceDocumentId: report.id, type: "fee", externalLineId: "fee:row1", grossCents: 7000, feeCents: 1180, netCents: 5820, bookingDate: "2026-07-15" },
    { workspaceId, clearingAccountId: apple!.id, sourceDocumentId: report.id, transactionId: clearingPayout!.id, type: "payout", externalLineId: "payout:p1", netCents: 5820, bookingDate: "2026-07-31" },
  ]);
  const payout = await bankTx(workspaceId, bank!.id, 5820, "Apple Distribution International", "2026-08-28", group);

  // An outgoing invoice issued in Digipost, 19 %.
  const inboxDoc = await invoiceDocument(workspaceId, { contactId: customer.id, title: "RE-2026-0001", total: 113_050, kind: "outgoing_invoice", direction: "outgoing", date: "2026-07-10" });
  const invoiceId = randomUUID();
  await db.insert(invoices).values({
    id: invoiceId,
    workspaceId,
    number: "RE-2026-0001",
    year: 2026,
    sequence: 1,
    type: "invoice",
    issueDate: "2026-07-10",
    currency: "EUR",
    netCents: 95_000,
    vatCents: 18_050,
    grossCents: 113_050,
    buyerName: "Kunde GmbH",
    contactId: customer.id,
    einvoiceInput: { buyer: { name: "Kunde GmbH", address: { country: "DE" } }, lines: [{ name: "Beratung", quantity: "10", unitPrice: "95.00", vat: { category: "S", rate: "19" } }] } as never,
    pdfStorageKey: "x.pdf",
    xmlStorageKey: "x.xml",
    pdfSha256: "0",
    xmlSha256: "0",
    documentId: inboxDoc.id,
  });

  // Share capital without a document, and an unexplained debit.
  const capital = await bankTx(workspaceId, bank!.id, 416_700, "Luca Schackmann", "2026-06-15");
  const mystery = await bankTx(workspaceId, bank!.id, -999, "Unbekannt GmbH", "2026-07-30");

  return { workspaceId, ionos, meta, bank: bank!, ionosDoc, ionosTx, metaDoc, charge1, charge2, report, clearingPayout: clearingPayout!, payout, invoiceId, inboxDoc, capital, mystery };
}

async function enable(ledger: ReturnType<typeof ledgerWith>, workspaceId: string) {
  await ledger.setSettings({ workspaceId, settings: { enabled: true, vatPeriod: "month", vatBasis: "soll", startDate: "2026-06-01" } });
}

async function bySourceKey(ledger: ReturnType<typeof ledgerWith>, workspaceId: string) {
  const entries = await ledger.listEntries(workspaceId, { dismissed: "include" });
  return new Map(entries.map((entry) => [entry.sourceKey, entry]));
}

const lineTuples = (entry: { lines: { accountNumber: string; amountCents: number; taxCode: string | null; documentId: string | null }[] }) =>
  entry.lines.map((line) => [line.accountNumber, line.amountCents, line.taxCode, line.documentId]);

describe("syncProposals (decisions/0080 phase 3)", () => {
  it("proposes every source once, from templates, the AI and rules; idempotent; clearing transactions never booked", async () => {
    const advisor = countingAdvisor();
    const ledger = ledgerWith(advisor);
    const w = await itegro();
    await enable(ledger, w.workspaceId);
    await ledger.createRule({
      workspaceId: w.workspaceId,
      rule: { contactId: null, counterpartyPattern: "luca schackmann", direction: "outgoing", accountNumber: "2900", taxCode: null, paymentAccountNumber: null, noDocument: true, active: true },
    });

    const first = await ledger.syncProposals({ workspaceId: w.workspaceId });
    expect(first).toMatchObject({ created: 9, updated: 0, kept: 0, failed: 0, unproposed: 1, deferred: 0, aiAsked: 2, aiCached: 0, aiUnavailable: 0, autoMatched: 0 });
    expect(advisor.asked.map((question) => question.senderName).sort()).toEqual(["IONOS SE", "Meta Platforms Ireland Ltd"]);
    for (const question of advisor.asked) expect(JSON.stringify(question)).not.toMatch(/ocr/i);

    const entries = await bySourceKey(ledger, w.workspaceId);
    expect([...entries.keys()].sort()).toEqual(
      [
        `doc:${w.ionosDoc.id}`,
        `doc:${w.metaDoc.id}`,
        `invoice:${w.invoiceId}`,
        `settlement:${w.report.id}:2026-07`,
        `tx:${w.ionosTx.id}`,
        `tx:${w.charge1.id}`,
        `tx:${w.charge2.id}`,
        `tx:${w.payout.id}`,
        `tx:${w.capital.id}`,
      ].sort(),
    );
    expect([...entries.values()].every((entry) => entry.status === "proposed")).toBe(true);

    const ionosInvoice = entries.get(`doc:${w.ionosDoc.id}`)!;
    expect(ionosInvoice).toMatchObject({ origin: "ai", documentId: w.ionosDoc.id });
    expect(lineTuples(ionosInvoice)).toEqual([
      ["6810", 126, "vst19", null],
      ["1406", 24, "vst19", null],
      ["3300", -150, null, w.ionosDoc.id],
    ]);
    expect(ionosInvoice.summary.key).toBe("summaries.expenseAgainstOpenItem");
    expect(lineTuples(entries.get(`doc:${w.metaDoc.id}`)!)).toEqual([
      ["6600", 6000, "rc13b", null],
      ["1407", 1140, "rc13b", null],
      ["3837", -1140, "rc13b", null],
      ["1461", -6000, null, w.metaDoc.id],
    ]);
    expect(lineTuples(entries.get(`tx:${w.charge1.id}`)!)).toEqual([
      ["1800", -1000, null, null],
      ["1461", 1000, null, null],
    ]);
    expect(lineTuples(entries.get(`settlement:${w.report.id}:2026-07`)!)).toEqual([
      ["4339", -7000, "eu_not_taxable", null],
      ["6855", 1180, null, null],
      ["1370", 5820, null, w.report.id],
    ]);
    expect(lineTuples(entries.get(`tx:${w.payout.id}`)!)).toEqual([
      ["1800", 5820, null, null],
      ["1370", -5820, null, w.report.id],
    ]);
    expect(lineTuples(entries.get(`invoice:${w.invoiceId}`)!)).toEqual([
      ["1200", 113_050, null, w.inboxDoc.id],
      ["4400", -95_000, "ust19", null],
      ["3806", -18_050, "ust19", null],
    ]);
    expect(entries.get(`tx:${w.capital.id}`)).toMatchObject({ origin: "rule" });
    expect(lineTuples(entries.get(`tx:${w.capital.id}`)!)).toEqual([
      ["1800", 416_700, null, null],
      ["2900", -416_700, null, null],
    ]);
    // Never the clearing account's own payout row, never the unexplained debit, never the
    // inbox document of the issued invoice.
    expect([...entries.values()].some((entry) => entry.transactionId === w.clearingPayout.id || entry.transactionId === w.mystery.id)).toBe(false);
    expect(entries.has(`doc:${w.inboxDoc.id}`)).toBe(false);
    for (const entry of entries.values()) expect(entry.differenceCents).toBe(0);

    // The second run writes nothing and asks nothing: every answer comes from the cache.
    const second = await ledger.syncProposals({ workspaceId: w.workspaceId });
    expect(second).toMatchObject({ created: 0, updated: 0, kept: 9, aiAsked: 0, aiCached: 2 });
    expect(advisor.asked).toHaveLength(2);
    expect(await db.select().from(ledgerBookingAdvice).where(eq(ledgerBookingAdvice.workspaceId, w.workspaceId))).toHaveLength(2);

    // A changed question is asked again.
    await db.update(documents).set({ title: "IONOS Rechnung Juli" }).where(eq(documents.id, w.ionosDoc.id));
    expect(await ledger.syncProposals({ workspaceId: w.workspaceId })).toMatchObject({ aiAsked: 1, aiCached: 1, created: 0 });
  });

  it("never overwrites an edited proposal and never proposes a dismissed source again", async () => {
    const ledger = ledgerWith(countingAdvisor());
    const w = await itegro();
    await enable(ledger, w.workspaceId);
    await ledger.syncProposals({ workspaceId: w.workspaceId });
    const entries = await bySourceKey(ledger, w.workspaceId);

    const edited = entries.get(`doc:${w.metaDoc.id}`)!;
    await ledger.updateEntry({
      workspaceId: w.workspaceId,
      userId: USER,
      entryId: edited.id,
      entry: { bookingDate: "2026-07-20", text: "Meta, von Hand", documentId: w.metaDoc.id, lines: [{ accountNumber: "6300", amountCents: 6000, taxCode: "rc13b" }, { accountNumber: "1461", amountCents: -6000, documentId: w.metaDoc.id }] },
    });
    const dismissed = entries.get(`tx:${w.charge1.id}`)!;
    await ledger.dismissProposal({ workspaceId: w.workspaceId, userId: USER, entryId: dismissed.id });

    const again = await ledger.syncProposals({ workspaceId: w.workspaceId });
    expect(again).toMatchObject({ created: 0, updated: 0 });
    const after = await bySourceKey(ledger, w.workspaceId);
    expect(after.get(`doc:${w.metaDoc.id}`)).toMatchObject({ text: "Meta, von Hand", revision: 2 });
    expect(after.get(`doc:${w.metaDoc.id}`)!.lines[0]!.accountNumber).toBe("6300");
    expect(after.get(`tx:${w.charge1.id}`)).toMatchObject({ dismissed: true, revision: 2 });
  });

  it("matches what books and pays the same document on booking; suggests the rest; never across workspaces", async () => {
    const ledger = ledgerWith(countingAdvisor());
    const w = await itegro();
    const other = await itegro();
    await enable(ledger, w.workspaceId);
    await enable(ledger, other.workspaceId);
    await ledger.syncProposals({ workspaceId: w.workspaceId });
    const entries = await bySourceKey(ledger, w.workspaceId);
    const ids = (keys: string[]) => keys.map((key) => entries.get(key)!.id);

    const booked = await ledger.bulkBook({
      workspaceId: w.workspaceId,
      userId: USER,
      entryIds: ids([`doc:${w.ionosDoc.id}`, `tx:${w.ionosTx.id}`, `settlement:${w.report.id}:2026-07`, `tx:${w.payout.id}`, `doc:${w.metaDoc.id}`, `tx:${w.charge1.id}`, `tx:${w.charge2.id}`]),
    });
    expect(booked.failed).toEqual([]);

    const accountsByNumber = new Map((await ledger.listAccounts(w.workspaceId)).map((account) => [account.number, account]));
    const openItems = await ledger.listOpenItemAccounts(w.workspaceId, "2026-12-31");
    const status = (number: string) => openItems.find((summary) => summary.account.number === number);
    expect(status("3300")).toMatchObject({ balanceCents: 0, unmatchedCount: 0 });
    expect(status("1370")).toMatchObject({ balanceCents: 0, unmatchedCount: 0 });
    expect(status("1461")).toMatchObject({ balanceCents: 0, unmatchedCount: 3 });

    const suggestions = await ledger.suggestMatches(w.workspaceId, accountsByNumber.get("1461")!.id);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ reason: "subset_sum", amountCents: 6000 });
    expect(suggestions[0]!.lineIds).toHaveLength(3);
    // Another workspace's account id is not found here.
    const foreign = (await ledger.listAccounts(other.workspaceId)).find((account) => account.number === "1461")!;
    await expect(ledger.suggestMatches(w.workspaceId, foreign.id)).rejects.toMatchObject({ code: "account_not_found" });
    expect(await ledger.listEntries(other.workspaceId)).toEqual([]);

    // A second automatic pass changes nothing.
    expect(await ledger.autoMatchOpenItems(w.workspaceId)).toBe(0);
  });

  it("learns a rule from a booked entry; the next document of that contact skips the AI and counts a hit when booked", async () => {
    const advisor = countingAdvisor();
    const ledger = ledgerWith(advisor);
    const w = await itegro();
    await enable(ledger, w.workspaceId);
    await ledger.syncProposals({ workspaceId: w.workspaceId });
    const entry = (await bySourceKey(ledger, w.workspaceId)).get(`doc:${w.ionosDoc.id}`)!;
    await ledger.bookEntry({ workspaceId: w.workspaceId, userId: USER, entryId: entry.id });

    const rule = await ledger.learnRuleFromEntry({ workspaceId: w.workspaceId, entryId: entry.id });
    expect(rule).toMatchObject({ contactId: w.ionos.id, direction: "incoming", accountNumber: "6810", taxCode: "vst19", paymentAccountNumber: null, noDocument: false, hits: 0, learnedFromEntryId: entry.id });
    // Learning again updates the same rule.
    expect((await ledger.learnRuleFromEntry({ workspaceId: w.workspaceId, entryId: entry.id })).id).toBe(rule.id);
    expect(await ledger.listRules(w.workspaceId)).toHaveLength(1);

    const august = await invoiceDocument(w.workspaceId, { contactId: w.ionos.id, title: "IONOS August", total: 150, date: "2026-08-01", breakdown: [{ ratePercent: 19, netCents: 126, taxCents: 24 }] });
    const asked = advisor.asked.length;
    await ledger.syncProposals({ workspaceId: w.workspaceId });
    expect(advisor.asked).toHaveLength(asked);
    const proposal = (await bySourceKey(ledger, w.workspaceId)).get(`doc:${august.id}`)!;
    expect(proposal).toMatchObject({ origin: "rule" });
    await ledger.bookEntry({ workspaceId: w.workspaceId, userId: USER, entryId: proposal.id });
    expect((await ledger.listRules(w.workspaceId))[0]).toMatchObject({ id: rule.id, hits: 1 });

    // A transaction without a document learns a no-document rule by counterparty.
    const capital = (await bySourceKey(ledger, w.workspaceId)).get(`tx:${w.capital.id}`);
    expect(capital).toBeUndefined();
    const { entryId } = await ledger.createEntry({
      workspaceId: w.workspaceId,
      userId: USER,
      book: true,
      entry: { bookingDate: "2026-06-15", text: "Stammeinlage", transactionId: w.capital.id, lines: [{ accountNumber: "1800", amountCents: 416_700 }, { accountNumber: "2900", amountCents: -416_700 }] },
    });
    expect(await ledger.learnRuleFromEntry({ workspaceId: w.workspaceId, entryId })).toMatchObject({ counterpartyPattern: "luca schackmann", noDocument: true, direction: "outgoing", accountNumber: "2900" });
  });

  it("without an advisor every document gets the template default with a warning; the sync job is queued once", async () => {
    const ledger = createLedgerUseCases({ repos: createDrizzleRepositories(db), uow: createDrizzleUnitOfWork(db) });
    const w = await itegro();
    expect(await ledger.scheduleSync(w.workspaceId)).toBe(false);
    await enable(ledger, w.workspaceId);
    const result = await ledger.syncProposals({ workspaceId: w.workspaceId, from: "2026-07-01", to: "2026-07-31" });
    expect(result).toMatchObject({ aiUnavailable: 2, aiAsked: 0 });
    const entries = await bySourceKey(ledger, w.workspaceId);
    expect(entries.get(`doc:${w.ionosDoc.id}`)).toMatchObject({ origin: "template", warnings: ["ai_unavailable"] });
    expect(entries.has(`tx:${w.capital.id}`)).toBe(false); // June: outside the period
    expect(entries.has(`tx:${w.payout.id}`)).toBe(false); // August

    expect(await ledger.scheduleSync(w.workspaceId)).toBe(true);
    await ledger.scheduleSync(w.workspaceId);
    expect(await db.select().from(jobs).where(and(eq(jobs.workspaceId, w.workspaceId), eq(jobs.kind, JOB_KINDS.ledgerSync)))).toHaveLength(1);
  });
});
