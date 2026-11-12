// Owner: src/modules/ledger (decisions/0080-ledger-double-entry-bookkeeping.md). The ledger:
// settings and the seeded SKR 04 chart, journal entries with their revisions, booking, the
// open-item matches, booking rules, filings and the lock they set, handovers to the tax
// advisor, her uploaded balance lists, and every report and control over the books.
//
// Every method takes the caller's own resolved workspace id, never one from client input, and
// throws `LEDGER_ERROR.disabled` while the ledger is off for that workspace (except reading and
// saving the settings). Ids from the client (entry, account, filing, match) are only ever looked
// up within that workspace.
//
// Every change to an entry writes a revision holding the entry and its lines as they were
// before, in the same transaction. Editing, unbooking or deleting a booked entry needs a reason.
// The database is the authority on the two hard rules (a booked entry balances, an entry inside
// a submitted filing period is locked): the use case checks both first for a clear error, and
// maps the trigger's own refusal (`ledger_unbalanced`, `ledger_locked`) to the same codes.
//
// Reads of other owners' tables (bank accounts, transactions, statements, documents, contacts)
// go through read methods of `LedgerRepository` (read-only joins) or the owners' own
// repositories; nothing here writes them.
//
// `upsertProposal` and `listSourceKeys` are the seam for the proposal engine (a later stage):
// a proposal is keyed by its `sourceKey`, and a booked, dismissed or human-edited entry is never
// overwritten by it.
import {
  BANK_ACCOUNT_NUMBERS,
  bankLedgerAccountText,
  CONTACT_CLEARING_NUMBERS,
  contactLedgerAccountText,
  compareBankBalances,
  compareWithAdvisor,
  computeAccountSheet,
  computeBalances,
  computeControls,
  computeOpenItems,
  computeVatPreview,
  debitTotal,
  derivePeriodStatus,
  expandTaxLines,
  isBalanced,
  LEDGER_DB_RAISES,
  lineDifference,
  listEntriesFilterSchema,
  nextFreeNumber,
  parseDatevBalanceList,
  PLATFORM_RECEIVABLE_NUMBERS,
  platformLedgerAccountText,
  SKR04_SEED_ACCOUNTS,
  summarizeEntry,
  vatPeriodsOfYear,
  yearPeriod,
  type AccountSheet,
  type AdvisorComparison,
  type AdvisorUploadView,
  type BalanceList,
  type BookingRuleView,
  type ControlResult,
  type CreateAccountInput,
  type CreateFilingInput,
  type CreateMatchInput,
  type EntryInput,
  type EntrySnapshot,
  type ExpandedLine,
  type FilingRef,
  type FilingView,
  type HandoverView,
  type JournalEntryListItem,
  type JournalEntryRevisionView,
  type JournalEntryView,
  type JournalLineView,
  type LedgerAccountView,
  type LedgerSettingsView,
  type LedgerUseCaseErrorCode,
  type ListEntriesFilter,
  type OpenItemAccountSummary,
  type OpenItems,
  type Period,
  type PeriodOverviewRow,
  type ProposalInput,
  type ReportAccount,
  type ReportLine,
  type RevisionChangeKind,
  type RuleInput,
  type SettingsInput,
  type SourceKeyState,
  type UpdateAccountInput,
  type VatPreview,
} from "@/modules/ledger";
import { dbErrorOf } from "@/persistence/foundation/db-errors";
import type {
  CreateJournalLineRow,
  CreateLedgerAccountRow,
  JournalEntryRow,
  JournalLineWithAccount,
  LedgerAccountRow,
  LedgerBookingRuleRow,
  LedgerFilingRow,
  LedgerReportLineRow,
  LedgerSettingsRow,
  Repositories,
  UnitOfWork,
} from "@/persistence/repositories/contracts";
import { UseCaseError } from "@/persistence/use-cases/errors";

export const LEDGER_ERROR = {
  disabled: "disabled",
  notFound: "not_found",
  accountNotFound: "account_not_found",
  accountArchived: "account_archived",
  accountNumberTaken: "account_number_taken",
  ownerNotFound: "owner_not_found",
  ownerTaken: "owner_taken",
  sourceNotFound: "source_not_found",
  unbalanced: "unbalanced",
  locked: "locked",
  reasonRequired: "reason_required",
  staleRevision: "stale_revision",
  alreadyBooked: "already_booked",
  notBooked: "not_booked",
  notProposed: "not_proposed",
  invalidFiling: "invalid_filing",
  filingOverlaps: "filing_overlaps",
  filingNotDraft: "filing_not_draft",
  filingNotSubmitted: "filing_not_submitted",
  correctionExists: "correction_exists",
  accountNotOpenItems: "account_not_open_items",
  lineNotOnAccount: "line_not_on_account",
  lineAlreadyMatched: "line_already_matched",
  matchNotZero: "match_not_zero",
  advisorFileInvalid: "advisor_file_invalid",
} as const satisfies Record<string, LedgerUseCaseErrorCode>;
export type LedgerErrorCode = (typeof LEDGER_ERROR)[keyof typeof LEDGER_ERROR];

const DEFAULT_SETTINGS: LedgerSettingsView = { enabled: false, vatPeriod: "month", vatBasis: "soll", startDate: null, chart: "skr04" };

export type ProposalOutcome = "created" | "updated" | "kept";

export type BulkBookResult = { booked: string[]; failed: { entryId: string; errorCode: LedgerErrorCode }[] };

export type AdvisorComparisonView = { upload: AdvisorUploadView; comparison: AdvisorComparison };

export interface LedgerUseCases {
  // Settings
  getSettings(workspaceId: string): Promise<LedgerSettingsView>;
  isEnabled(workspaceId: string): Promise<boolean>;
  /** Saves the settings; turning the ledger on seeds the chart (idempotent, see `syncChart`). */
  setSettings(input: { workspaceId: string; settings: SettingsInput }): Promise<LedgerSettingsView>;
  /** Adds what is missing to the chart: the SKR 04 seed, one ledger account per bank account
   * (1800, 1810, ...), per platform clearing account (1370 ff.) and per contact clearing
   * account (1461 ff.). Never changes or removes an existing account's number. */
  syncChart(workspaceId: string): Promise<LedgerAccountView[]>;

  // Chart of accounts
  listAccounts(workspaceId: string): Promise<LedgerAccountView[]>;
  createAccount(input: { workspaceId: string; account: CreateAccountInput }): Promise<LedgerAccountView>;
  updateAccount(input: { workspaceId: string; account: UpdateAccountInput }): Promise<LedgerAccountView>;
  setAccountArchived(input: { workspaceId: string; accountId: string; archived: boolean }): Promise<LedgerAccountView>;

  // Journal
  listEntries(workspaceId: string, filter?: ListEntriesFilter): Promise<JournalEntryListItem[]>;
  getEntry(workspaceId: string, entryId: string): Promise<JournalEntryView | null>;
  /** A manual entry, proposed, or booked at once with `book`. */
  createEntry(input: { workspaceId: string; userId: string; entry: EntryInput; book: boolean }): Promise<{ entryId: string }>;
  updateEntry(input: { workspaceId: string; userId: string; entryId: string; entry: EntryInput; reason?: string | null; expectedRevision?: number }): Promise<{ entryId: string; revision: number }>;
  deleteEntry(input: { workspaceId: string; userId: string; entryId: string; reason?: string | null }): Promise<void>;
  bookEntry(input: { workspaceId: string; userId: string; entryId: string }): Promise<void>;
  unbookEntry(input: { workspaceId: string; userId: string; entryId: string; reason?: string | null }): Promise<void>;
  /** Books each entry in its own transaction; one that fails does not hold back the others. */
  bulkBook(input: { workspaceId: string; userId: string; entryIds: string[] }): Promise<BulkBookResult>;
  /** "Verwerfen": the proposal stays with its source key, so the source is not proposed again. */
  dismissProposal(input: { workspaceId: string; userId: string; entryId: string }): Promise<void>;
  restoreProposal(input: { workspaceId: string; userId: string; entryId: string }): Promise<void>;
  /** The proposal engine's write path, idempotent by `sourceKey`. */
  upsertProposal(input: { workspaceId: string; proposal: ProposalInput }): Promise<{ entryId: string; outcome: ProposalOutcome }>;
  listSourceKeys(workspaceId: string, prefix?: string): Promise<SourceKeyState[]>;

  // Reports
  getBalances(workspaceId: string, period: Period): Promise<BalanceList>;
  getAccountSheet(workspaceId: string, input: { accountNumber: string; from: string; to: string }): Promise<AccountSheet | null>;
  getOpenItems(workspaceId: string, input: { accountNumber: string; asOf: string }): Promise<(OpenItems & { account: LedgerAccountView }) | null>;
  listOpenItemAccounts(workspaceId: string, asOf: string): Promise<OpenItemAccountSummary[]>;
  getVatPreview(workspaceId: string, period: Period): Promise<VatPreview>;
  getControls(workspaceId: string, period: Period): Promise<ControlResult[]>;
  getPeriodOverview(workspaceId: string, year: number): Promise<PeriodOverviewRow[]>;

  // Open items
  createMatch(input: { workspaceId: string; userId: string; match: CreateMatchInput }): Promise<{ matchId: string }>;
  deleteMatch(input: { workspaceId: string; matchId: string }): Promise<void>;

  // Booking rules
  listRules(workspaceId: string): Promise<BookingRuleView[]>;
  createRule(input: { workspaceId: string; rule: RuleInput }): Promise<BookingRuleView>;
  updateRule(input: { workspaceId: string; ruleId: string; rule: RuleInput }): Promise<BookingRuleView>;
  deleteRule(input: { workspaceId: string; ruleId: string }): Promise<void>;

  // Filings
  listFilings(workspaceId: string): Promise<FilingView[]>;
  createFiling(input: { workspaceId: string; userId: string; filing: CreateFilingInput }): Promise<FilingView>;
  submitFiling(input: { workspaceId: string; filingId: string; submittedOn: string; amountCents?: number | null }): Promise<FilingView>;
  /** "Berichtigte Meldung anlegen": a draft for the same period; entries tied to it may change. */
  createCorrectionFiling(input: { workspaceId: string; userId: string; filingId: string }): Promise<FilingView>;

  // Handovers
  createHandover(input: { workspaceId: string; userId: string; periodFrom: string; periodTo: string; note?: string | null }): Promise<HandoverView>;
  listHandovers(workspaceId: string): Promise<HandoverView[]>;

  // The tax advisor's balance lists
  uploadAdvisorBalances(input: { workspaceId: string; userId: string; periodFrom: string; periodTo: string; fileName?: string | null; csvText: string }): Promise<AdvisorUploadView>;
  listAdvisorUploads(workspaceId: string): Promise<AdvisorUploadView[]>;
  getAdvisorComparison(workspaceId: string, uploadId: string): Promise<AdvisorComparisonView | null>;
  deleteAdvisorUpload(input: { workspaceId: string; uploadId: string }): Promise<void>;
}

export type LedgerUseCaseDeps = { repos: Repositories; uow: UnitOfWork; now?: () => Date };

// ---------------------------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------------------------

function toSettingsView(row: LedgerSettingsRow | null): LedgerSettingsView {
  if (!row) return DEFAULT_SETTINGS;
  return { enabled: row.enabled, vatPeriod: row.vatPeriod, vatBasis: row.vatBasis, startDate: row.startDate, chart: row.chart };
}

function toAccountView(row: LedgerAccountRow): LedgerAccountView {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    kind: row.kind,
    group: row.group,
    openItems: row.openItems,
    ownerType: row.ownerType,
    ownerBankAccountId: row.ownerBankAccountId,
    ownerContactId: row.ownerContactId,
    ownerPlatform: row.ownerPlatform,
    ownerPersonName: row.ownerPersonName,
    description: row.description,
    archived: row.archivedAt !== null,
  };
}

function toReportAccount(row: LedgerAccountRow): ReportAccount {
  return { id: row.id, number: row.number, name: row.name, kind: row.kind, group: row.group, openItems: row.openItems };
}

function toReportLine(row: LedgerReportLineRow): ReportLine {
  return {
    lineId: row.lineId,
    entryId: row.entryId,
    position: row.position,
    accountId: row.accountId,
    accountNumber: row.accountNumber,
    bookingDate: row.bookingDate,
    amountCents: row.amountCents,
    taxCode: row.taxCode,
    taxRole: row.taxRole,
    text: row.text,
    entryText: row.entryText,
    documentId: row.documentId,
    transactionId: row.transactionId,
  };
}

function toLineView(row: JournalLineWithAccount): JournalLineView {
  return {
    id: row.id,
    position: row.position,
    accountId: row.accountId,
    accountNumber: row.accountNumber,
    accountName: row.accountName,
    amountCents: row.amountCents,
    taxCode: row.taxCode,
    taxRole: row.taxRole,
    generatedFromLinePosition: row.generatedFromLinePosition,
    text: row.text,
  };
}

function toFilingView(row: LedgerFilingRow): FilingView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    submittedOn: row.submittedOn,
    amountCents: row.amountCents,
    correctsFilingId: row.correctsFilingId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

function toFilingRef(row: LedgerFilingRow): FilingRef {
  return { id: row.id, kind: row.kind, periodFrom: row.periodFrom, periodTo: row.periodTo };
}

function snapshotOf(entry: JournalEntryRow, lines: readonly JournalLineWithAccount[]): EntrySnapshot {
  return {
    bookingDate: entry.bookingDate,
    documentDate: entry.documentDate,
    serviceDate: entry.serviceDate,
    text: entry.text,
    status: entry.status,
    origin: entry.origin,
    dismissed: entry.dismissedAt !== null,
    documentId: entry.documentId,
    transactionId: entry.transactionId,
    lines: lines.map((line) => ({ accountNumber: line.accountNumber, amountCents: line.amountCents, taxCode: line.taxCode, taxRole: line.taxRole, text: line.text })),
  };
}

/** Maps the database's own refusals to the use-case codes; anything else is rethrown. */
function translateDbError(err: unknown): never {
  if (err instanceof UseCaseError) throw err;
  const db = dbErrorOf(err);
  if (db.kind === "raised" && db.message === LEDGER_DB_RAISES.locked) throw new UseCaseError(LEDGER_ERROR.locked);
  if (db.kind === "raised" && db.message === LEDGER_DB_RAISES.unbalanced) throw new UseCaseError(LEDGER_ERROR.unbalanced);
  if (db.kind === "unique") {
    switch (db.constraint) {
      case "ledger_accounts_workspace_number_key":
        throw new UseCaseError(LEDGER_ERROR.accountNumberTaken);
      case "ledger_accounts_workspace_bank_owner_key":
      case "ledger_accounts_workspace_contact_owner_key":
      case "ledger_accounts_workspace_platform_owner_key":
        throw new UseCaseError(LEDGER_ERROR.ownerTaken);
      case "ledger_open_item_match_lines_line_key":
      case "ledger_open_item_match_lines_match_id_line_id_pk":
        throw new UseCaseError(LEDGER_ERROR.lineAlreadyMatched);
      case "ledger_filings_original_key":
        throw new UseCaseError(LEDGER_ERROR.filingOverlaps);
      case "ledger_filings_open_correction_key":
        throw new UseCaseError(LEDGER_ERROR.correctionExists);
    }
  }
  throw err;
}

function yearStart(isoDate: string): string {
  return `${isoDate.slice(0, 4)}-01-01`;
}

function yearEnd(isoDate: string): string {
  return `${isoDate.slice(0, 4)}-12-31`;
}

/** The part of a period on or after the ledger's start date (`null` when none of it is). */
function clampToStart(period: Period, startDate: string | null): Period | null {
  if (!startDate || startDate <= period.from) return period;
  if (startDate > period.to) return null;
  return { from: startDate, to: period.to };
}

function sameSnapshot(a: EntrySnapshot, b: EntrySnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

export function createLedgerUseCases(deps: LedgerUseCaseDeps): LedgerUseCases {
  const now = deps.now ?? (() => new Date());
  const ledger = deps.repos.ledger;

  async function requireEnabled(workspaceId: string, repos: Repositories = deps.repos): Promise<LedgerSettingsRow> {
    const settings = await repos.ledger.findSettings(workspaceId);
    if (!settings?.enabled) throw new UseCaseError(LEDGER_ERROR.disabled);
    return settings;
  }

  /** Runs `work` in one transaction and maps the database's refusals, including the deferred
   * balance check that only fires at commit. */
  async function transact<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await deps.uow.transaction(work);
    } catch (err) {
      return translateDbError(err);
    }
  }

  async function requireEntry(repos: Repositories, workspaceId: string, entryId: string): Promise<JournalEntryRow> {
    const entry = await repos.ledger.findEntry(workspaceId, entryId);
    if (!entry) throw new UseCaseError(LEDGER_ERROR.notFound);
    return entry;
  }

  async function requireAccountByNumber(repos: Repositories, workspaceId: string, number: string): Promise<LedgerAccountRow> {
    const account = await repos.ledger.findAccountByNumber(workspaceId, number);
    if (!account) throw new UseCaseError(LEDGER_ERROR.accountNotFound);
    return account;
  }

  async function assertNotLocked(repos: Repositories, workspaceId: string, date: string, filingId: string | null): Promise<void> {
    if (await repos.ledger.findLockingFiling(workspaceId, date, filingId)) throw new UseCaseError(LEDGER_ERROR.locked);
  }

  /** The entry's base lines expanded with their tax lines and resolved to accounts of this
   * workspace. Throws for an unknown or archived account. */
  async function prepareLines(repos: Repositories, workspaceId: string, entry: EntryInput): Promise<{ expanded: ExpandedLine[]; rows: CreateJournalLineRow[] }> {
    const expanded = expandTaxLines(entry.lines);
    const accounts = new Map((await repos.ledger.listAccounts(workspaceId)).map((account) => [account.number, account]));
    const rows = expanded.map((line): CreateJournalLineRow => {
      const account = accounts.get(line.accountNumber);
      if (!account) throw new UseCaseError(LEDGER_ERROR.accountNotFound);
      if (account.archivedAt) throw new UseCaseError(LEDGER_ERROR.accountArchived);
      return {
        position: line.position,
        accountId: account.id,
        amountCents: line.amountCents,
        taxCode: line.taxCode,
        taxRole: line.taxRole,
        generatedFromLinePosition: line.generatedFromLinePosition,
        text: line.text,
      };
    });
    return { expanded, rows };
  }

  /** The references an entry carries must point into this workspace. */
  async function validateReferences(repos: Repositories, workspaceId: string, entry: EntryInput): Promise<void> {
    if (entry.documentId && !(await repos.ledger.documentExists(workspaceId, entry.documentId))) throw new UseCaseError(LEDGER_ERROR.sourceNotFound);
    if (entry.transactionId && !(await repos.ledger.transactionExists(workspaceId, entry.transactionId))) throw new UseCaseError(LEDGER_ERROR.sourceNotFound);
    if (entry.correctionOfEntryId && !(await repos.ledger.findEntry(workspaceId, entry.correctionOfEntryId))) throw new UseCaseError(LEDGER_ERROR.sourceNotFound);
    if (entry.filingId) {
      const filing = await repos.ledger.findFiling(workspaceId, entry.filingId);
      const covers =
        filing &&
        (filing.kind === "annual_statement"
          ? entry.bookingDate >= yearStart(filing.periodFrom) && entry.bookingDate <= yearEnd(filing.periodTo)
          : entry.bookingDate >= filing.periodFrom && entry.bookingDate <= filing.periodTo);
      if (!filing || filing.status !== "draft" || !filing.correctsFilingId || !covers) throw new UseCaseError(LEDGER_ERROR.invalidFiling);
    }
  }

  async function writeRevision(
    repos: Repositories,
    input: { workspaceId: string; entry: JournalEntryRow; revision: number; changeKind: RevisionChangeKind; reason: string | null; userId: string | null; before: EntrySnapshot | null; bookingDate?: string },
  ): Promise<void> {
    await repos.ledger.insertRevision({
      workspaceId: input.workspaceId,
      entryId: input.entry.id,
      entryRef: input.entry.id,
      revision: input.revision,
      changeKind: input.changeKind,
      reason: input.reason,
      bookingDate: input.bookingDate ?? input.entry.bookingDate,
      snapshot: input.before,
      changedByUserId: input.userId,
    });
  }

  function entryFields(entry: EntryInput) {
    return {
      bookingDate: entry.bookingDate,
      documentDate: entry.documentDate ?? null,
      serviceDate: entry.serviceDate ?? null,
      text: entry.text,
      documentId: entry.documentId ?? null,
      transactionId: entry.transactionId ?? null,
      correctionOfEntryId: entry.correctionOfEntryId ?? null,
      filingId: entry.filingId ?? null,
    };
  }

  /** A simple bookkeeping change: status or dismissal, with its revision. */
  async function changeState(
    repos: Repositories,
    input: { workspaceId: string; userId: string | null; entry: JournalEntryRow; changeKind: RevisionChangeKind; reason: string | null; patch: Parameters<Repositories["ledger"]["updateEntry"]>[2] },
  ): Promise<void> {
    const lines = await repos.ledger.listLines(input.workspaceId, [input.entry.id]);
    const revision = input.entry.revision + 1;
    const updated = await repos.ledger.updateEntry(input.workspaceId, input.entry.id, { ...input.patch, revision });
    if (!updated) throw new UseCaseError(LEDGER_ERROR.notFound);
    await writeRevision(repos, { workspaceId: input.workspaceId, entry: updated, revision, changeKind: input.changeKind, reason: input.reason, userId: input.userId, before: snapshotOf(input.entry, lines) });
  }

  async function bookOne(workspaceId: string, userId: string, entryId: string): Promise<void> {
    await transact(async (repos) => {
      await requireEnabled(workspaceId, repos);
      const entry = await requireEntry(repos, workspaceId, entryId);
      if (entry.status === "booked") throw new UseCaseError(LEDGER_ERROR.alreadyBooked);
      if (entry.dismissedAt) throw new UseCaseError(LEDGER_ERROR.notProposed);
      const lines = await repos.ledger.listLines(workspaceId, [entry.id]);
      if (!isBalanced(lines)) throw new UseCaseError(LEDGER_ERROR.unbalanced);
      await assertNotLocked(repos, workspaceId, entry.bookingDate, entry.filingId);
      await changeState(repos, { workspaceId, userId, entry, changeKind: "booked", reason: null, patch: { status: "booked", bookedAt: now(), bookedByUserId: userId } });
    });
  }

  function toListItem(row: JournalEntryRow, lines: readonly JournalLineWithAccount[], accounts: ReadonlyMap<string, LedgerAccountRow>): JournalEntryListItem {
    const summary = summarizeEntry(
      lines.flatMap((line) => {
        const account = accounts.get(line.accountId);
        if (!account) return [];
        return [
          {
            accountNumber: account.number,
            accountName: account.name,
            kind: account.kind,
            group: account.group,
            openItems: account.openItems,
            ownerType: account.ownerType,
            ownerPersonName: account.ownerPersonName,
            amountCents: line.amountCents,
            taxCode: line.taxCode,
            taxRole: line.taxRole,
          },
        ];
      }),
    );
    return {
      id: row.id,
      bookingDate: row.bookingDate,
      documentDate: row.documentDate,
      text: row.text,
      status: row.status,
      origin: row.origin,
      dismissed: row.dismissedAt !== null,
      sourceKey: row.sourceKey,
      documentId: row.documentId,
      transactionId: row.transactionId,
      totalCents: debitTotal(lines),
      differenceCents: lineDifference(lines),
      warnings: row.warnings,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
      summary,
      lines: lines.map(toLineView),
    };
  }

  async function loadReport(workspaceId: string, to: string): Promise<{ accounts: LedgerAccountRow[]; reportAccounts: ReportAccount[]; lines: ReportLine[] }> {
    const [accounts, lines] = await Promise.all([ledger.listAccounts(workspaceId), ledger.listReportLines(workspaceId, { to })]);
    return { accounts, reportAccounts: accounts.map(toReportAccount), lines: lines.map(toReportLine) };
  }

  function openItemSummaries(accounts: readonly LedgerAccountRow[], lines: readonly ReportLine[], matches: Awaited<ReturnType<typeof ledger.listMatches>>, asOf: string): OpenItemAccountSummary[] {
    const used = new Set(lines.map((line) => line.accountId));
    return accounts
      .filter((account) => account.openItems && (account.archivedAt === null || used.has(account.id)))
      .map((account) => {
        const items = computeOpenItems(
          account.id,
          lines,
          matches.filter((match) => match.accountId === account.id),
          asOf,
        );
        return { account: toAccountView(account), balanceCents: items.balanceCents, status: items.status, unmatchedCount: items.unmatched.length };
      });
  }

  type ControlContext = {
    settings: LedgerSettingsRow;
    accounts: LedgerAccountRow[];
    lines: ReportLine[];
    matches: Awaited<ReturnType<typeof ledger.listMatches>>;
    bankMovements: Awaited<ReturnType<typeof ledger.listBankMovements>>;
    openings: Map<string, number>;
    uploads: Awaited<ReturnType<typeof ledger.listAdvisorUploads>>;
  };

  async function loadControlContext(workspaceId: string, settings: LedgerSettingsRow, to: string): Promise<ControlContext> {
    const [report, matches, bankMovements, openings, uploads] = await Promise.all([
      loadReport(workspaceId, to),
      ledger.listMatches(workspaceId),
      ledger.listBankMovements(workspaceId, to),
      ledger.listBankOpeningBalances(workspaceId),
      ledger.listAdvisorUploads(workspaceId),
    ]);
    return { settings, accounts: report.accounts, lines: report.lines, matches, bankMovements, openings, uploads };
  }

  async function advisorDifferenceCount(workspaceId: string, ctx: ControlContext, period: Period): Promise<number | null> {
    const upload = ctx.uploads.find((candidate) => candidate.periodTo === period.to && candidate.periodFrom <= period.from);
    if (!upload) return null;
    const theirs = await ledger.listAdvisorLines(workspaceId, upload.id);
    const balances = computeBalances(ctx.accounts.map(toReportAccount), ctx.lines, { from: upload.periodFrom, to: upload.periodTo });
    return compareWithAdvisor(
      balances.rows.map((row) => ({ number: row.number, name: row.name, closingCents: row.closingCents })),
      theirs,
    ).differenceCount;
  }

  async function controlsFor(workspaceId: string, ctx: ControlContext, period: Period): Promise<{ controls: ControlResult[]; booked: number; proposed: number }> {
    const lines = ctx.lines.filter((line) => line.bookingDate <= period.to);
    const bank = ctx.accounts
      .filter((account) => account.ownerType === "bank_account" && account.ownerBankAccountId)
      .map((account) =>
        compareBankBalances(
          {
            accountNumber: account.number,
            ledger: { openingCents: 0, movements: lines.filter((line) => line.accountId === account.id).map((line) => ({ date: line.bookingDate, amountCents: line.amountCents })) },
            real: {
              openingCents: ctx.openings.get(account.ownerBankAccountId ?? "") ?? 0,
              movements: ctx.bankMovements
                .filter((movement) => movement.accountId === account.ownerBankAccountId && movement.bookingDate <= period.to)
                .map((movement) => ({ date: movement.bookingDate, amountCents: movement.amountCents })),
            },
          },
          period,
        ),
      );

    const covered = clampToStart(period, ctx.settings.startDate);
    const [unbookedTx, unbookedDocs, counts, advisor] = await Promise.all([
      covered ? ledger.listUnbookedBankTransactionIds(workspaceId, covered) : Promise.resolve([]),
      covered ? ledger.listUnbookedDocumentIds(workspaceId, covered) : Promise.resolve([]),
      ledger.countEntries(workspaceId, period),
      advisorDifferenceCount(workspaceId, ctx, period),
    ]);
    const openItemAccounts = openItemSummaries(ctx.accounts, lines, ctx.matches, period.to)
      .filter((summary) => summary.balanceCents !== 0 || summary.unmatchedCount > 0)
      .map((summary) => ({ accountNumber: summary.account.number, status: summary.status, balanceCents: summary.balanceCents }));

    const controls = computeControls({
      bank,
      unbookedBankTransactionIds: unbookedTx,
      unbookedDocumentIds: unbookedDocs,
      openItemAccounts,
      proposalsWaiting: counts.proposed,
      unbalancedProposals: counts.unbalancedProposed,
      advisorDifferences: advisor,
    });
    return { controls, booked: counts.booked, proposed: counts.proposed };
  }

  /** See `syncChart`. Runs inside a transaction holding the workspace row lock. */
  async function seedChart(repos: Repositories, workspaceId: string): Promise<void> {
    await repos.ledger.insertAccountsIfMissing(
      SKR04_SEED_ACCOUNTS.map(
        (seed): CreateLedgerAccountRow => ({
          workspaceId,
          number: seed.number,
          name: seed.name,
          kind: seed.kind,
          group: seed.group,
          openItems: seed.openItems,
          ownerType: null,
          ownerBankAccountId: null,
          ownerContactId: null,
          ownerPlatform: null,
          ownerPersonName: null,
          description: seed.description,
        }),
      ),
    );
    const accounts = await repos.ledger.listAccounts(workspaceId);
    const byNumber = new Map(accounts.map((account) => [account.number, account]));
    const taken = new Set(byNumber.keys());
    const sources = await repos.ledger.listSourceAccounts(workspaceId);

    const owned = (row: Omit<CreateLedgerAccountRow, "workspaceId">) => repos.ledger.insertAccount({ workspaceId, ...row });

    for (const source of sources.filter((candidate) => candidate.type === "bank")) {
      if (accounts.some((account) => account.ownerBankAccountId === source.id)) continue;
      const text = bankLedgerAccountText(source.name);
      // The seeded, still unowned "1800 Bank" is taken over by the first bank account.
      const free = BANK_ACCOUNT_NUMBERS.find((number) => {
        const existing = byNumber.get(number);
        return !existing || (existing.group === "bank" && existing.ownerType === null);
      });
      if (!free) continue;
      const existing = byNumber.get(free);
      if (existing) {
        const updated = await repos.ledger.updateAccount(workspaceId, existing.id, { ownerType: "bank_account", ownerBankAccountId: source.id, name: text.name, description: text.description });
        if (updated) byNumber.set(free, updated);
      } else {
        const created = await owned({ number: free, name: text.name, kind: "asset", group: "bank", openItems: false, ownerType: "bank_account", ownerBankAccountId: source.id, ownerContactId: null, ownerPlatform: null, ownerPersonName: null, description: text.description });
        byNumber.set(free, created);
        taken.add(free);
      }
    }

    for (const source of sources.filter((candidate) => candidate.type === "clearing")) {
      if (source.platform) {
        if (accounts.some((account) => account.ownerPlatform === source.platform)) continue;
        const number = nextFreeNumber(PLATFORM_RECEIVABLE_NUMBERS, taken);
        if (!number) continue;
        const text = platformLedgerAccountText(source.platform);
        await owned({ number, name: text.name, kind: "asset", group: "open_items", openItems: true, ownerType: "platform", ownerBankAccountId: null, ownerContactId: null, ownerPlatform: source.platform, ownerPersonName: null, description: text.description });
        taken.add(number);
      } else if (source.contactId) {
        if (accounts.some((account) => account.ownerContactId === source.contactId)) continue;
        const number = nextFreeNumber(CONTACT_CLEARING_NUMBERS, taken);
        if (!number) continue;
        const text = contactLedgerAccountText(source.contactName ?? source.name);
        await owned({ number, name: text.name, kind: "asset", group: "open_items", openItems: true, ownerType: "contact", ownerBankAccountId: null, ownerContactId: source.contactId, ownerPlatform: null, ownerPersonName: null, description: text.description });
        taken.add(number);
      }
    }
  }

  async function toRuleView(row: LedgerBookingRuleRow, accounts: ReadonlyMap<string, LedgerAccountRow>): Promise<BookingRuleView> {
    return {
      id: row.id,
      contactId: row.contactId,
      counterpartyPattern: row.counterpartyPattern,
      direction: row.direction,
      accountNumber: accounts.get(row.accountId)?.number ?? "",
      taxCode: row.taxCode,
      paymentAccountNumber: row.paymentAccountId ? (accounts.get(row.paymentAccountId)?.number ?? null) : null,
      noDocument: row.noDocument,
      active: row.active,
      hits: row.hits,
      learnedFromEntryId: row.learnedFromEntryId,
    };
  }

  async function ruleRow(repos: Repositories, workspaceId: string, rule: RuleInput) {
    const account = await requireAccountByNumber(repos, workspaceId, rule.accountNumber);
    const payment = rule.paymentAccountNumber ? await requireAccountByNumber(repos, workspaceId, rule.paymentAccountNumber) : null;
    if (rule.contactId && !(await repos.contact.findById(workspaceId, rule.contactId))) throw new UseCaseError(LEDGER_ERROR.ownerNotFound);
    const pattern = rule.counterpartyPattern?.trim().toLowerCase() || null;
    return {
      contactId: rule.contactId,
      counterpartyPattern: pattern,
      direction: rule.direction,
      accountId: account.id,
      taxCode: rule.taxCode,
      paymentAccountId: payment?.id ?? null,
      noDocument: rule.noDocument,
      active: rule.active,
      learnedFromEntryId: rule.learnedFromEntryId ?? null,
    };
  }

  async function accountsById(workspaceId: string): Promise<Map<string, LedgerAccountRow>> {
    return new Map((await ledger.listAccounts(workspaceId)).map((account) => [account.id, account]));
  }

  return {
    // -----------------------------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------------------------
    async getSettings(workspaceId) {
      return toSettingsView(await ledger.findSettings(workspaceId));
    },

    async isEnabled(workspaceId) {
      return (await ledger.findSettings(workspaceId))?.enabled ?? false;
    },

    async setSettings({ workspaceId, settings }) {
      const row = await transact(async (repos) => {
        const workspace = await repos.workspace.lockForUpdate(workspaceId);
        if (!workspace) throw new UseCaseError(LEDGER_ERROR.notFound);
        const saved = await repos.ledger.upsertSettings(workspaceId, settings);
        if (saved.enabled) await seedChart(repos, workspaceId);
        return saved;
      });
      return toSettingsView(row);
    },

    async syncChart(workspaceId) {
      await requireEnabled(workspaceId);
      await transact(async (repos) => {
        const workspace = await repos.workspace.lockForUpdate(workspaceId);
        if (!workspace) throw new UseCaseError(LEDGER_ERROR.notFound);
        await seedChart(repos, workspaceId);
      });
      return (await ledger.listAccounts(workspaceId)).map(toAccountView);
    },

    // -----------------------------------------------------------------------------------------
    // Chart of accounts
    // -----------------------------------------------------------------------------------------
    async listAccounts(workspaceId) {
      await requireEnabled(workspaceId);
      return (await ledger.listAccounts(workspaceId)).map(toAccountView);
    },

    async createAccount({ workspaceId, account }) {
      await requireEnabled(workspaceId);
      return transact(async (repos) => {
        if (await repos.ledger.findAccountByNumber(workspaceId, account.number)) throw new UseCaseError(LEDGER_ERROR.accountNumberTaken);
        const owners = { ownerBankAccountId: null as string | null, ownerContactId: null as string | null, ownerPlatform: null as string | null, ownerPersonName: null as string | null };
        if (account.ownerType === "bank_account") {
          const sources = await repos.ledger.listSourceAccounts(workspaceId);
          if (!sources.some((source) => source.type === "bank" && source.id === account.ownerBankAccountId)) throw new UseCaseError(LEDGER_ERROR.ownerNotFound);
          owners.ownerBankAccountId = account.ownerBankAccountId ?? null;
        } else if (account.ownerType === "contact") {
          if (!account.ownerContactId || !(await repos.contact.findById(workspaceId, account.ownerContactId))) throw new UseCaseError(LEDGER_ERROR.ownerNotFound);
          owners.ownerContactId = account.ownerContactId;
        } else if (account.ownerType === "platform") {
          owners.ownerPlatform = account.ownerPlatform ?? null;
        } else if (account.ownerType === "person") {
          owners.ownerPersonName = account.ownerPersonName ?? null;
        }
        const existing = await repos.ledger.listAccounts(workspaceId);
        if (
          existing.some(
            (other) =>
              (owners.ownerBankAccountId && other.ownerBankAccountId === owners.ownerBankAccountId) ||
              (owners.ownerContactId && other.ownerContactId === owners.ownerContactId) ||
              (owners.ownerPlatform && other.ownerPlatform === owners.ownerPlatform),
          )
        ) {
          throw new UseCaseError(LEDGER_ERROR.ownerTaken);
        }
        const row = await repos.ledger.insertAccount({
          workspaceId,
          number: account.number,
          name: account.name,
          kind: account.kind,
          group: account.group,
          openItems: account.openItems,
          ownerType: account.ownerType,
          ...owners,
          description: account.description ?? null,
        });
        return toAccountView(row);
      });
    },

    async updateAccount({ workspaceId, account }) {
      await requireEnabled(workspaceId);
      const row = await ledger.updateAccount(workspaceId, account.accountId, {
        name: account.name,
        group: account.group,
        openItems: account.openItems,
        description: account.description ?? null,
      });
      if (!row) throw new UseCaseError(LEDGER_ERROR.accountNotFound);
      return toAccountView(row);
    },

    async setAccountArchived({ workspaceId, accountId, archived }) {
      await requireEnabled(workspaceId);
      const row = await ledger.updateAccount(workspaceId, accountId, { archivedAt: archived ? now() : null });
      if (!row) throw new UseCaseError(LEDGER_ERROR.accountNotFound);
      return toAccountView(row);
    },

    // -----------------------------------------------------------------------------------------
    // Journal
    // -----------------------------------------------------------------------------------------
    async listEntries(workspaceId, filter = {}) {
      await requireEnabled(workspaceId);
      const parsed = listEntriesFilterSchema.parse(filter);
      let accountId: string | undefined;
      if (parsed.accountNumber) {
        const account = await ledger.findAccountByNumber(workspaceId, parsed.accountNumber);
        if (!account) return [];
        accountId = account.id;
      }
      const rows = await ledger.listEntries(workspaceId, {
        from: parsed.from,
        to: parsed.to,
        status: parsed.status,
        origin: parsed.origin,
        accountId,
        changedSince: parsed.changedSince ? new Date(parsed.changedSince) : undefined,
        dismissed: parsed.dismissed,
        limit: parsed.limit,
      });
      const [lines, accounts] = await Promise.all([
        ledger.listLines(
          workspaceId,
          rows.map((row) => row.id),
        ),
        accountsById(workspaceId),
      ]);
      return rows.map((row) =>
        toListItem(
          row,
          lines.filter((line) => line.entryId === row.id),
          accounts,
        ),
      );
    },

    async getEntry(workspaceId, entryId) {
      await requireEnabled(workspaceId);
      const entry = await ledger.findEntry(workspaceId, entryId);
      if (!entry) return null;
      const [lines, revisions, accounts, lockedBy] = await Promise.all([
        ledger.listLines(workspaceId, [entry.id]),
        ledger.listRevisions(workspaceId, entry.id),
        accountsById(workspaceId),
        entry.status === "booked" ? ledger.findLockingFiling(workspaceId, entry.bookingDate, entry.filingId) : Promise.resolve(null),
      ]);
      return {
        ...toListItem(entry, lines, accounts),
        serviceDate: entry.serviceDate,
        originReason: entry.originReason,
        correctionOfEntryId: entry.correctionOfEntryId,
        filingId: entry.filingId,
        bookedAt: entry.bookedAt?.toISOString() ?? null,
        bookedByUserId: entry.bookedByUserId,
        lockedBy: lockedBy ? toFilingRef(lockedBy) : null,
        revisions: revisions.map(
          (revision): JournalEntryRevisionView => ({
            id: revision.id,
            revision: revision.revision,
            changeKind: revision.changeKind,
            changedAt: revision.changedAt.toISOString(),
            changedByUserId: revision.changedByUserId,
            reason: revision.reason,
            snapshot: revision.snapshot ?? null,
          }),
        ),
      };
    },

    async createEntry({ workspaceId, userId, entry, book }) {
      return transact(async (repos) => {
        await requireEnabled(workspaceId, repos);
        await validateReferences(repos, workspaceId, entry);
        const { expanded, rows } = await prepareLines(repos, workspaceId, entry);
        if (book) {
          if (!isBalanced(expanded)) throw new UseCaseError(LEDGER_ERROR.unbalanced);
          await assertNotLocked(repos, workspaceId, entry.bookingDate, entry.filingId ?? null);
        }
        const at = now();
        const created = await repos.ledger.insertEntry({
          workspaceId,
          ...entryFields(entry),
          status: book ? "booked" : "proposed",
          origin: "manual",
          originReason: null,
          sourceKey: null,
          warnings: [],
          userEditedAt: at,
          bookedAt: book ? at : null,
          bookedByUserId: book ? userId : null,
        });
        await repos.ledger.replaceLines(workspaceId, created.id, rows);
        await writeRevision(repos, { workspaceId, entry: created, revision: 1, changeKind: "created", reason: null, userId, before: null });
        return { entryId: created.id };
      });
    },

    async updateEntry({ workspaceId, userId, entryId, entry, reason, expectedRevision }) {
      return transact(async (repos) => {
        await requireEnabled(workspaceId, repos);
        const current = await requireEntry(repos, workspaceId, entryId);
        if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new UseCaseError(LEDGER_ERROR.staleRevision);
        const booked = current.status === "booked";
        if (booked && !reason) throw new UseCaseError(LEDGER_ERROR.reasonRequired);
        await validateReferences(repos, workspaceId, entry);
        const { expanded, rows } = await prepareLines(repos, workspaceId, entry);
        const filingId = entry.filingId ?? null;
        if (booked) {
          if (!isBalanced(expanded)) throw new UseCaseError(LEDGER_ERROR.unbalanced);
          await assertNotLocked(repos, workspaceId, current.bookingDate, filingId);
          await assertNotLocked(repos, workspaceId, entry.bookingDate, filingId);
        }
        const before = snapshotOf(current, await repos.ledger.listLines(workspaceId, [current.id]));
        const revision = current.revision + 1;
        const updated = await repos.ledger.updateEntry(workspaceId, current.id, { ...entryFields(entry), userEditedAt: now(), revision });
        if (!updated) throw new UseCaseError(LEDGER_ERROR.notFound);
        await repos.ledger.replaceLines(workspaceId, current.id, rows);
        await writeRevision(repos, { workspaceId, entry: updated, revision, changeKind: "edited", reason: reason ?? null, userId, before });
        return { entryId: current.id, revision };
      });
    },

    async deleteEntry({ workspaceId, userId, entryId, reason }) {
      await transact(async (repos) => {
        await requireEnabled(workspaceId, repos);
        const current = await requireEntry(repos, workspaceId, entryId);
        if (current.status === "booked") {
          if (!reason) throw new UseCaseError(LEDGER_ERROR.reasonRequired);
          await assertNotLocked(repos, workspaceId, current.bookingDate, current.filingId);
        }
        const before = snapshotOf(current, await repos.ledger.listLines(workspaceId, [current.id]));
        await writeRevision(repos, { workspaceId, entry: current, revision: current.revision + 1, changeKind: "deleted", reason: reason ?? null, userId, before });
        await repos.ledger.deleteEntry(workspaceId, current.id);
      });
    },

    async bookEntry({ workspaceId, userId, entryId }) {
      await bookOne(workspaceId, userId, entryId);
    },

    async unbookEntry({ workspaceId, userId, entryId, reason }) {
      await transact(async (repos) => {
        await requireEnabled(workspaceId, repos);
        const entry = await requireEntry(repos, workspaceId, entryId);
        if (entry.status !== "booked") throw new UseCaseError(LEDGER_ERROR.notBooked);
        if (!reason) throw new UseCaseError(LEDGER_ERROR.reasonRequired);
        await assertNotLocked(repos, workspaceId, entry.bookingDate, entry.filingId);
        await changeState(repos, { workspaceId, userId, entry, changeKind: "unbooked", reason, patch: { status: "proposed", bookedAt: null, bookedByUserId: null } });
      });
    },

    async bulkBook({ workspaceId, userId, entryIds }) {
      await requireEnabled(workspaceId);
      const result: BulkBookResult = { booked: [], failed: [] };
      for (const entryId of new Set(entryIds)) {
        try {
          await bookOne(workspaceId, userId, entryId);
          result.booked.push(entryId);
        } catch (err) {
          if (!(err instanceof UseCaseError)) throw err;
          result.failed.push({ entryId, errorCode: err.code as LedgerErrorCode });
        }
      }
      return result;
    },

    async dismissProposal({ workspaceId, userId, entryId }) {
      await transact(async (repos) => {
        await requireEnabled(workspaceId, repos);
        const entry = await requireEntry(repos, workspaceId, entryId);
        if (entry.status === "booked") throw new UseCaseError(LEDGER_ERROR.alreadyBooked);
        if (entry.dismissedAt) throw new UseCaseError(LEDGER_ERROR.notProposed);
        await changeState(repos, { workspaceId, userId, entry, changeKind: "dismissed", reason: null, patch: { dismissedAt: now() } });
      });
    },

    async restoreProposal({ workspaceId, userId, entryId }) {
      await transact(async (repos) => {
        await requireEnabled(workspaceId, repos);
        const entry = await requireEntry(repos, workspaceId, entryId);
        if (!entry.dismissedAt) throw new UseCaseError(LEDGER_ERROR.notProposed);
        await changeState(repos, { workspaceId, userId, entry, changeKind: "restored", reason: null, patch: { dismissedAt: null } });
      });
    },

    async upsertProposal({ workspaceId, proposal }) {
      try {
        return await transact(async (repos) => {
          await requireEnabled(workspaceId, repos);
          const existing = await repos.ledger.findEntryBySourceKey(workspaceId, proposal.sourceKey);
          if (existing && (existing.status === "booked" || existing.dismissedAt || existing.userEditedAt)) {
            return { entryId: existing.id, outcome: "kept" as const };
          }
          await validateReferences(repos, workspaceId, proposal.entry);
          const { rows } = await prepareLines(repos, workspaceId, proposal.entry);
          const fields = {
            ...entryFields(proposal.entry),
            origin: proposal.origin,
            originReason: proposal.originReason ?? null,
            warnings: proposal.warnings,
          };

          if (!existing) {
            const created = await repos.ledger.insertEntry({ workspaceId, ...fields, status: "proposed", sourceKey: proposal.sourceKey, userEditedAt: null, bookedAt: null, bookedByUserId: null });
            await repos.ledger.replaceLines(workspaceId, created.id, rows);
            await writeRevision(repos, { workspaceId, entry: created, revision: 1, changeKind: "created", reason: null, userId: null, before: null });
            return { entryId: created.id, outcome: "created" as const };
          }

          const oldLines = await repos.ledger.listLines(workspaceId, [existing.id]);
          const before = snapshotOf(existing, oldLines);
          const numbers = new Map((await repos.ledger.listAccounts(workspaceId)).map((account) => [account.id, account.number]));
          const after: EntrySnapshot = {
            ...before,
            bookingDate: fields.bookingDate,
            documentDate: fields.documentDate,
            serviceDate: fields.serviceDate,
            text: fields.text,
            origin: fields.origin,
            documentId: fields.documentId,
            transactionId: fields.transactionId,
            lines: rows.map((line) => ({ accountNumber: numbers.get(line.accountId) ?? "", amountCents: line.amountCents, taxCode: line.taxCode, taxRole: line.taxRole, text: line.text })),
          };
          const sameWarnings = JSON.stringify(existing.warnings) === JSON.stringify(fields.warnings) && existing.originReason === fields.originReason;
          if (sameSnapshot(before, after) && sameWarnings) return { entryId: existing.id, outcome: "kept" as const };

          const revision = existing.revision + 1;
          const updated = await repos.ledger.updateEntry(workspaceId, existing.id, { ...fields, revision });
          if (!updated) throw new UseCaseError(LEDGER_ERROR.notFound);
          await repos.ledger.replaceLines(workspaceId, existing.id, rows);
          await writeRevision(repos, { workspaceId, entry: updated, revision, changeKind: "edited", reason: null, userId: null, before });
          return { entryId: existing.id, outcome: "updated" as const };
        });
      } catch (err) {
        // Two syncs proposing the same source at once: the loser keeps what the winner wrote.
        const db = dbErrorOf(err);
        if (db.kind === "unique" && db.constraint === "journal_entries_workspace_source_key") {
          const winner = await ledger.findEntryBySourceKey(workspaceId, proposal.sourceKey);
          if (winner) return { entryId: winner.id, outcome: "kept" };
        }
        throw err;
      }
    },

    async listSourceKeys(workspaceId, prefix) {
      await requireEnabled(workspaceId);
      return (await ledger.listSourceKeys(workspaceId, prefix)).map((row) => ({
        sourceKey: row.sourceKey,
        entryId: row.entryId,
        status: row.status,
        dismissed: row.dismissedAt !== null,
        userEdited: row.userEditedAt !== null,
      }));
    },

    // -----------------------------------------------------------------------------------------
    // Reports
    // -----------------------------------------------------------------------------------------
    async getBalances(workspaceId, period) {
      await requireEnabled(workspaceId);
      const { reportAccounts, lines } = await loadReport(workspaceId, period.to);
      return computeBalances(reportAccounts, lines, period);
    },

    async getAccountSheet(workspaceId, { accountNumber, from, to }) {
      await requireEnabled(workspaceId);
      const { accounts, lines } = await loadReport(workspaceId, to);
      const account = accounts.find((candidate) => candidate.number === accountNumber);
      if (!account) return null;
      const entries = new Set(lines.filter((line) => line.accountId === account.id).map((line) => line.entryId));
      return computeAccountSheet(
        toReportAccount(account),
        lines.filter((line) => entries.has(line.entryId)),
        { from, to },
      );
    },

    async getOpenItems(workspaceId, { accountNumber, asOf }) {
      await requireEnabled(workspaceId);
      const account = await ledger.findAccountByNumber(workspaceId, accountNumber);
      if (!account) return null;
      if (!account.openItems) throw new UseCaseError(LEDGER_ERROR.accountNotOpenItems);
      const [{ lines }, matches] = await Promise.all([loadReport(workspaceId, asOf), ledger.listMatches(workspaceId, account.id)]);
      return { ...computeOpenItems(account.id, lines, matches, asOf), account: toAccountView(account) };
    },

    async listOpenItemAccounts(workspaceId, asOf) {
      await requireEnabled(workspaceId);
      const [{ accounts, lines }, matches] = await Promise.all([loadReport(workspaceId, asOf), ledger.listMatches(workspaceId)]);
      return openItemSummaries(accounts, lines, matches, asOf);
    },

    async getVatPreview(workspaceId, period) {
      await requireEnabled(workspaceId);
      const lines = await ledger.listReportLines(workspaceId, { to: period.to });
      return computeVatPreview(lines.filter((line) => line.bookingDate >= period.from));
    },

    async getControls(workspaceId, period) {
      const settings = await requireEnabled(workspaceId);
      const ctx = await loadControlContext(workspaceId, settings, period.to);
      return (await controlsFor(workspaceId, ctx, period)).controls;
    },

    async getPeriodOverview(workspaceId, year) {
      const settings = await requireEnabled(workspaceId);
      const periods = vatPeriodsOfYear(year, settings.vatPeriod);
      const ctx = await loadControlContext(workspaceId, settings, yearPeriod(year).to);
      const [filings, handovers] = await Promise.all([ledger.listFilings(workspaceId), ledger.listHandovers(workspaceId)]);
      const rows: PeriodOverviewRow[] = [];
      for (const period of periods) {
        const submitted = filings.find(
          (filing) =>
            filing.status === "submitted" &&
            (filing.kind === "annual_statement"
              ? yearStart(filing.periodFrom) <= period.from && yearEnd(filing.periodTo) >= period.to
              : filing.periodFrom <= period.from && filing.periodTo >= period.to),
        );
        const handover = handovers.find((candidate) => candidate.periodFrom <= period.from && candidate.periodTo >= period.to);
        const [{ controls, booked, proposed }, changesSince] = await Promise.all([
          controlsFor(workspaceId, ctx, period),
          handover ? ledger.countRevisionsSince(workspaceId, period, handover.createdAt) : Promise.resolve(0),
        ]);
        const derived = derivePeriodStatus({ submitted: Boolean(submitted), handover: handover ? { changesSince } : null, controls, bookedCount: booked, proposedCount: proposed });
        rows.push({
          key: period.key,
          from: period.from,
          to: period.to,
          status: derived.status,
          changesSince: derived.changesSince,
          failingControls: derived.failingControls,
          bookedCount: booked,
          proposedCount: proposed,
          submittedFilingId: submitted?.id ?? null,
        });
      }
      return rows;
    },

    // -----------------------------------------------------------------------------------------
    // Open items
    // -----------------------------------------------------------------------------------------
    async createMatch({ workspaceId, userId, match }) {
      return transact(async (repos) => {
        await requireEnabled(workspaceId, repos);
        const account = await requireAccountByNumber(repos, workspaceId, match.accountNumber);
        if (!account.openItems) throw new UseCaseError(LEDGER_ERROR.accountNotOpenItems);
        const lineIds = [...new Set(match.lineIds)];
        const lines = await repos.ledger.findLines(workspaceId, lineIds);
        if (lines.length !== lineIds.length || lines.some((line) => line.accountId !== account.id || line.entryStatus !== "booked")) {
          throw new UseCaseError(LEDGER_ERROR.lineNotOnAccount);
        }
        if ((await repos.ledger.findMatchedLineIds(workspaceId, lineIds)).length > 0) throw new UseCaseError(LEDGER_ERROR.lineAlreadyMatched);
        if (match.kind === "match" && lineDifference(lines) !== 0) throw new UseCaseError(LEDGER_ERROR.matchNotZero);
        const row = await repos.ledger.insertMatch({ workspaceId, accountId: account.id, kind: match.kind, note: match.note ?? null, createdByUserId: userId }, lineIds);
        return { matchId: row.id };
      });
    },

    async deleteMatch({ workspaceId, matchId }) {
      await requireEnabled(workspaceId);
      if (!(await ledger.deleteMatch(workspaceId, matchId))) throw new UseCaseError(LEDGER_ERROR.notFound);
    },

    // -----------------------------------------------------------------------------------------
    // Booking rules
    // -----------------------------------------------------------------------------------------
    async listRules(workspaceId) {
      await requireEnabled(workspaceId);
      const [rules, accounts] = await Promise.all([ledger.listRules(workspaceId), accountsById(workspaceId)]);
      return Promise.all(rules.map((rule) => toRuleView(rule, accounts)));
    },

    async createRule({ workspaceId, rule }) {
      await requireEnabled(workspaceId);
      const row = await ledger.insertRule({ workspaceId, ...(await ruleRow(deps.repos, workspaceId, rule)) });
      return toRuleView(row, await accountsById(workspaceId));
    },

    async updateRule({ workspaceId, ruleId, rule }) {
      await requireEnabled(workspaceId);
      const row = await ledger.updateRule(workspaceId, ruleId, await ruleRow(deps.repos, workspaceId, rule));
      if (!row) throw new UseCaseError(LEDGER_ERROR.notFound);
      return toRuleView(row, await accountsById(workspaceId));
    },

    async deleteRule({ workspaceId, ruleId }) {
      await requireEnabled(workspaceId);
      if (!(await ledger.deleteRule(workspaceId, ruleId))) throw new UseCaseError(LEDGER_ERROR.notFound);
    },

    // -----------------------------------------------------------------------------------------
    // Filings
    // -----------------------------------------------------------------------------------------
    async listFilings(workspaceId) {
      await requireEnabled(workspaceId);
      return (await ledger.listFilings(workspaceId)).map(toFilingView);
    },

    async createFiling({ workspaceId, userId, filing }) {
      return transact(async (repos) => {
        await requireEnabled(workspaceId, repos);
        const periodFrom = filing.kind === "annual_statement" ? yearStart(filing.periodFrom) : filing.periodFrom;
        const periodTo = filing.kind === "annual_statement" ? yearEnd(filing.periodTo) : filing.periodTo;
        const overlaps = (await repos.ledger.listFilings(workspaceId)).some(
          (other) => other.kind === filing.kind && other.correctsFilingId === null && other.periodFrom <= periodTo && other.periodTo >= periodFrom,
        );
        if (overlaps) throw new UseCaseError(LEDGER_ERROR.filingOverlaps);
        const row = await repos.ledger.insertFiling({
          workspaceId,
          kind: filing.kind,
          status: filing.status,
          periodFrom,
          periodTo,
          submittedOn: filing.status === "submitted" ? (filing.submittedOn ?? null) : null,
          amountCents: filing.amountCents ?? null,
          correctsFilingId: null,
          note: filing.note ?? null,
          createdByUserId: userId,
        });
        return toFilingView(row);
      });
    },

    async submitFiling({ workspaceId, filingId, submittedOn, amountCents }) {
      return transact(async (repos) => {
        await requireEnabled(workspaceId, repos);
        const filing = await repos.ledger.findFiling(workspaceId, filingId);
        if (!filing) throw new UseCaseError(LEDGER_ERROR.notFound);
        if (filing.status !== "draft") throw new UseCaseError(LEDGER_ERROR.filingNotDraft);
        const row = await repos.ledger.updateFiling(workspaceId, filingId, { status: "submitted", submittedOn, amountCents: amountCents ?? filing.amountCents });
        if (!row) throw new UseCaseError(LEDGER_ERROR.notFound);
        return toFilingView(row);
      });
    },

    async createCorrectionFiling({ workspaceId, userId, filingId }) {
      return transact(async (repos) => {
        await requireEnabled(workspaceId, repos);
        const filing = await repos.ledger.findFiling(workspaceId, filingId);
        if (!filing) throw new UseCaseError(LEDGER_ERROR.notFound);
        if (filing.status !== "submitted") throw new UseCaseError(LEDGER_ERROR.filingNotSubmitted);
        const open = (await repos.ledger.listFilings(workspaceId)).some((other) => other.correctsFilingId === filing.id && other.status === "draft");
        if (open) throw new UseCaseError(LEDGER_ERROR.correctionExists);
        const row = await repos.ledger.insertFiling({
          workspaceId,
          kind: filing.kind,
          status: "draft",
          periodFrom: filing.periodFrom,
          periodTo: filing.periodTo,
          submittedOn: null,
          amountCents: null,
          correctsFilingId: filing.id,
          note: null,
          createdByUserId: userId,
        });
        return toFilingView(row);
      });
    },

    // -----------------------------------------------------------------------------------------
    // Handovers
    // -----------------------------------------------------------------------------------------
    async createHandover({ workspaceId, userId, periodFrom, periodTo, note }) {
      await requireEnabled(workspaceId);
      const row = await ledger.insertHandover({ workspaceId, periodFrom, periodTo, note: note ?? null, createdByUserId: userId });
      return { id: row.id, periodFrom: row.periodFrom, periodTo: row.periodTo, note: row.note, createdAt: row.createdAt.toISOString(), changesSince: 0 };
    },

    async listHandovers(workspaceId) {
      await requireEnabled(workspaceId);
      const rows = await ledger.listHandovers(workspaceId);
      return Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          periodFrom: row.periodFrom,
          periodTo: row.periodTo,
          note: row.note,
          createdAt: row.createdAt.toISOString(),
          changesSince: await ledger.countRevisionsSince(workspaceId, { from: row.periodFrom, to: row.periodTo }, row.createdAt),
        })),
      );
    },

    // -----------------------------------------------------------------------------------------
    // The tax advisor's balance lists
    // -----------------------------------------------------------------------------------------
    async uploadAdvisorBalances({ workspaceId, userId, periodFrom, periodTo, fileName, csvText }) {
      await requireEnabled(workspaceId);
      const parsed = parseDatevBalanceList(csvText);
      if (!parsed.ok) throw new UseCaseError(LEDGER_ERROR.advisorFileInvalid);
      const row = await transact((repos) =>
        repos.ledger.insertAdvisorUpload({ workspaceId, periodFrom, periodTo, fileName: fileName ?? null, uploadedByUserId: userId }, parsed.rows),
      );
      return { id: row.id, periodFrom: row.periodFrom, periodTo: row.periodTo, fileName: row.fileName, uploadedAt: row.uploadedAt.toISOString(), lineCount: parsed.rows.length };
    },

    async listAdvisorUploads(workspaceId) {
      await requireEnabled(workspaceId);
      return (await ledger.listAdvisorUploads(workspaceId)).map((row) => ({
        id: row.id,
        periodFrom: row.periodFrom,
        periodTo: row.periodTo,
        fileName: row.fileName,
        uploadedAt: row.uploadedAt.toISOString(),
        lineCount: row.lineCount,
      }));
    },

    async getAdvisorComparison(workspaceId, uploadId) {
      await requireEnabled(workspaceId);
      const upload = await ledger.findAdvisorUpload(workspaceId, uploadId);
      if (!upload) return null;
      const [theirs, { reportAccounts, lines }] = await Promise.all([ledger.listAdvisorLines(workspaceId, upload.id), loadReport(workspaceId, upload.periodTo)]);
      const balances = computeBalances(reportAccounts, lines, { from: upload.periodFrom, to: upload.periodTo });
      return {
        upload: { id: upload.id, periodFrom: upload.periodFrom, periodTo: upload.periodTo, fileName: upload.fileName, uploadedAt: upload.uploadedAt.toISOString(), lineCount: theirs.length },
        comparison: compareWithAdvisor(
          balances.rows.map((row) => ({ number: row.number, name: row.name, closingCents: row.closingCents })),
          theirs,
        ),
      };
    },

    async deleteAdvisorUpload({ workspaceId, uploadId }) {
      await requireEnabled(workspaceId);
      if (!(await ledger.deleteAdvisorUpload(workspaceId, uploadId))) throw new UseCaseError(LEDGER_ERROR.notFound);
    },
  };
}
