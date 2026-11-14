// The API-backed `LedgerUseCases` (decisions/0081-ledger-via-api.md, stage A) against a fake
// `LedgerApiClient`: every method calls the right operation with the right input, tenant and
// actor and hands the answer back; API codes become the same `UseCaseError`s; and the router
// keeps every workspace on the in-process ledger unless it is switched.
import { describe, expect, it, vi } from "vitest";

import { LedgerApiError, type LedgerApiCallOptions, type LedgerApiClient } from "@/platform/ledger-api";
import { JOB_KINDS } from "@/platform/jobs";
import type { Repositories } from "@/persistence/repositories/contracts";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { createApiLedgerUseCases, LEDGER_API_SYSTEM_ACTOR } from "@/persistence/use-cases/ledger-api-use-cases";
import { createLedgerRouter } from "@/persistence/use-cases/ledger-router";
import { DEFAULT_LEDGER_SETTINGS, type LedgerUseCases } from "@/persistence/use-cases/ledger-use-cases";
import { createFakeJobsRepository } from "@/persistence/tests/support/fake-jobs-repository";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ENTRY = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-13T10:00:00Z");
const TODAY = "2026-11-13";
const SETTINGS = { enabled: true, vatPeriod: "quarter", vatBasis: "soll", startDate: null, chart: "skr04" } as const;

type Call = { operation: string; input: Record<string, unknown>; options: LedgerApiCallOptions };
type Answer = Record<string, unknown> | LedgerApiError;

function apiError(code: string, status = 422) {
  return new LedgerApiError(code, { operation: "x", status, retryable: false });
}

function fakeClient(answers: Record<string, Answer | ((input: Record<string, unknown>) => Answer)>) {
  const calls: Call[] = [];
  const client: LedgerApiClient = {
    async call<T>(operation: string, input: Record<string, unknown>, options: LedgerApiCallOptions = {}): Promise<T> {
      calls.push({ operation, input, options });
      const entry = answers[operation];
      if (entry === undefined) throw new Error(`unexpected operation ${operation}`);
      const answer = typeof entry === "function" ? entry(input) : entry;
      if (answer instanceof LedgerApiError) throw answer;
      return answer as T;
    },
  };
  return { client, calls };
}

function setup(answers: Parameters<typeof fakeClient>[0], repos: Partial<Repositories> = {}) {
  const { client, calls } = fakeClient(answers);
  const jobs = createFakeJobsRepository();
  const ledger = createApiLedgerUseCases({ repos: withUnusedRepositories({ jobs: jobs.repo, ...repos }), client, now: () => NOW, appUrl: "https://app.example.test" });
  return { ledger, calls, jobs: jobs.state };
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("createApiLedgerUseCases: one operation per method", () => {
  const filing = { id: "f-1", kind: "vat_return", status: "draft", periodFrom: "2026-01-01", periodTo: "2026-03-31", submittedOn: null, amountCents: null, correctsFilingId: null, note: null, createdAt: "2026-11-13T10:00:00.000Z" };
  const cases: { name: string; run: (ledger: LedgerUseCases) => Promise<unknown>; operation: string; input: Record<string, unknown>; answer: Record<string, unknown>; result: unknown; actor?: string }[] = [
    { name: "listAccounts", run: (l) => l.listAccounts(WS), operation: "list_accounts", input: { includeArchived: true }, answer: { accounts: [{ id: "a" }] }, result: [{ id: "a" }] },
    { name: "syncChart", run: (l) => l.syncChart(WS), operation: "list_accounts", input: { includeArchived: true }, answer: { accounts: [] }, result: [] },
    {
      name: "createAccount",
      run: (l) => l.createAccount({ workspaceId: WS, account: { number: "6805", name: "Telefon", kind: "expense", group: null, openItems: false, description: null } as never }),
      operation: "create_account",
      input: { number: "6805", name: "Telefon" },
      answer: { account: { id: "a" } },
      result: { id: "a" },
    },
    { name: "updateAccount", run: (l) => l.updateAccount({ workspaceId: WS, account: { id: "a", name: "Neu" } as never }), operation: "update_account", input: { id: "a", name: "Neu" }, answer: { account: { id: "a" } }, result: { id: "a" } },
    { name: "setAccountArchived", run: (l) => l.setAccountArchived({ workspaceId: WS, accountId: "a", archived: true }), operation: "set_account_archived", input: { accountId: "a", archived: true }, answer: { account: { id: "a" } }, result: { id: "a" } },
    { name: "getEntry", run: (l) => l.getEntry(WS, ENTRY), operation: "get_entry", input: { entryId: ENTRY }, answer: { entry: { id: ENTRY } }, result: { id: ENTRY } },
    { name: "countWaitingProposals", run: (l) => l.countWaitingProposals(WS), operation: "get_overview", input: { from: TODAY, to: TODAY }, answer: { waitingProposals: 7 }, result: 7 },
    {
      name: "createEntry",
      run: (l) => l.createEntry({ workspaceId: WS, userId: USER, entry: { bookingDate: TODAY, text: "x", lines: [] } as never, book: true }),
      operation: "create_entry",
      input: { entry: { bookingDate: TODAY, text: "x", lines: [] }, book: true },
      answer: { entryId: ENTRY },
      result: { entryId: ENTRY },
      actor: USER,
    },
    {
      name: "updateEntry",
      run: (l) => l.updateEntry({ workspaceId: WS, userId: USER, entryId: ENTRY, entry: { text: "y" } as never, reason: "Tippfehler", expectedRevision: 3 }),
      operation: "update_entry",
      input: { entryId: ENTRY, entry: { text: "y" }, reason: "Tippfehler", expectedRevision: 3 },
      answer: { entryId: ENTRY, revision: 4 },
      result: { entryId: ENTRY, revision: 4 },
      actor: USER,
    },
    { name: "deleteEntry", run: (l) => l.deleteEntry({ workspaceId: WS, userId: USER, entryId: ENTRY, reason: "doppelt" }), operation: "delete_entry", input: { entryId: ENTRY, reason: "doppelt" }, answer: { deleted: true }, result: undefined, actor: USER },
    { name: "bookEntry", run: (l) => l.bookEntry({ workspaceId: WS, userId: USER, entryId: ENTRY }), operation: "book_entries", input: { entryIds: [ENTRY] }, answer: { booked: [ENTRY], failed: [] }, result: undefined, actor: USER },
    { name: "unbookEntry", run: (l) => l.unbookEntry({ workspaceId: WS, userId: USER, entryId: ENTRY, reason: "falsch" }), operation: "unbook_entry", input: { entryId: ENTRY, reason: "falsch" }, answer: { unbooked: true }, result: undefined, actor: USER },
    {
      name: "bulkBook",
      run: (l) => l.bulkBook({ workspaceId: WS, userId: USER, entryIds: [ENTRY, "e-2"] }),
      operation: "book_entries",
      input: { entryIds: [ENTRY, "e-2"] },
      answer: { booked: [ENTRY], failed: [{ entryId: "e-2", errorCode: "locked" }] },
      result: { booked: [ENTRY], failed: [{ entryId: "e-2", errorCode: "locked" }] },
      actor: USER,
    },
    { name: "dismissProposal", run: (l) => l.dismissProposal({ workspaceId: WS, userId: USER, entryId: ENTRY }), operation: "dismiss_proposal", input: { entryId: ENTRY }, answer: { dismissed: true }, result: undefined, actor: USER },
    { name: "restoreProposal", run: (l) => l.restoreProposal({ workspaceId: WS, userId: USER, entryId: ENTRY }), operation: "restore_proposal", input: { entryId: ENTRY }, answer: { restored: true }, result: undefined, actor: USER },
    { name: "getBalances", run: (l) => l.getBalances(WS, { from: "2026-01-01", to: TODAY }), operation: "get_balances", input: { from: "2026-01-01", to: TODAY }, answer: { balances: { rows: [] } }, result: { rows: [] } },
    {
      name: "getAccountSheet",
      run: (l) => l.getAccountSheet(WS, { accountNumber: "1800", from: "2026-01-01", to: TODAY, countProposals: true }),
      operation: "get_account_sheet",
      input: { accountNumber: "1800", from: "2026-01-01", to: TODAY, includeProposals: true },
      answer: { sheet: { lines: [] } },
      result: { lines: [] },
    },
    { name: "getBankComparisons", run: (l) => l.getBankComparisons(WS, { from: "2026-01-01", to: TODAY }), operation: "get_overview", input: { from: "2026-01-01", to: TODAY }, answer: { bankComparisons: [{ accountNumber: "1800" }] }, result: [{ accountNumber: "1800" }] },
    { name: "getOpenItems", run: (l) => l.getOpenItems(WS, { accountNumber: "3300", asOf: TODAY }), operation: "get_open_items", input: { accountNumber: "3300", asOf: TODAY }, answer: { openItems: { open: [] }, suggestions: [] }, result: { open: [] } },
    { name: "listOpenItemAccounts", run: (l) => l.listOpenItemAccounts(WS, TODAY), operation: "get_overview", input: { to: TODAY }, answer: { openItemAccounts: [{ number: "3300" }] }, result: [{ number: "3300" }] },
    { name: "getVatPreview", run: (l) => l.getVatPreview(WS, { from: "2026-07-01", to: "2026-09-30" }), operation: "get_vat_preview", input: { from: "2026-07-01", to: "2026-09-30" }, answer: { preview: { payableCents: 1 } }, result: { payableCents: 1 } },
    { name: "getControls", run: (l) => l.getControls(WS, { from: "2026-01-01", to: TODAY }), operation: "get_overview", input: { from: "2026-01-01", to: TODAY }, answer: { controls: [{ key: "bank" }] }, result: [{ key: "bank" }] },
    { name: "getPeriodOverview", run: (l) => l.getPeriodOverview(WS, 2026), operation: "list_periods", input: { year: 2026 }, answer: { periods: [{ key: "2026-Q1" }], filings: [], handovers: [] }, result: [{ key: "2026-Q1" }] },
    {
      name: "createMatch",
      run: (l) => l.createMatch({ workspaceId: WS, userId: USER, match: { accountNumber: "3300", kind: "match", lineIds: ["l-1", "l-2"], note: null } }),
      operation: "create_open_item_match",
      input: { accountNumber: "3300", kind: "match", lineIds: ["l-1", "l-2"] },
      answer: { matchId: "m-1" },
      result: { matchId: "m-1" },
      actor: USER,
    },
    { name: "deleteMatch", run: (l) => l.deleteMatch({ workspaceId: WS, matchId: "m-1" }), operation: "delete_open_item_match", input: { matchId: "m-1" }, answer: { deleted: true }, result: undefined },
    { name: "listRules", run: (l) => l.listRules(WS), operation: "list_rules", input: {}, answer: { rules: [{ id: "r" }] }, result: [{ id: "r" }] },
    { name: "createRule", run: (l) => l.createRule({ workspaceId: WS, rule: { direction: "incoming" } as never }), operation: "create_rule", input: { rule: { direction: "incoming" } }, answer: { rule: { id: "r" } }, result: { id: "r" } },
    { name: "updateRule", run: (l) => l.updateRule({ workspaceId: WS, ruleId: "r", rule: { direction: "any" } as never }), operation: "update_rule", input: { ruleId: "r", rule: { direction: "any" } }, answer: { rule: { id: "r" } }, result: { id: "r" } },
    { name: "deleteRule", run: (l) => l.deleteRule({ workspaceId: WS, ruleId: "r" }), operation: "delete_rule", input: { ruleId: "r" }, answer: { deleted: true }, result: undefined },
    { name: "listFilings", run: (l) => l.listFilings(WS), operation: "list_periods", input: {}, answer: { periods: [], filings: [filing], handovers: [] }, result: [filing] },
    {
      name: "submitFiling",
      run: (l) => l.submitFiling({ workspaceId: WS, filingId: "f-1", submittedOn: TODAY, amountCents: 1200 }),
      operation: "submit_filing",
      input: { filingId: "f-1", submittedOn: TODAY, amountCents: 1200 },
      answer: { filing },
      result: filing,
    },
    { name: "createCorrectionFiling", run: (l) => l.createCorrectionFiling({ workspaceId: WS, userId: USER, filingId: "f-1" }), operation: "create_correction_filing", input: { filingId: "f-1" }, answer: { filing }, result: filing, actor: USER },
    {
      name: "createHandover",
      run: (l) => l.createHandover({ workspaceId: WS, userId: USER, periodFrom: "2026-01-01", periodTo: "2026-03-31", note: null }),
      operation: "create_handover",
      input: { periodFrom: "2026-01-01", periodTo: "2026-03-31", note: null },
      answer: { handover: { id: "h" } },
      result: { id: "h" },
      actor: USER,
    },
    { name: "listHandovers", run: (l) => l.listHandovers(WS), operation: "list_periods", input: {}, answer: { periods: [], filings: [], handovers: [{ id: "h" }] }, result: [{ id: "h" }] },
    {
      name: "uploadAdvisorBalances",
      run: (l) => l.uploadAdvisorBalances({ workspaceId: WS, userId: USER, periodFrom: "2026-01-01", periodTo: "2026-03-31", fileName: "susa.csv", csvText: "a;b" }),
      operation: "import_advisor_balances",
      input: { periodFrom: "2026-01-01", periodTo: "2026-03-31", fileName: "susa.csv", csvText: "a;b" },
      answer: { upload: { id: "u" } },
      result: { id: "u" },
      actor: USER,
    },
    { name: "listAdvisorUploads", run: (l) => l.listAdvisorUploads(WS), operation: "get_advisor_comparison", input: {}, answer: { uploads: [{ id: "u" }] }, result: [{ id: "u" }] },
    {
      name: "getAdvisorComparison",
      run: (l) => l.getAdvisorComparison(WS, "u"),
      operation: "get_advisor_comparison",
      input: { uploadId: "u" },
      answer: { uploads: [], comparison: { upload: { id: "u" }, comparison: { rows: [] } } },
      result: { upload: { id: "u" }, comparison: { rows: [] } },
    },
    { name: "deleteAdvisorUpload", run: (l) => l.deleteAdvisorUpload({ workspaceId: WS, uploadId: "u" }), operation: "delete_advisor_balances", input: { uploadId: "u" }, answer: { deleted: true }, result: undefined },
    { name: "learnRuleFromEntry", run: (l) => l.learnRuleFromEntry({ workspaceId: WS, entryId: ENTRY }), operation: "learn_rule_from_entry", input: { entryId: ENTRY }, answer: { rule: { id: "r" } }, result: { id: "r" } },
  ];

  it.each(cases)("$name calls $operation", async ({ run, operation, input, answer, result, actor }) => {
    const { ledger, calls } = setup({ [operation]: answer });
    expect(await run(ledger)).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.operation).toBe(operation);
    expect(calls[0]!.input).toMatchObject(input);
    expect(calls[0]!.options).toMatchObject({ tenantId: WS, actor: actor ?? LEDGER_API_SYSTEM_ACTOR });
  });

  it("getSettings and isEnabled read the overview once per instance", async () => {
    const { ledger, calls } = setup({ get_overview: { settings: SETTINGS } });
    expect(await ledger.getSettings(WS)).toEqual(SETTINGS);
    expect(await ledger.isEnabled(WS)).toBe(true);
    expect(calls.map((call) => call.operation)).toEqual(["get_overview"]);
  });

  it("setSettings changes the VAT settings through update_tenant, a platform operation", async () => {
    const { ledger, calls } = setup({ update_tenant: { tenant: { id: WS }, settings: { ...SETTINGS, vatPeriod: "month" } } });
    const saved = await ledger.setSettings({ workspaceId: WS, settings: { enabled: true, vatPeriod: "month", vatBasis: "soll", startDate: null } });
    expect(saved.vatPeriod).toBe("month");
    expect(calls[0]).toMatchObject({ operation: "update_tenant", input: { id: WS, vatPeriod: "month", vatBasis: "soll", startDate: null }, options: { tenantId: null } });
  });

  it("getAccountSheets reads one sheet per number and leaves unknown numbers out", async () => {
    const { ledger, calls } = setup({ get_account_sheet: (input) => (input.accountNumber === "9999" ? apiError("not_found", 404) : { sheet: { number: input.accountNumber } }) });
    const sheets = await ledger.getAccountSheets(WS, { accountNumbers: ["3300", "9999", "1800", "3300"], from: "2026-01-01", to: TODAY });
    expect(sheets).toEqual([{ number: "1800" }, { number: "3300" }]);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.input.includeProposals === false)).toBe(true);
  });

  it("listEntries pages through list_entries up to the filter's limit", async () => {
    const page = (offset: number) => Array.from({ length: 200 }, (_, i) => ({ id: `e-${offset + i}`, updatedAt: "2026-11-01T00:00:00.000Z" }));
    const { ledger, calls } = setup({ list_entries: (input) => ({ items: page(Number(input.offset)), hasMore: true }) });
    const entries = await ledger.listEntries(WS, { status: "proposed", limit: 250 });
    expect(entries).toHaveLength(250);
    expect(calls.map((call) => call.input)).toEqual([
      { status: "proposed", dismissed: "exclude", offset: 0, limit: 200 },
      { status: "proposed", dismissed: "exclude", offset: 200, limit: 200 },
    ]);
  });

  it("listEntries filters changedSince by the entries' last change", async () => {
    const items = [
      { id: "old", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "new", updatedAt: "2026-11-02T00:00:00.000Z" },
    ];
    const { ledger, calls } = setup({ list_entries: { items, hasMore: false } });
    const entries = await ledger.listEntries(WS, { changedSince: "2026-11-01T00:00:00Z" });
    expect(entries.map((entry) => entry.id)).toEqual(["new"]);
    expect(calls[0]!.input).not.toHaveProperty("changedSince");
  });

  it("createFiling of an already submitted filing creates the draft and then submits it", async () => {
    const { ledger, calls } = setup({ create_filing: { filing: { id: "f-1", status: "draft" } }, submit_filing: { filing: { id: "f-1", status: "submitted" } } });
    const created = await ledger.createFiling({ workspaceId: WS, userId: USER, filing: { kind: "vat_return", periodFrom: "2026-01-01", periodTo: "2026-03-31", status: "submitted", submittedOn: "2026-04-10", amountCents: 500, note: null } });
    expect(created).toEqual({ id: "f-1", status: "submitted" });
    expect(calls.map((call) => call.operation)).toEqual(["create_filing", "submit_filing"]);
    expect(calls[0]!.input).not.toHaveProperty("status");
    expect(calls[1]!.input).toEqual({ filingId: "f-1", submittedOn: "2026-04-10", amountCents: 500 });
  });

  it("suggestMatches finds the account's number and returns get_open_items' suggestions", async () => {
    const { ledger, calls } = setup({ list_accounts: { accounts: [{ id: "acc", number: "3300", openItems: true }] }, get_open_items: { openItems: {}, suggestions: [{ lineIds: ["a", "b"] }] } });
    expect(await ledger.suggestMatches(WS, "acc")).toEqual([{ lineIds: ["a", "b"] }]);
    expect(calls[1]!.input).toEqual({ accountNumber: "3300", asOf: TODAY });
    expect(await rejection(ledger.suggestMatches(WS, "missing"))).toEqual(new UseCaseError("account_not_found"));
  });

  it("getSources stays local: Digipost's own documents and transactions", async () => {
    const listForLedger = vi.fn(async () => []);
    const { ledger, calls } = setup({}, { document: { listForLedger } as never, transaction: { listForLedger: async () => [] } as never, account: { listForWorkspace: async () => [] } as never });
    expect(await ledger.getSources(WS, { documentIds: ["d"], transactionIds: ["t"] })).toEqual({ documents: [], transactions: [] });
    expect(listForLedger).toHaveBeenCalledWith(WS);
    expect(calls).toEqual([]);
  });

  it("autoMatchOpenItems is a no-op and the proposal engine's internals have no operation", async () => {
    const { ledger, calls } = setup({});
    expect(await ledger.autoMatchOpenItems(WS)).toBe(0);
    await expect(ledger.upsertProposal({ workspaceId: WS, proposal: {} as never })).rejects.toThrow(/no API operation/);
    await expect(ledger.listSourceKeys(WS)).rejects.toThrow(/no API operation/);
    expect(calls).toEqual([]);
  });
});

describe("createApiLedgerUseCases: errors", () => {
  it("turns a ledger code of the API into the same UseCaseError", async () => {
    const { ledger } = setup({ update_entry: apiError("locked") });
    expect(await rejection(ledger.updateEntry({ workspaceId: WS, userId: USER, entryId: ENTRY, entry: {} as never }))).toEqual(new UseCaseError("locked"));
  });

  it("bookEntry throws the failed entry's code", async () => {
    const { ledger } = setup({ book_entries: { booked: [], failed: [{ entryId: ENTRY, errorCode: "unbalanced" }] } });
    expect(await rejection(ledger.bookEntry({ workspaceId: WS, userId: USER, entryId: ENTRY }))).toEqual(new UseCaseError("unbalanced"));
  });

  it("reads a tenant the API does not know as a disabled ledger", async () => {
    const { ledger } = setup({ get_overview: apiError("tenant_not_found", 404), list_rules: apiError("tenant_not_found", 404) });
    expect(await ledger.getSettings(WS)).toEqual(DEFAULT_LEDGER_SETTINGS);
    expect(await ledger.isEnabled(WS)).toBe(false);
    expect(await rejection(ledger.listRules(WS))).toEqual(new UseCaseError("disabled"));
  });

  it("answers null for a not_found read", async () => {
    const { ledger } = setup({ get_entry: apiError("not_found", 404), get_advisor_comparison: apiError("not_found", 404), get_open_items: apiError("not_found", 404) });
    expect(await ledger.getEntry(WS, ENTRY)).toBeNull();
    expect(await ledger.getAdvisorComparison(WS, "u")).toBeNull();
    expect(await ledger.getOpenItems(WS, { accountNumber: "9999", asOf: TODAY })).toBeNull();
  });

  it("rethrows what is not a ledger code (the action answers unknown)", async () => {
    const unauthenticated = apiError("unauthenticated", 401);
    const { ledger } = setup({ list_rules: unauthenticated });
    expect(await rejection(ledger.listRules(WS))).toBe(unauthenticated);
  });
});

describe("createApiLedgerUseCases: the proposal sync", () => {
  it("scheduleSync queues Digipost's own ledger-sync job while the API's books are on", async () => {
    const { ledger, jobs } = setup({ get_overview: { settings: SETTINGS } });
    expect(await ledger.scheduleSync(WS)).toBe(true);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: JOB_KINDS.ledgerSync, workspaceId: WS, payload: { workspaceId: WS } });
  });

  it("syncProposals pushes the sources first and then asks the API for proposals", async () => {
    const empty = async () => [];
    const repos: Partial<Repositories> = {
      contact: { listAllForWorkspace: empty } as never,
      paymentAlias: { listForWorkspace: empty } as never,
      paymentNoDocumentRule: { listForWorkspace: empty } as never,
      account: { listForWorkspace: empty } as never,
      document: { listForLedger: empty } as never,
      settlementLine: { listForLedger: empty } as never,
    };
    const result = { created: 2, updated: 0, kept: 1, failed: 0, unproposed: 0, problems: [], deferred: 0, aiAsked: 0, aiCached: 0, aiUnavailable: 0, autoMatched: 1 };
    const { ledger, calls } = setup(
      {
        list_counterparties: { items: [], hasMore: false },
        list_money_accounts: { accounts: [] },
        list_documents: { items: [], hasMore: false },
        sync_proposals: result,
      },
      repos,
    );
    expect(await ledger.syncProposals({ workspaceId: WS, from: "2026-01-01" })).toEqual(result);
    expect(calls.map((call) => call.operation)).toEqual(["list_counterparties", "list_money_accounts", "list_documents", "sync_proposals"]);
    expect(calls.at(-1)).toMatchObject({ input: { from: "2026-01-01" }, options: { tenantId: WS, actor: LEDGER_API_SYSTEM_ACTOR } });
    expect(calls.at(-1)!.options.timeoutMs).toBeGreaterThan(60_000);
  });
});

describe("createLedgerRouter", () => {
  function implementation(name: string) {
    return new Proxy({} as LedgerUseCases, { get: (_target, method) => vi.fn(async () => `${name}:${String(method)}`) });
  }

  it("keeps every workspace on the in-process ledger and never builds the API one while none is switched", async () => {
    const api = vi.fn(() => implementation("api"));
    const router = createLedgerRouter({ local: implementation("local"), api, usesApi: () => false });
    expect(await router.listRules(WS)).toBe("local:listRules");
    expect(await router.syncProposals({ workspaceId: WS })).toBe("local:syncProposals");
    expect(api).not.toHaveBeenCalled();
  });

  it("routes a switched workspace to the API, by id or by input.workspaceId, building it once", async () => {
    const other = "44444444-4444-4444-8444-444444444444";
    const api = vi.fn(() => implementation("api"));
    const router = createLedgerRouter({ local: implementation("local"), api, usesApi: (workspaceId) => workspaceId === WS });
    expect(await router.getBalances(WS, { from: "2026-01-01", to: TODAY })).toBe("api:getBalances");
    expect(await router.bookEntry({ workspaceId: WS, userId: USER, entryId: ENTRY })).toBe("api:bookEntry");
    expect(await router.bookEntry({ workspaceId: other, userId: USER, entryId: ENTRY })).toBe("local:bookEntry");
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("passes the arguments through unchanged", async () => {
    const local = { getAccountSheet: vi.fn(async () => null) } as unknown as LedgerUseCases;
    const router = createLedgerRouter({ local, api: () => local, usesApi: () => false });
    await router.getAccountSheet(WS, { accountNumber: "1800", from: "2026-01-01", to: TODAY });
    expect(local.getAccountSheet).toHaveBeenCalledWith(WS, { accountNumber: "1800", from: "2026-01-01", to: TODAY });
  });
});
