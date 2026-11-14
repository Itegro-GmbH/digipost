// The source push of the API-backed ledger (decisions/0081-ledger-via-api.md, stage A): a full,
// idempotent snapshot of a workspace's sources sent with the API's upsert operations, keeping
// Digipost's ids, diffed against what the API already holds, and never creating a money account
// or movement the API would give a second id.
import { describe, expect, it } from "vitest";

import type { AccountRow, ContactRow, LedgerDocumentRow, LedgerSettlementLineRow, Repositories, SettlementLineRow, TransactionRow } from "@/persistence/repositories/contracts";
import { pushLedgerSources, type LedgerApiCall } from "@/persistence/use-cases/ledger-api-source-push";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";

const WS = "11111111-1111-4111-8111-111111111111";
const BANK = "a0000000-0000-4000-8000-000000000001";
const NEW_BANK = "a0000000-0000-4000-8000-000000000002";
const STRIPE = "a0000000-0000-4000-8000-000000000003";
const CONTACT = "c0000000-0000-4000-8000-000000000001";
const DOC = "d0000000-0000-4000-8000-000000000001";
const REPORT = "d0000000-0000-4000-8000-000000000002";
const PROCESSING = "d0000000-0000-4000-8000-000000000003";
const TX_KNOWN = "e0000000-0000-4000-8000-000000000001";
const TX_PAIRED = "e0000000-0000-4000-8000-000000000002";
const TX_NEW = "e0000000-0000-4000-8000-000000000003";
const TX_RULE = "e0000000-0000-4000-8000-000000000004";
const TX_ON_NEW_BANK = "e0000000-0000-4000-8000-000000000005";
const GROUP = "f0000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-13T10:00:00Z");

function contact(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: CONTACT,
    workspaceId: WS,
    name: "Muster GmbH",
    nameNormalized: "muster",
    country: "DE",
    source: "auto",
    verifiedAt: NOW,
    verifiedByUserId: null,
    vatId: "DE123456789",
    ...overrides,
  } as ContactRow;
}

function account(id: string, overrides: Partial<AccountRow> = {}): AccountRow {
  return { id, workspaceId: WS, type: "bank", name: "Girokonto", iban: "DE02120300000000202051", bic: null, currency: "EUR", holder: null, platform: null, contactId: null, ...overrides } as AccountRow;
}

function tx(id: string, accountId: string, overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id,
    workspaceId: WS,
    accountId,
    bookingDate: "2026-10-01",
    valueDate: null,
    amountCents: -11900,
    currency: "EUR",
    creditDebit: "debit",
    counterpartyName: "Muster GmbH",
    counterpartyIban: null,
    counterpartyBic: null,
    remittanceText: "Rechnung 1",
    endToEndId: null,
    mandateId: null,
    creditorId: null,
    bankTxCode: null,
    bankReference: null,
    idempotencyKey: `key-${id}`,
    importBatchId: null,
    sourceDocumentId: null,
    transferGroupId: null,
    noDocumentNeeded: false,
    ...overrides,
  } as TransactionRow;
}

function doc(id: string, overrides: Partial<LedgerDocumentRow> = {}): LedgerDocumentRow {
  return {
    id,
    kind: "incoming_invoice",
    direction: "incoming",
    status: "done",
    documentDate: "2026-09-28",
    effectiveDate: "2026-09-28",
    title: "Rechnung",
    sender: "Muster GmbH",
    summary: "Bürobedarf",
    originalFileName: "rechnung.pdf",
    invoiceNumber: "R-1",
    totalAmountCents: 11900,
    currency: "EUR",
    platform: null,
    paymentStatus: "paid",
    contactId: CONTACT,
    contactName: "Muster GmbH",
    contactVatId: null,
    contactCountry: "DE",
    confirmedTransactions: [],
    taxBreakdown: [{ ratePercent: 19, netCents: 10000, taxCents: 1900 }],
    netTotalCents: 10000,
    taxTotalCents: 1900,
    passThroughCents: null,
    reverseCharge: false,
    serviceDate: null,
    servicePeriodFrom: null,
    servicePeriodTo: null,
    taxCheck: null,
    ...overrides,
  } as LedgerDocumentRow;
}

const settlementLine = { id: "50000000-0000-4000-8000-000000000001", workspaceId: WS, clearingAccountId: STRIPE, sourceDocumentId: REPORT, transactionId: TX_NEW, type: "payout", externalLineId: "po_1", grossCents: null, feeCents: null, netCents: -5000, currency: "EUR", bookingDate: "2026-10-02", payoutId: "po_1", chargeId: null, invoiceId: null, customerName: null, customerEmail: null, productName: null, countryOfSale: null, createdAt: NOW } as SettlementLineRow;

function repositories(): Repositories {
  const transactions = [
    tx(TX_KNOWN, BANK, { noDocumentNeeded: true }),
    tx(TX_PAIRED, BANK, { transferGroupId: GROUP, amountCents: 5000, counterpartyName: "Stripe" }),
    tx(TX_NEW, BANK),
    tx(TX_RULE, BANK, { counterpartyName: "Finanzamt Musterstadt" }),
    tx(TX_ON_NEW_BANK, NEW_BANK),
  ];
  return withUnusedRepositories({
    contact: { listAllForWorkspace: async () => [contact(), contact({ id: "c0000000-0000-4000-8000-000000000002", name: "  ", vatId: null })] } as never,
    paymentAlias: { listForWorkspace: async () => [{ counterpartyNameNormalized: "paypal muster", contactId: CONTACT }] } as never,
    paymentNoDocumentRule: { listForWorkspace: async () => [{ counterpartyNameNormalized: "finanzamt musterstadt" }] } as never,
    account: { listForWorkspace: async () => [account(BANK, { name: "Girokonto neu" }), account(NEW_BANK), account(STRIPE, { type: "clearing", platform: "stripe", iban: null })] } as never,
    transaction: {
      list: async (_ws: string, accountId: string, filter: { page: number }) => ({ items: filter.page === 1 ? transactions.filter((row) => row.accountId === accountId) : [], hasMore: false }),
    } as never,
    document: {
      listForLedger: async () => [
        doc(DOC, { confirmedTransactions: [{ transactionId: TX_KNOWN, allocatedAmountCents: 11900 }, { transactionId: TX_NEW, allocatedAmountCents: 100 }] }),
        doc(PROCESSING, { status: "processing", contactId: null }),
        doc(REPORT, { kind: "platform_settlement", direction: "incoming", platform: "stripe", contactId: null }),
      ],
    } as never,
    settlementLine: {
      listForLedger: async () => [{ id: settlementLine.id, sourceDocumentId: REPORT } as LedgerSettlementLineRow],
      listForDocument: async () => [settlementLine],
    } as never,
  });
}

function fakeApi() {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const answers: Record<string, (input: Record<string, unknown>) => Record<string, unknown>> = {
    list_counterparties: () => ({ items: [{ id: CONTACT, verifiedAt: "2026-01-01T00:00:00.000Z" }], hasMore: false }),
    list_money_accounts: () => ({
      accounts: [
        { id: BANK, name: "Girokonto", iban: "DE02120300000000202051", bic: null, currency: "EUR", holder: null },
        { id: STRIPE, name: "Girokonto", iban: null, bic: null, currency: "EUR", holder: null },
      ],
    }),
    list_money_movements: (input) => ({
      items:
        input.accountId === BANK
          ? [
              { id: TX_KNOWN, accountId: BANK, transferGroupId: null, sourceDocumentId: null, noDocumentNeeded: false },
              { id: TX_PAIRED, accountId: BANK, transferGroupId: null, sourceDocumentId: null, noDocumentNeeded: false },
              { id: TX_RULE, accountId: BANK, transferGroupId: null, sourceDocumentId: null, noDocumentNeeded: false },
            ]
          : [],
      hasMore: false,
    }),
    list_documents: () => ({ items: [{ id: DOC, links: [{ transactionId: TX_PAIRED, allocatedAmountCents: 5000 }] }], hasMore: false }),
    set_no_document_needed: (input) => (input.forCounterparty ? { updated: 1, rule: "finanzamt musterstadt", alsoMarked: [TX_RULE] } : { updated: 1, rule: null, alsoMarked: [] }),
  };
  const call: LedgerApiCall = async <T,>(operation: string, input: Record<string, unknown>) => {
    calls.push({ operation, input });
    return (answers[operation]?.(input) ?? {}) as T;
  };
  return { call, calls, of: (operation: string) => calls.filter((entry) => entry.operation === operation).map((entry) => entry.input) };
}

describe("pushLedgerSources", () => {
  it("pushes every source with Digipost's ids, creating accounts and movements the API does not hold yet", async () => {
    const api = fakeApi();
    const result = await pushLedgerSources({ repos: repositories(), call: api.call, appUrl: "https://app.example.test/" }, WS);

    // Counterparties: the one with a name, its verification unchanged (not re-stamped).
    const [counterparties] = api.of("upsert_counterparties");
    expect(counterparties!.counterparties).toEqual([expect.objectContaining({ id: CONTACT, name: "Muster GmbH", vatId: "DE123456789", country: "DE", source: "auto" })]);
    expect((counterparties!.counterparties as Record<string, unknown>[])[0]).not.toHaveProperty("verified");

    expect(api.of("upsert_payment_aliases")).toEqual([{ aliases: [{ counterpartyName: "paypal muster", counterpartyId: CONTACT }] }]);

    // Accounts: the renamed one updated, the one created after the copy created with its id.
    expect(api.of("update_money_account")).toEqual([{ id: BANK, name: "Girokonto neu", iban: "DE02120300000000202051", bic: null, currency: "EUR", holder: null }]);
    expect(api.of("create_money_account")).toEqual([expect.objectContaining({ id: NEW_BANK, type: "bank" })]);
    expect(result.moneyAccounts).toEqual({ created: 1, updated: 1 });

    // Movements: the new ones created with their ids, the newly paired one refreshed.
    expect(api.of("upsert_money_movements")).toEqual([
      { accountId: BANK, movements: [expect.objectContaining({ id: TX_NEW, externalId: `key-${TX_NEW}` }), expect.objectContaining({ id: TX_PAIRED, transferGroupId: GROUP, amountCents: 5000 })] },
      { accountId: NEW_BANK, movements: [expect.objectContaining({ id: TX_ON_NEW_BANK })] },
    ]);
    expect(result.movements).toEqual({ created: 2, refreshed: 1 });

    // Settlement lines: on the known clearing account, with the movement it pays out.
    expect(api.of("upsert_settlement_lines")).toEqual([{ lines: [expect.objectContaining({ id: settlementLine.id, clearingAccountId: STRIPE, sourceDocumentId: REPORT, transactionId: TX_NEW, type: "payout", externalLineId: "po_1", netCents: -5000 })] }]);

    // Documents: only analyzed ones, with their accounting view and a link back to Digipost.
    const [documents] = api.of("upsert_documents");
    const sent = documents!.documents as Record<string, unknown>[];
    expect(sent.map((entry) => entry.id)).toEqual([DOC, REPORT]);
    expect(sent[0]).toMatchObject({ kind: "incoming_invoice", direction: "incoming", invoiceNumber: "R-1", totalAmountCents: 11900, taxBreakdown: [{ ratePercent: 19, netCents: 10000, taxCents: 1900 }], counterpartyId: CONTACT, fileUrl: `https://app.example.test/dashboard/documents/${DOC}` });

    // Links: the stale one removed first, then both confirmed ones linked.
    expect(api.of("unlink_movement_document")).toEqual([{ documentId: DOC, movementId: TX_PAIRED }]);
    expect(api.of("link_movement_documents")).toEqual([
      {
        links: [
          { documentId: DOC, movementId: TX_KNOWN, allocatedAmountCents: 11900, matchedBy: "user" },
          { documentId: DOC, movementId: TX_NEW, allocatedAmountCents: 100, matchedBy: "user" },
        ],
      },
    ]);
    const order = api.calls.map((entry) => entry.operation);
    expect(order.indexOf("unlink_movement_document")).toBeLessThan(order.indexOf("link_movement_documents"));

    // No document needed: the rule through a movement of its name, then each mark as in Digipost.
    expect(api.of("set_no_document_needed")).toEqual([
      { movementIds: [TX_RULE], noDocumentNeeded: true, forCounterparty: true },
      { movementIds: [TX_KNOWN], noDocumentNeeded: true },
      { movementIds: [TX_RULE], noDocumentNeeded: false },
    ]);
    expect(result).toMatchObject({ counterparties: 1, paymentAliases: 1, documents: 2, settlementLines: { pushed: 1, skipped: 0 }, links: { linked: 2, unlinked: 1, failed: 0 }, noDocument: { rules: 1, marked: 1, cleared: 1 } });
  });

  it("sends a changed verification, and retries a refused link batch one by one", async () => {
    const api = fakeApi();
    const repos = repositories();
    const unverified = withUnusedRepositories({ ...repos, contact: { listAllForWorkspace: async () => [contact({ verifiedAt: null })] } as never });
    let attempts = 0;
    const call: LedgerApiCall = async <T,>(operation: string, input: Record<string, unknown>) => {
      if (operation === "link_movement_documents" && attempts++ === 0) throw new Error("allocation_exceeds_document");
      return api.call<T>(operation, input);
    };
    const result = await pushLedgerSources({ repos: unverified, call }, WS);
    expect((api.of("upsert_counterparties")[0]!.counterparties as Record<string, unknown>[])[0]).toMatchObject({ verified: false });
    expect(result.links).toMatchObject({ linked: 2, failed: 0 });
    expect(attempts).toBe(3);
  });
});
