// Owner: src/modules/ledger (decisions/0080-ledger-double-entry-bookkeeping.md). Contracts only:
// no Drizzle import besides type-only schema references.
//
// Every method takes the caller's resolved `workspaceId` first and filters on it. The
// "source reads" at the end read other owners' tables (`accounts`, `transactions`,
// `import_batches`, `documents`) read-only, by a join (AGENTS.md "Only the owning module writes
// its own tables": other code reads via a join); nothing here writes them.
import type { InferSelectModel } from "drizzle-orm";

import type {
  BookingAdviceRaw,
  BookingRuleDirection,
  EntrySnapshot,
  FilingKind,
  FilingStatus,
  JournalEntryOrigin,
  JournalEntryStatus,
  LedgerAccountGroup,
  LedgerAccountKind,
  LedgerOwnerType,
  OpenItemMatchKind,
  ProposalWarningCode,
  RevisionChangeKind,
  TaxCode,
  TaxRole,
  VatBasis,
  VatPeriod,
} from "@/modules/ledger";
import type {
  journalEntries,
  journalEntryRevisions,
  journalLines,
  ledgerAccounts,
  ledgerAdvisorBalanceLines,
  ledgerAdvisorBalances,
  ledgerBookingAdvice,
  ledgerBookingRules,
  ledgerFilings,
  ledgerHandovers,
  ledgerOpenItemMatches,
  ledgerSettings,
} from "@/persistence/schema/ledger";

export type LedgerSettingsRow = InferSelectModel<typeof ledgerSettings>;
export type LedgerAccountRow = InferSelectModel<typeof ledgerAccounts>;
export type JournalEntryRow = InferSelectModel<typeof journalEntries>;
export type JournalLineRow = InferSelectModel<typeof journalLines>;
export type JournalEntryRevisionRow = InferSelectModel<typeof journalEntryRevisions>;
export type LedgerOpenItemMatchRow = InferSelectModel<typeof ledgerOpenItemMatches>;
export type LedgerBookingRuleRow = InferSelectModel<typeof ledgerBookingRules>;
export type LedgerFilingRow = InferSelectModel<typeof ledgerFilings>;
export type LedgerHandoverRow = InferSelectModel<typeof ledgerHandovers>;
export type LedgerAdvisorBalanceRow = InferSelectModel<typeof ledgerAdvisorBalances>;
export type LedgerAdvisorBalanceLineRow = InferSelectModel<typeof ledgerAdvisorBalanceLines>;
export type LedgerBookingAdviceRow = InferSelectModel<typeof ledgerBookingAdvice>;

export type LedgerSettingsPatch = { enabled: boolean; vatPeriod: VatPeriod; vatBasis: VatBasis; startDate: string | null };

export type CreateLedgerAccountRow = {
  workspaceId: string;
  number: string;
  name: string;
  kind: LedgerAccountKind;
  group: LedgerAccountGroup;
  openItems: boolean;
  ownerType: LedgerOwnerType | null;
  ownerBankAccountId: string | null;
  ownerContactId: string | null;
  ownerPlatform: string | null;
  ownerPersonName: string | null;
  description: string | null;
};

export type LedgerAccountPatch = Partial<
  Pick<LedgerAccountRow, "name" | "group" | "openItems" | "description" | "archivedAt" | "ownerType" | "ownerBankAccountId" | "ownerContactId" | "ownerPlatform" | "ownerPersonName">
>;

export type CreateJournalEntryRow = {
  id?: string;
  workspaceId: string;
  bookingDate: string;
  documentDate: string | null;
  serviceDate: string | null;
  text: string;
  status: JournalEntryStatus;
  origin: JournalEntryOrigin;
  originReason: string | null;
  sourceKey: string | null;
  documentId: string | null;
  transactionId: string | null;
  correctionOfEntryId: string | null;
  filingId: string | null;
  warnings: ProposalWarningCode[];
  userEditedAt: Date | null;
  bookedAt: Date | null;
  bookedByUserId: string | null;
};

export type JournalEntryPatch = Partial<Omit<CreateJournalEntryRow, "id" | "workspaceId" | "sourceKey">> & {
  dismissedAt?: Date | null;
  revision?: number;
};

export type CreateJournalLineRow = {
  position: number;
  accountId: string;
  amountCents: number;
  taxCode: TaxCode | null;
  taxRole: TaxRole | null;
  generatedFromLinePosition: number | null;
  documentId: string | null;
  text: string | null;
};

/** A line with the number and name of its account. */
export type JournalLineWithAccount = JournalLineRow & { accountNumber: string; accountName: string };

export type CreateRevisionRow = {
  workspaceId: string;
  entryId: string | null;
  entryRef: string;
  revision: number;
  changeKind: RevisionChangeKind;
  reason: string | null;
  bookingDate: string;
  snapshot: EntrySnapshot | null;
  changedByUserId: string | null;
};

export type JournalEntryFilter = {
  from?: string;
  to?: string;
  status?: JournalEntryStatus;
  origin?: JournalEntryOrigin;
  accountId?: string;
  /** Entries whose source document is this one. */
  documentId?: string;
  changedSince?: Date;
  dismissed: "exclude" | "include" | "only";
  limit: number;
};

/** A booked (or, on request, proposed) line joined with its entry and account, for reports. */
export type LedgerReportLineRow = {
  lineId: string;
  entryId: string;
  position: number;
  accountId: string;
  accountNumber: string;
  bookingDate: string;
  amountCents: number;
  taxCode: TaxCode | null;
  taxRole: TaxRole | null;
  text: string | null;
  entryText: string;
  documentId: string | null;
  transactionId: string | null;
  status: JournalEntryStatus;
  /** The line's own open-item reference (`journal_lines.document_id`). */
  lineDocumentId: string | null;
};

/** A booked line on an open-item account that no match holds yet. */
export type UnmatchedOpenItemLineRow = { lineId: string; accountId: string; amountCents: number; documentId: string | null; bookingDate: string };

export type LedgerEntryCounts = { booked: number; proposed: number; unbalancedProposed: number };

export type SourceKeyRow = { sourceKey: string; entryId: string; status: JournalEntryStatus; dismissedAt: Date | null; userEditedAt: Date | null };

export type CreateBookingRuleRow = {
  workspaceId: string;
  contactId: string | null;
  counterpartyPattern: string | null;
  direction: BookingRuleDirection;
  accountId: string;
  taxCode: TaxCode | null;
  paymentAccountId: string | null;
  noDocument: boolean;
  active: boolean;
  learnedFromEntryId: string | null;
};

export type CreateFilingRow = {
  workspaceId: string;
  kind: FilingKind;
  status: FilingStatus;
  periodFrom: string;
  periodTo: string;
  submittedOn: string | null;
  amountCents: number | null;
  correctsFilingId: string | null;
  note: string | null;
  createdByUserId: string | null;
};

export type BankTransactionMovementRow = { transactionId: string; accountId: string; bookingDate: string; amountCents: number };

export type BankAccountSourceRow = { id: string; name: string; type: "bank" | "clearing"; platform: string | null; contactId: string | null; contactName: string | null };

export interface LedgerRepository {
  // Settings
  findSettings(workspaceId: string): Promise<LedgerSettingsRow | null>;
  upsertSettings(workspaceId: string, patch: LedgerSettingsPatch): Promise<LedgerSettingsRow>;

  // Chart of accounts
  /** Number order, archived accounts included. */
  listAccounts(workspaceId: string): Promise<LedgerAccountRow[]>;
  findAccountById(workspaceId: string, id: string): Promise<LedgerAccountRow | null>;
  findAccountByNumber(workspaceId: string, number: string): Promise<LedgerAccountRow | null>;
  insertAccount(row: CreateLedgerAccountRow): Promise<LedgerAccountRow>;
  /** Inserts what is missing; an account whose number already exists is left as it is. */
  insertAccountsIfMissing(rows: CreateLedgerAccountRow[]): Promise<LedgerAccountRow[]>;
  updateAccount(workspaceId: string, id: string, patch: LedgerAccountPatch): Promise<LedgerAccountRow | null>;
  countLinesForAccount(workspaceId: string, accountId: string): Promise<number>;

  // Journal
  insertEntry(row: CreateJournalEntryRow): Promise<JournalEntryRow>;
  findEntry(workspaceId: string, id: string): Promise<JournalEntryRow | null>;
  findEntryBySourceKey(workspaceId: string, sourceKey: string): Promise<JournalEntryRow | null>;
  updateEntry(workspaceId: string, id: string, patch: JournalEntryPatch): Promise<JournalEntryRow | null>;
  deleteEntry(workspaceId: string, id: string): Promise<boolean>;
  /** Newest booking date first. */
  listEntries(workspaceId: string, filter: JournalEntryFilter): Promise<JournalEntryRow[]>;
  /** Replaces every line of the entry. Open-item matches holding one of the old lines are
   * dissolved as a whole: a changed line no longer settles what it settled. */
  replaceLines(workspaceId: string, entryId: string, lines: CreateJournalLineRow[]): Promise<JournalLineRow[]>;
  /** Position order per entry. */
  listLines(workspaceId: string, entryIds: string[]): Promise<JournalLineWithAccount[]>;
  /** Every line of every entry with `status` (default booked) up to `to`, oldest first. */
  listReportLines(workspaceId: string, options: { to?: string; statuses?: JournalEntryStatus[] }): Promise<LedgerReportLineRow[]>;
  countEntries(workspaceId: string, period: { from: string; to: string }): Promise<LedgerEntryCounts>;
  listSourceKeys(workspaceId: string, prefix?: string): Promise<SourceKeyRow[]>;

  // Revisions
  insertRevision(row: CreateRevisionRow): Promise<JournalEntryRevisionRow>;
  /** Oldest first. */
  listRevisions(workspaceId: string, entryRef: string): Promise<JournalEntryRevisionRow[]>;
  /** Revisions written after `since` for entries booked (before or after the change) in the period. */
  countRevisionsSince(workspaceId: string, period: { from: string; to: string }, since: Date): Promise<number>;

  // Open items
  insertMatch(row: { workspaceId: string; accountId: string; kind: OpenItemMatchKind; note: string | null; createdByUserId: string | null }, lineIds: string[]): Promise<LedgerOpenItemMatchRow>;
  findMatch(workspaceId: string, id: string): Promise<LedgerOpenItemMatchRow | null>;
  deleteMatch(workspaceId: string, id: string): Promise<boolean>;
  listMatches(workspaceId: string, accountId?: string): Promise<Array<LedgerOpenItemMatchRow & { lineIds: string[] }>>;
  /** Which of these lines already belong to a match. */
  findMatchedLineIds(workspaceId: string, lineIds: string[]): Promise<string[]>;
  /** The lines with their entry's status, for a match's checks. */
  findLines(workspaceId: string, lineIds: string[]): Promise<Array<JournalLineRow & { entryStatus: JournalEntryStatus }>>;
  /** Booked lines on open-item accounts (one account, or all) that belong to no match yet. */
  listUnmatchedOpenItemLines(workspaceId: string, accountId?: string): Promise<UnmatchedOpenItemLineRow[]>;

  // Booking rules
  listRules(workspaceId: string): Promise<LedgerBookingRuleRow[]>;
  findRule(workspaceId: string, id: string): Promise<LedgerBookingRuleRow | null>;
  insertRule(row: CreateBookingRuleRow): Promise<LedgerBookingRuleRow>;
  updateRule(workspaceId: string, id: string, patch: Omit<CreateBookingRuleRow, "workspaceId">): Promise<LedgerBookingRuleRow | null>;
  deleteRule(workspaceId: string, id: string): Promise<boolean>;
  /** One more booked proposal that came from this rule. */
  incrementRuleHits(workspaceId: string, id: string): Promise<void>;

  // The AI booking advisor's answers (decisions/0080 phase 3)
  /** The stored answer per document, whatever question it answered (the caller compares the key). */
  listBookingAdvice(workspaceId: string, documentIds: string[]): Promise<LedgerBookingAdviceRow[]>;
  /** Inserts or replaces the answer for the document. */
  upsertBookingAdvice(row: { workspaceId: string; documentId: string; cacheKey: string; answer: BookingAdviceRaw }): Promise<void>;

  // Filings
  /** Newest period first. */
  listFilings(workspaceId: string): Promise<LedgerFilingRow[]>;
  findFiling(workspaceId: string, id: string): Promise<LedgerFilingRow | null>;
  insertFiling(row: CreateFilingRow): Promise<LedgerFilingRow>;
  /** Refused by the database for a submitted filing. */
  updateFiling(workspaceId: string, id: string, patch: { status?: FilingStatus; submittedOn?: string | null; amountCents?: number | null; note?: string | null }): Promise<LedgerFilingRow | null>;
  /** The submitted filing that locks a booked entry on `date`, honoring a draft correction
   * named by `filingId` the same way the database trigger does; `null` when editable. */
  findLockingFiling(workspaceId: string, date: string, filingId: string | null): Promise<LedgerFilingRow | null>;

  // Handovers
  insertHandover(row: { workspaceId: string; periodFrom: string; periodTo: string; note: string | null; createdByUserId: string | null }): Promise<LedgerHandoverRow>;
  /** Newest first. */
  listHandovers(workspaceId: string): Promise<LedgerHandoverRow[]>;

  // Tax advisor's balance lists
  insertAdvisorUpload(
    row: { workspaceId: string; periodFrom: string; periodTo: string; fileName: string | null; uploadedByUserId: string | null },
    lines: { accountNumber: string; accountName: string | null; balanceCents: number }[],
  ): Promise<LedgerAdvisorBalanceRow>;
  /** Newest first, with the number of lines each. */
  listAdvisorUploads(workspaceId: string): Promise<Array<LedgerAdvisorBalanceRow & { lineCount: number }>>;
  findAdvisorUpload(workspaceId: string, id: string): Promise<LedgerAdvisorBalanceRow | null>;
  listAdvisorLines(workspaceId: string, uploadId: string): Promise<LedgerAdvisorBalanceLineRow[]>;
  deleteAdvisorUpload(workspaceId: string, id: string): Promise<boolean>;

  // Source reads (other owners' tables, read-only)
  documentExists(workspaceId: string, documentId: string): Promise<boolean>;
  transactionExists(workspaceId: string, transactionId: string): Promise<boolean>;
  /** Every bank and clearing `accounts` row with its contact's name. */
  listSourceAccounts(workspaceId: string): Promise<BankAccountSourceRow[]>;
  /** Every transaction on a bank `accounts` row booked up to `to`. */
  listBankMovements(workspaceId: string, to: string): Promise<BankTransactionMovementRow[]>;
  /** Per bank `accounts` row: the opening balance of its earliest statement that states one. */
  listBankOpeningBalances(workspaceId: string): Promise<Map<string, number>>;
  /** Transactions on bank accounts in the period that no booked entry references. */
  listUnbookedBankTransactionIds(workspaceId: string, period: { from: string; to: string }): Promise<string[]>;
  /** Bookable documents (invoices, receipts, platform reports) dated in the period that no
   * booked entry references and whose proposal was not dismissed. */
  listUnbookedDocumentIds(workspaceId: string, period: { from: string; to: string }): Promise<string[]>;
}
