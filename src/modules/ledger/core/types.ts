// The ledger's closed value sets and view shapes (decisions/0080-ledger-double-entry-bookkeeping.md).
// Every set is `as const`: the schema (`src/persistence/schema/ledger.ts`) stores them as plain
// text enums, the UI translates each value through `Ledger.*` in `de.json`.
//
// Amounts are signed integer cents everywhere: debit (Soll) positive, credit (Haben) negative.

/** The five kinds of a ledger account. Decides which side increases it and whether its balance
 * carries over a year end (asset, liability, equity) or starts again at zero (revenue, expense). */
export const LEDGER_ACCOUNT_KINDS = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];

/** How the UI groups accounts ("Bank und Geld", "Offene Posten", ...). Display only. */
export const LEDGER_ACCOUNT_GROUPS = ["bank", "open_items", "costs", "revenue", "taxes", "equity", "other"] as const;
export type LedgerAccountGroup = (typeof LEDGER_ACCOUNT_GROUPS)[number];

/** Who an account belongs to: a bank `accounts` row, a contact, a platform, or a person (a
 * shareholder's expenses). `null` for an ordinary account. */
export const LEDGER_OWNER_TYPES = ["bank_account", "contact", "platform", "person"] as const;
export type LedgerOwnerType = (typeof LEDGER_OWNER_TYPES)[number];

/** `proposed` until a human books it. A dismissed proposal stays `proposed` with
 * `dismissedAt` set, so its source is never proposed again. */
export const JOURNAL_ENTRY_STATUSES = ["proposed", "booked"] as const;
export type JournalEntryStatus = (typeof JOURNAL_ENTRY_STATUSES)[number];

/** Where an entry came from, from certain to uncertain (decisions/0080 "Proposals"). */
export const JOURNAL_ENTRY_ORIGINS = ["template", "rule", "ai", "manual"] as const;
export type JournalEntryOrigin = (typeof JOURNAL_ENTRY_ORIGINS)[number];

/** A line's part in its tax code: the amount itself, or a tax line generated from it. */
export const TAX_ROLES = ["base", "tax"] as const;
export type TaxRole = (typeof TAX_ROLES)[number];

export const TAX_CODES = ["vst19", "vst7", "rc13b", "ust19", "ust7", "eu_not_taxable", "not_taxable", "tax_free", "pass_through"] as const;
export type TaxCode = (typeof TAX_CODES)[number];

/** Whether the amount the user typed contains the tax (an invoice's total) or not. */
export const AMOUNT_MODES = ["gross", "net"] as const;
export type AmountMode = (typeof AMOUNT_MODES)[number];

export const REVISION_CHANGE_KINDS = ["created", "edited", "booked", "unbooked", "dismissed", "restored", "deleted"] as const;
export type RevisionChangeKind = (typeof REVISION_CHANGE_KINDS)[number];

/** `match`: lines of an open-item account that settle each other (sum zero). `explained`: a
 * remaining balance with a note (a prepaid credit, a payout still to come). */
export const OPEN_ITEM_MATCH_KINDS = ["match", "explained"] as const;
export type OpenItemMatchKind = (typeof OPEN_ITEM_MATCH_KINDS)[number];

export const BOOKING_RULE_DIRECTIONS = ["incoming", "outgoing", "any"] as const;
export type BookingRuleDirection = (typeof BOOKING_RULE_DIRECTIONS)[number];

export const FILING_KINDS = ["vat_return", "annual_statement"] as const;
export type FilingKind = (typeof FILING_KINDS)[number];

export const FILING_STATUSES = ["draft", "submitted"] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];

/** How often the USt-VA is filed. */
export const VAT_PERIODS = ["month", "quarter"] as const;
export type VatPeriod = (typeof VAT_PERIODS)[number];

/** Soll (on invoicing) or Ist (on payment). Recorded; the preview books on the booking date
 * either way in this stage (see the module README's "Known gaps"). */
export const VAT_BASES = ["soll", "ist"] as const;
export type VatBasis = (typeof VAT_BASES)[number];

export const LEDGER_CHARTS = ["skr04"] as const;
export type LedgerChart = (typeof LEDGER_CHARTS)[number];

/** Derived status of one VAT period on the overview, strongest first. */
export const PERIOD_STATUSES = ["submitted", "handed_over", "ready", "in_progress", "open"] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export const CONTROL_IDS = [
  "bank_matches_statement",
  "unbooked_bank_transactions",
  "unbooked_documents",
  "open_item_accounts",
  "unbalanced_entries",
  "proposals_waiting",
  "advisor_differences",
] as const;
export type ControlId = (typeof CONTROL_IDS)[number];

export const CONTROL_STATUSES = ["ok", "warning", "failed", "not_applicable"] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];

/** Flags a proposal carries so a human looks twice (the proposal engine sets them). */
export const PROPOSAL_WARNING_CODES = [
  "no_tax_breakdown",
  "amount_differs_from_payment",
  "possible_pass_through",
  "foreign_supplier_with_vat",
  "duplicate_suspect",
  "ai_unavailable",
] as const;
export type ProposalWarningCode = (typeof PROPOSAL_WARNING_CODES)[number];

/** USt-VA fields ("Kennzahlen") the preview fills. 83 is the resulting Zahllast. */
export const VAT_KENNZAHLEN = ["81", "86", "21", "46", "47", "66", "67", "83"] as const;
export type VatKennzahl = (typeof VAT_KENNZAHLEN)[number];

/** Open-item status of one account: settled to zero, a remainder explained by a note, or open. */
export const OPEN_ITEM_ACCOUNT_STATUSES = ["zero", "explained", "open"] as const;
export type OpenItemAccountStatus = (typeof OPEN_ITEM_ACCOUNT_STATUSES)[number];

/** The deterministic one-sentence summary of an entry (`summarizeEntry`). */
export const ENTRY_SUMMARY_KINDS = [
  "expensePaidByBank",
  "expenseAgainstOpenItem",
  "expenseFromPrepaid",
  "expensePaidByShareholder",
  "reverseCharge",
  "revenue",
  "transfer",
  "split",
  "manual",
] as const;
export type EntrySummaryKind = (typeof ENTRY_SUMMARY_KINDS)[number];

/** An i18n key under `Ledger.` plus the ICU values it needs. Never free text. */
export type MessageRef = { key: string; params: Record<string, string | number> };

// ---------------------------------------------------------------------------------------------
// Views (what the use cases return, what the UI renders)
// ---------------------------------------------------------------------------------------------

export type LedgerSettingsView = {
  enabled: boolean;
  vatPeriod: VatPeriod;
  vatBasis: VatBasis;
  startDate: string | null;
  chart: LedgerChart;
};

export type LedgerAccountView = {
  id: string;
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
  archived: boolean;
};

export type JournalLineView = {
  id: string;
  position: number;
  accountId: string;
  accountNumber: string;
  accountName: string;
  amountCents: number;
  taxCode: TaxCode | null;
  taxRole: TaxRole | null;
  generatedFromLinePosition: number | null;
  text: string | null;
};

export type FilingRef = { id: string; kind: FilingKind; periodFrom: string; periodTo: string };

export type JournalEntryListItem = {
  id: string;
  bookingDate: string;
  documentDate: string | null;
  text: string;
  status: JournalEntryStatus;
  origin: JournalEntryOrigin;
  dismissed: boolean;
  sourceKey: string | null;
  documentId: string | null;
  transactionId: string | null;
  /** Sum of the debit side: what the entry moves. */
  totalCents: number;
  /** Debit minus credit; non-zero only for a proposal still being edited. */
  differenceCents: number;
  warnings: ProposalWarningCode[];
  revision: number;
  updatedAt: string;
  summary: MessageRef;
  lines: JournalLineView[];
};

export type JournalEntryRevisionView = {
  id: string;
  revision: number;
  changeKind: RevisionChangeKind;
  changedAt: string;
  changedByUserId: string | null;
  reason: string | null;
  snapshot: EntrySnapshot | null;
};

export type JournalEntryView = JournalEntryListItem & {
  serviceDate: string | null;
  originReason: string | null;
  correctionOfEntryId: string | null;
  filingId: string | null;
  bookedAt: string | null;
  bookedByUserId: string | null;
  /** The submitted filing that freezes this entry, or `null` while it stays editable. */
  lockedBy: FilingRef | null;
  revisions: JournalEntryRevisionView[];
};

/** What a revision keeps: the entry and its lines as they were. */
export type EntrySnapshot = {
  bookingDate: string;
  documentDate: string | null;
  serviceDate: string | null;
  text: string;
  status: JournalEntryStatus;
  origin: JournalEntryOrigin;
  dismissed: boolean;
  documentId: string | null;
  transactionId: string | null;
  lines: { accountNumber: string; amountCents: number; taxCode: TaxCode | null; taxRole: TaxRole | null; text: string | null }[];
};

export type BookingRuleView = {
  id: string;
  contactId: string | null;
  counterpartyPattern: string | null;
  direction: BookingRuleDirection;
  accountNumber: string;
  taxCode: TaxCode | null;
  paymentAccountNumber: string | null;
  noDocument: boolean;
  active: boolean;
  hits: number;
  learnedFromEntryId: string | null;
};

export type FilingView = {
  id: string;
  kind: FilingKind;
  status: FilingStatus;
  periodFrom: string;
  periodTo: string;
  submittedOn: string | null;
  amountCents: number | null;
  correctsFilingId: string | null;
  note: string | null;
  createdAt: string;
};

export type HandoverView = {
  id: string;
  periodFrom: string;
  periodTo: string;
  note: string | null;
  createdAt: string;
  /** Revisions written after the handover for entries in its period. */
  changesSince: number;
};

export type AdvisorUploadView = {
  id: string;
  periodFrom: string;
  periodTo: string;
  fileName: string | null;
  uploadedAt: string;
  lineCount: number;
};

export type SourceKeyState = { sourceKey: string; entryId: string; status: JournalEntryStatus; dismissed: boolean; userEdited: boolean };

/** Document kinds (`documents.kind`, `@/modules/intake`) the books must account for: a document
 * of one of these kinds without a booked entry fails the "unbooked documents" control. */
export const LEDGER_BOOKABLE_DOCUMENT_KINDS = ["incoming_invoice", "outgoing_invoice", "receipt", "payout_report", "platform_settlement"] as const;

/** One row of the period overview ("Zeiträume"): a USt-VA period with its derived status. */
export type PeriodOverviewRow = {
  key: string;
  from: string;
  to: string;
  status: PeriodStatus;
  /** Revisions since the newest handover covering the period (0 without one). */
  changesSince: number;
  failingControls: ControlId[];
  bookedCount: number;
  proposedCount: number;
  submittedFilingId: string | null;
};

/** An open-item account on the overview: its balance and whether it is settled. */
export type OpenItemAccountSummary = {
  account: LedgerAccountView;
  balanceCents: number;
  status: OpenItemAccountStatus;
  unmatchedCount: number;
};
