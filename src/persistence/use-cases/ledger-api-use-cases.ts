// Owner: src/modules/ledger (decisions/0081-ledger-via-api.md, stage A). `LedgerUseCases` on the
// external ledger API instead of in-process, for a workspace listed in `LEDGER_API_WORKSPACES`
// (the composition root routes per workspace, `ledger-router.ts`). The API's bookkeeping use
// cases are this module's own moved over (same views, same error codes, `workspaceId` renamed
// `tenantId`), so every method maps to one or a few operations and hands their `data` back
// unchanged: Server Actions, read models, MCP tools and the UI keep working as they are.
//
// - The tenant is the workspace (`Ledger-Tenant` = workspace id); the acting user is the
//   `Ledger-Actor`, background work acts as `digipost:system`.
// - An API code that is a ledger use-case code (`unbalanced`, `locked`, `not_found`, ...) becomes
//   the same `UseCaseError`; `tenant_not_found` (a workspace the API does not know) reads as
//   `disabled`; anything else (unauthenticated, unavailable, a timeout) is rethrown as the
//   client's `LedgerApiError`, which the actions answer `unknown`.
// - Views carry dates as ISO strings in both implementations, so nothing needs reviving.
// - Stays in Digipost: `getSources` (Digipost owns documents and transactions) and the job that
//   runs the sync (`scheduleSync` enqueues Digipost's own `ledger-sync` job).
// - No operation exists for `upsertProposal` and `listSourceKeys` (the in-process proposal
//   engine's own write path and its test helper): they throw. `autoMatchOpenItems` is a no-op
//   (the API matches inside `sync_proposals` and after every booking), `syncChart` answers the
//   chart (the API adds the money accounts' ledger accounts at every `sync_proposals`).
import {
  isLedgerUseCaseErrorCode,
  listEntriesFilterSchema,
  type AccountSheet,
  type BalanceList,
  type BankBalanceComparison,
  type BookingRuleView,
  type ControlResult,
  type FilingView,
  type HandoverView,
  type AdvisorUploadView,
  type JournalEntryListItem,
  type JournalEntryView,
  type LedgerAccountView,
  type LedgerSettingsView,
  type MatchSuggestion,
  type OpenItemAccountSummary,
  type OpenItems,
  type Period,
  type PeriodOverviewRow,
  type SyncProposalsResult,
  type VatPreview,
} from "@/modules/ledger";
import { JOB_KINDS } from "@/platform/jobs";
import { LedgerApiError, type LedgerApiClient } from "@/platform/ledger-api";
import type { Repositories } from "@/persistence/repositories/contracts";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { pushLedgerSources, type LedgerApiCall } from "@/persistence/use-cases/ledger-api-source-push";
import { DEFAULT_LEDGER_SETTINGS, LEDGER_ERROR, readLedgerSources, type AdvisorComparisonView, type BulkBookResult, type LedgerUseCases } from "@/persistence/use-cases/ledger-use-cases";

export type ApiLedgerUseCaseDeps = {
  /** Only for what stays in Digipost: the sources (`getSources`, the push) and the job queue. */
  repos: Repositories;
  client: LedgerApiClient;
  now?: () => Date;
  /** Digipost's base URL (`APP_URL`), for the link to each document sent with its accounting view. */
  appUrl?: string | null;
};

/** `Ledger-Actor` for what no person triggered directly (the sync job, reads). */
export const LEDGER_API_SYSTEM_ACTOR = "digipost:system";
/** The API's largest batch of `book_entries`. */
const MAX_BOOK_BATCH = 500;
/** The API's largest page of `list_entries`. */
const ENTRY_PAGE = 200;
/** A sync asks the AI booking advisor and writes every proposal: allow it more than a read. */
const SYNC_TIMEOUT_MS = 280_000;

type Overview = {
  settings: LedgerSettingsView;
  controls: ControlResult[];
  bankComparisons: BankBalanceComparison[];
  openItemAccounts: OpenItemAccountSummary[];
  waitingProposals: number;
};
type Periods = { periods: PeriodOverviewRow[]; filings: FilingView[]; handovers: HandoverView[] };

export function createApiLedgerUseCases(deps: ApiLedgerUseCaseDeps): LedgerUseCases {
  const now = deps.now ?? (() => new Date());
  const today = () => now().toISOString().slice(0, 10);
  /** Per instance (one request, one job run): the settings answer several reads of a page. */
  const settingsCache = new Map<string, Promise<LedgerSettingsView>>();

  function translate(err: unknown): unknown {
    if (!(err instanceof LedgerApiError)) return err;
    if (isLedgerUseCaseErrorCode(err.code)) return new UseCaseError(err.code);
    if (err.code === "tenant_not_found") return new UseCaseError(LEDGER_ERROR.disabled);
    return err;
  }

  async function call<T>(workspaceId: string | null, operation: string, input: Record<string, unknown>, actor?: string | null, timeoutMs?: number): Promise<T> {
    try {
      return await deps.client.call<T>(operation, input, { tenantId: workspaceId, actor: actor ?? LEDGER_API_SYSTEM_ACTOR, ...(timeoutMs ? { timeoutMs } : {}) });
    } catch (err) {
      throw translate(err);
    }
  }

  /** `null` for an operation's `not_found` (an id of another workspace, or deleted). */
  async function orNull<T>(work: Promise<T>): Promise<T | null> {
    try {
      return await work;
    } catch (err) {
      if (err instanceof UseCaseError && err.code === LEDGER_ERROR.notFound) return null;
      throw err;
    }
  }

  const overview = (workspaceId: string, period: { from?: string; to?: string }) => call<Overview>(workspaceId, "get_overview", period);

  function getSettings(workspaceId: string): Promise<LedgerSettingsView> {
    const cached = settingsCache.get(workspaceId);
    if (cached) return cached;
    const loading = overview(workspaceId, { from: today(), to: today() })
      .then((answer) => answer.settings)
      .catch((err: unknown) => {
        settingsCache.delete(workspaceId);
        if (err instanceof UseCaseError && err.code === LEDGER_ERROR.disabled) return DEFAULT_LEDGER_SETTINGS;
        throw err;
      });
    settingsCache.set(workspaceId, loading);
    return loading;
  }

  async function isEnabled(workspaceId: string): Promise<boolean> {
    return (await getSettings(workspaceId)).enabled;
  }

  async function listAccounts(workspaceId: string): Promise<LedgerAccountView[]> {
    return (await call<{ accounts: LedgerAccountView[] }>(workspaceId, "list_accounts", { includeArchived: true })).accounts;
  }

  async function bulkBook(workspaceId: string, userId: string, entryIds: readonly string[]): Promise<BulkBookResult> {
    const result: BulkBookResult = { booked: [], failed: [] };
    for (let i = 0; i < entryIds.length; i += MAX_BOOK_BATCH) {
      const answer = await call<BulkBookResult>(workspaceId, "book_entries", { entryIds: entryIds.slice(i, i + MAX_BOOK_BATCH) }, userId);
      result.booked.push(...answer.booked);
      result.failed.push(...answer.failed);
    }
    return result;
  }

  function unsupported(method: string): never {
    throw new Error(`ledger via API: ${method} has no API operation (decisions/0081-ledger-via-api.md)`);
  }

  const api: LedgerUseCases = {
    // --- Settings ---------------------------------------------------------------------------------
    getSettings,
    isEnabled,

    async setSettings({ workspaceId, settings }) {
      // `update_tenant` (a platform operation, the tenant by id) changes the VAT settings. A
      // tenant's books are always on: `enabled: false` cannot be sent, a workspace leaves the API
      // by being removed from `LEDGER_API_WORKSPACES`.
      settingsCache.delete(workspaceId);
      const answer = await call<{ settings: LedgerSettingsView }>(null, "update_tenant", { id: workspaceId, vatPeriod: settings.vatPeriod, vatBasis: settings.vatBasis, startDate: settings.startDate });
      return answer.settings;
    },

    async syncChart(workspaceId) {
      return listAccounts(workspaceId);
    },

    // --- Chart of accounts ------------------------------------------------------------------------
    listAccounts,

    async createAccount({ workspaceId, account }) {
      return (await call<{ account: LedgerAccountView }>(workspaceId, "create_account", account)).account;
    },

    async updateAccount({ workspaceId, account }) {
      return (await call<{ account: LedgerAccountView }>(workspaceId, "update_account", account)).account;
    },

    async setAccountArchived({ workspaceId, accountId, archived }) {
      return (await call<{ account: LedgerAccountView }>(workspaceId, "set_account_archived", { accountId, archived })).account;
    },

    // --- Journal ----------------------------------------------------------------------------------
    async listEntries(workspaceId, filter) {
      const { changedSince, limit, ...rest } = listEntriesFilterSchema.parse(filter ?? {});
      // `list_entries` has no `changedSince`; the last change of an entry (`updatedAt`) stands in
      // for "a revision after the handover", so every page is read and filtered here.
      const wanted = changedSince ? Number.POSITIVE_INFINITY : limit;
      const items: JournalEntryListItem[] = [];
      for (let offset = 0; items.length < wanted; offset += ENTRY_PAGE) {
        const page = await call<{ items: JournalEntryListItem[]; hasMore: boolean }>(workspaceId, "list_entries", { ...rest, offset, limit: ENTRY_PAGE });
        items.push(...page.items);
        if (!page.hasMore || page.items.length === 0) break;
      }
      const since = changedSince ? Date.parse(changedSince) : null;
      return (since === null ? items : items.filter((item) => Date.parse(item.updatedAt) > since)).slice(0, limit);
    },

    async getEntry(workspaceId, entryId) {
      return (await orNull(call<{ entry: JournalEntryView }>(workspaceId, "get_entry", { entryId })))?.entry ?? null;
    },

    async countWaitingProposals(workspaceId) {
      return (await overview(workspaceId, { from: today(), to: today() })).waitingProposals;
    },

    async getSources(workspaceId, input) {
      return readLedgerSources(deps.repos, workspaceId, input);
    },

    async createEntry({ workspaceId, userId, entry, book }) {
      const answer = await call<{ entryId: string }>(workspaceId, "create_entry", { entry, book }, userId);
      return { entryId: answer.entryId };
    },

    async updateEntry({ workspaceId, userId, entryId, entry, reason, expectedRevision }) {
      const answer = await call<{ entryId: string; revision: number }>(workspaceId, "update_entry", { entryId, entry, reason: reason ?? null, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }, userId);
      return { entryId: answer.entryId, revision: answer.revision };
    },

    async deleteEntry({ workspaceId, userId, entryId, reason }) {
      await call(workspaceId, "delete_entry", { entryId, reason: reason ?? null }, userId);
    },

    async bookEntry({ workspaceId, userId, entryId }) {
      const [failure] = (await bulkBook(workspaceId, userId, [entryId])).failed;
      if (!failure) return;
      if (isLedgerUseCaseErrorCode(failure.errorCode)) throw new UseCaseError(failure.errorCode);
      throw new Error(`ledger via API: book_entries failed with ${failure.errorCode}`);
    },

    async unbookEntry({ workspaceId, userId, entryId, reason }) {
      await call(workspaceId, "unbook_entry", { entryId, reason: reason ?? null }, userId);
    },

    async bulkBook({ workspaceId, userId, entryIds }) {
      return bulkBook(workspaceId, userId, entryIds);
    },

    async dismissProposal({ workspaceId, userId, entryId }) {
      await call(workspaceId, "dismiss_proposal", { entryId }, userId);
    },

    async restoreProposal({ workspaceId, userId, entryId }) {
      await call(workspaceId, "restore_proposal", { entryId }, userId);
    },

    async upsertProposal() {
      return unsupported("upsertProposal");
    },

    async listSourceKeys() {
      return unsupported("listSourceKeys");
    },

    // --- Reports ----------------------------------------------------------------------------------
    async getBalances(workspaceId, period) {
      return (await call<{ balances: BalanceList }>(workspaceId, "get_balances", { from: period.from, to: period.to })).balances;
    },

    async getAccountSheet(workspaceId, { accountNumber, from, to, countProposals }) {
      const answer = await orNull(call<{ sheet: AccountSheet }>(workspaceId, "get_account_sheet", { accountNumber, from, to, includeProposals: countProposals ?? false }));
      return answer?.sheet ?? null;
    },

    async getAccountSheets(workspaceId, { accountNumbers, from, to }) {
      const numbers = [...new Set(accountNumbers)].sort();
      const sheets = await Promise.all(numbers.map((accountNumber) => orNull(call<{ sheet: AccountSheet }>(workspaceId, "get_account_sheet", { accountNumber, from, to, includeProposals: false }))));
      return sheets.flatMap((answer) => (answer ? [answer.sheet] : []));
    },

    async getBankComparisons(workspaceId, period) {
      return (await overview(workspaceId, period)).bankComparisons;
    },

    async getOpenItems(workspaceId, { accountNumber, asOf }) {
      const answer = await orNull(call<{ openItems: OpenItems & { account: LedgerAccountView } }>(workspaceId, "get_open_items", { accountNumber, asOf }));
      return answer?.openItems ?? null;
    },

    async listOpenItemAccounts(workspaceId, asOf) {
      return (await overview(workspaceId, { to: asOf })).openItemAccounts;
    },

    async getVatPreview(workspaceId, period: Period) {
      return (await call<{ preview: VatPreview }>(workspaceId, "get_vat_preview", { from: period.from, to: period.to })).preview;
    },

    async getControls(workspaceId, period) {
      return (await overview(workspaceId, period)).controls;
    },

    async getPeriodOverview(workspaceId, year) {
      return (await call<Periods>(workspaceId, "list_periods", { year })).periods;
    },

    // --- Open items -------------------------------------------------------------------------------
    async createMatch({ workspaceId, userId, match }) {
      const answer = await call<{ matchId: string }>(workspaceId, "create_open_item_match", match, userId);
      return { matchId: answer.matchId };
    },

    async deleteMatch({ workspaceId, matchId }) {
      await call(workspaceId, "delete_open_item_match", { matchId });
    },

    // --- Booking rules ----------------------------------------------------------------------------
    async listRules(workspaceId) {
      return (await call<{ rules: BookingRuleView[] }>(workspaceId, "list_rules", {})).rules;
    },

    async createRule({ workspaceId, rule }) {
      return (await call<{ rule: BookingRuleView }>(workspaceId, "create_rule", { rule })).rule;
    },

    async updateRule({ workspaceId, ruleId, rule }) {
      return (await call<{ rule: BookingRuleView }>(workspaceId, "update_rule", { ruleId, rule })).rule;
    },

    async deleteRule({ workspaceId, ruleId }) {
      await call(workspaceId, "delete_rule", { ruleId });
    },

    // --- Filings ----------------------------------------------------------------------------------
    async listFilings(workspaceId) {
      return (await call<Periods>(workspaceId, "list_periods", {})).filings;
    },

    async createFiling({ workspaceId, userId, filing }) {
      // `create_filing` makes a draft; a filing recorded as already submitted is then marked as
      // such with `submit_filing` (two calls: a failure in between leaves the draft, which the
      // periods page shows and the same "Als übermittelt markieren" completes).
      const draft = (await call<{ filing: FilingView }>(workspaceId, "create_filing", { kind: filing.kind, periodFrom: filing.periodFrom, periodTo: filing.periodTo, amountCents: filing.amountCents ?? null, note: filing.note ?? null }, userId)).filing;
      if (filing.status === "draft" || !filing.submittedOn) return draft;
      return (await call<{ filing: FilingView }>(workspaceId, "submit_filing", { filingId: draft.id, submittedOn: filing.submittedOn, amountCents: filing.amountCents ?? null }, userId)).filing;
    },

    async submitFiling({ workspaceId, filingId, submittedOn, amountCents }) {
      return (await call<{ filing: FilingView }>(workspaceId, "submit_filing", { filingId, submittedOn, amountCents: amountCents ?? null })).filing;
    },

    async createCorrectionFiling({ workspaceId, userId, filingId }) {
      return (await call<{ filing: FilingView }>(workspaceId, "create_correction_filing", { filingId }, userId)).filing;
    },

    // --- Handovers --------------------------------------------------------------------------------
    async createHandover({ workspaceId, userId, periodFrom, periodTo, note }) {
      return (await call<{ handover: HandoverView }>(workspaceId, "create_handover", { periodFrom, periodTo, note: note ?? null }, userId)).handover;
    },

    async listHandovers(workspaceId) {
      return (await call<Periods>(workspaceId, "list_periods", {})).handovers;
    },

    // --- The tax advisor's balance lists ----------------------------------------------------------
    async uploadAdvisorBalances({ workspaceId, userId, periodFrom, periodTo, fileName, csvText }) {
      return (await call<{ upload: AdvisorUploadView }>(workspaceId, "import_advisor_balances", { periodFrom, periodTo, fileName: fileName ?? null, csvText }, userId)).upload;
    },

    async listAdvisorUploads(workspaceId) {
      return (await call<{ uploads: AdvisorUploadView[] }>(workspaceId, "get_advisor_comparison", {})).uploads;
    },

    async getAdvisorComparison(workspaceId, uploadId) {
      const answer = await orNull(call<{ comparison: AdvisorComparisonView }>(workspaceId, "get_advisor_comparison", { uploadId }));
      return answer?.comparison ?? null;
    },

    async deleteAdvisorUpload({ workspaceId, uploadId }) {
      await call(workspaceId, "delete_advisor_balances", { uploadId });
    },

    // --- The proposal engine ----------------------------------------------------------------------
    async syncProposals({ workspaceId, from, to }) {
      const push: LedgerApiCall = (operation, input) => call(workspaceId, operation, input);
      const pushed = await pushLedgerSources({ repos: deps.repos, call: push, appUrl: deps.appUrl ?? null }, workspaceId);
      if (pushed.settlementLines.skipped > 0 || pushed.links.failed > 0) {
        // Ids and counts only: no names, amounts or texts.
        console.warn("[ledger] sources not in the ledger API", { workspaceId, settlementLines: pushed.settlementLines.skipped, failedLinks: pushed.links.failed });
      }
      return call<SyncProposalsResult>(workspaceId, "sync_proposals", { ...(from ? { from } : {}), ...(to ? { to } : {}) }, null, SYNC_TIMEOUT_MS);
    },

    async scheduleSync(workspaceId) {
      if (!(await isEnabled(workspaceId))) return false;
      await deps.repos.jobs.scheduleNow({ kind: JOB_KINDS.ledgerSync, workspaceId, payload: { workspaceId }, now: now() });
      return true;
    },

    async autoMatchOpenItems() {
      return 0;
    },

    async suggestMatches(workspaceId, accountId) {
      const account = (await listAccounts(workspaceId)).find((candidate) => candidate.id === accountId);
      if (!account) throw new UseCaseError(LEDGER_ERROR.accountNotFound);
      if (!account.openItems) throw new UseCaseError(LEDGER_ERROR.accountNotOpenItems);
      const answer = await orNull(call<{ suggestions: MatchSuggestion[] }>(workspaceId, "get_open_items", { accountNumber: account.number, asOf: today() }));
      return answer?.suggestions ?? [];
    },

    async learnRuleFromEntry({ workspaceId, entryId }) {
      return (await call<{ rule: BookingRuleView }>(workspaceId, "learn_rule_from_entry", { entryId })).rule;
    },
  };
  return api;
}
