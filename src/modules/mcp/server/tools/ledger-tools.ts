// Owner: src/modules/mcp (decisions/0078-mcp-server.md, decisions/0080-ledger-double-entry-bookkeeping.md).
// Ledger tools: the "Buchhaltung" area (`src/modules/ledger`). Admin-only end to end like the
// dashboard: every read needs `finance.read`, every write `finance.manage`, and every one of them
// only works while the ledger is enabled for the workspace (a read answers `disabled` otherwise,
// the same code the actions return). Writes go through the ledger's own Server Actions, so
// balancing, period locks, revisions and error codes are the dashboard's. Marking a filing as
// submitted is offered too (user decision 2026-11-13): it is the one step that locks a period for
// good, so it is `destructive` and says so.
import "server-only";

import { z } from "zod";

import {
  accountNumberSchema,
  createAccountInputSchema,
  createMatchInputSchema,
  entryInputSchema,
  FILING_KINDS,
  JOURNAL_ENTRY_ORIGINS,
  JOURNAL_ENTRY_STATUSES,
  MAX_ADVISOR_CSV_LENGTH,
  MAX_BULK_ENTRIES,
  ruleInputSchema,
  TAX_CODES,
  updateAccountInputSchema,
} from "@/modules/ledger";
import {
  archiveLedgerAccountAction,
  bulkBookJournalEntriesAction,
  createBookingRuleAction,
  createCorrectionFilingAction,
  createFilingAction,
  createHandoverAction,
  createJournalEntryAction,
  createLedgerAccountAction,
  createOpenItemMatchAction,
  deleteAdvisorUploadAction,
  deleteBookingRuleAction,
  deleteJournalEntryAction,
  deleteOpenItemMatchAction,
  dismissProposalAction,
  learnLedgerRuleFromEntryAction,
  restoreLedgerAccountAction,
  restoreProposalAction,
  submitFilingAction,
  syncLedgerProposalsAction,
  unbookJournalEntryAction,
  updateBookingRuleAction,
  updateJournalEntryAction,
  updateLedgerAccountAction,
  uploadAdvisorBalancesAction,
} from "@/modules/ledger/actions";
import {
  countLedgerWaitingProposalsProjection,
  getJournalEntryProjection,
  getLedgerAccountSheetProjection,
  getLedgerAdvisorComparisonProjection,
  getLedgerBalancesProjection,
  getLedgerBankComparisonsProjection,
  getLedgerControlsProjection,
  getLedgerMatchSuggestionsProjection,
  getLedgerOpenItemsProjection,
  getLedgerPeriodOverviewProjection,
  getLedgerSettingsProjection,
  getLedgerSourcesProjection,
  getLedgerVatPreviewProjection,
  isLedgerEnabledProjection,
  listJournalEntriesProjection,
  listLedgerAccountsProjection,
  listLedgerAdvisorUploadsProjection,
  listLedgerFilingsProjection,
  listLedgerHandoversProjection,
  listLedgerOpenItemAccountsProjection,
  listLedgerRulesProjection,
} from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";

import { defineWorkspaceTool, fail, fromActionResult, MCP_ERROR, ok, type ToolContext, type ToolOutcome } from "../../core/tool-kit";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const today = () => new Date().toISOString().slice(0, 10);
const yearStart = (date: string) => `${date.slice(0, 4)}-01-01`;

/** The ledger's own `disabled` code while the workspace has not enabled it. */
const LEDGER_DISABLED = "disabled";

/** Runs a read only while the ledger is enabled; a projection throws `disabled` otherwise. */
async function whileEnabled(ctx: ToolContext, read: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  if (!(await isLedgerEnabledProjection(ctx.workspace.id))) return fail(LEDGER_DISABLED);
  return read();
}

/** A period argument pair, defaulting to the current calendar year up to today. */
const periodFields = {
  from: isoDate.optional().describe("YYYY-MM-DD, default 1 January of the current year"),
  to: isoDate.optional().describe("YYYY-MM-DD, default today"),
};
function periodOf(input: { from?: string; to?: string }): { from: string; to: string } | null {
  const to = input.to ?? today();
  const from = input.from ?? yearStart(to);
  return from <= to ? { from, to } : null;
}

const SIGN_NOTE = "Amounts are signed cents: debit (Soll) positive, credit (Haben) negative.";

// --- Overview and journal ----------------------------------------------------------------------

export const getLedgerOverviewTool = defineWorkspaceTool({
  name: "get_ledger_overview",
  title: "Bookkeeping overview",
  description:
    "The 'Buchhaltung' overview for a period: settings (VAT period and basis, start date), the controls (ledger bank " +
    "balance equals the real bank balance, every open-item/clearing account settled or explained, no document " +
    "without a booking, ...), the bank comparison per bank account, every open-item account with its balance, and " +
    "how many proposals wait in 'Zu prüfen'. Start here. Admin only (finance.read).",
  input: z.object(periodFields),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    const period = periodOf(input);
    if (!period) return fail("invalid_input");
    return whileEnabled(ctx, async () => {
      const id = ctx.workspace.id;
      const [settings, controls, bankComparisons, openItemAccounts, waitingProposals] = await Promise.all([
        getLedgerSettingsProjection(id),
        getLedgerControlsProjection(id, period.from, period.to),
        getLedgerBankComparisonsProjection(id, period.from, period.to),
        listLedgerOpenItemAccountsProjection(id, period.to),
        countLedgerWaitingProposalsProjection(id),
      ]);
      return ok({ period, settings, controls, bankComparisons, openItemAccounts, waitingProposals });
    });
  },
});

export const listJournalEntriesTool = defineWorkspaceTool({
  name: "list_journal_entries",
  title: "List journal entries",
  description:
    "Journal entries (Buchungen) with their lines, newest first. status 'proposed' is the 'Zu prüfen' queue " +
    "(each proposal carries warnings and originReason: template, rule or the AI's reason), 'booked' the journal. " +
    "Filter by booking-date range, origin, ledger account number or source document. " +
    SIGN_NOTE +
    " Admin only (finance.read).",
  input: z.object({
    ...periodFields,
    status: z.enum(JOURNAL_ENTRY_STATUSES).optional(),
    origin: z.enum(JOURNAL_ENTRY_ORIGINS).optional(),
    accountNumber: accountNumberSchema.optional(),
    documentId: z.uuid().optional(),
    dismissed: z.enum(["exclude", "include", "only"]).default("exclude").describe("Dismissed ('verworfen') proposals"),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    return whileEnabled(ctx, async () => {
      const { offset, limit, ...filter } = input;
      const rows = await listJournalEntriesProjection(ctx.workspace.id, { ...filter, limit: 2000 });
      return ok({ items: rows.slice(offset, offset + limit), total: rows.length, offset, hasMore: offset + limit < rows.length });
    });
  },
});

export const getJournalEntryTool = defineWorkspaceTool({
  name: "get_journal_entry",
  title: "Get journal entry",
  description:
    "One journal entry with its lines (tax lines included), revisions (who changed what and why), the filing that " +
    "locks it if any, and its sources: the documents and bank transactions it books. " +
    SIGN_NOTE +
    " Admin only (finance.read).",
  input: z.object({ entryId: z.uuid() }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    return whileEnabled(ctx, async () => {
      const entry = await getJournalEntryProjection(ctx.workspace.id, input.entryId);
      if (!entry) return fail(MCP_ERROR.notFound);
      const documentIds = [...new Set([entry.documentId, ...entry.lines.map((line) => line.documentId)].filter((id): id is string => id !== null))];
      const sources = await getLedgerSourcesProjection(ctx.workspace.id, documentIds, entry.transactionId ? [entry.transactionId] : []);
      return ok({ entry, sources });
    });
  },
});

const lineField = z.object({
  accountNumber: accountNumberSchema,
  amountCents: z.number().int().describe("Signed cents: debit positive, credit negative, never 0"),
  taxCode: z.enum(TAX_CODES).nullable().optional().describe("On an expense/revenue line: Digipost adds the tax lines itself"),
  amountMode: z.enum(["gross", "net"]).optional().describe("Whether amountCents includes the tax (default gross)"),
  taxCents: z.number().int().nullable().optional().describe("The tax printed on the document, if it differs from the computed one"),
  documentId: z.uuid().nullable().optional().describe("The open item (document) this line books or pays"),
  text: z.string().max(300).nullable().optional(),
});
const entryField = z.object({ ...entryInputSchema.shape, lines: z.array(lineField).min(1).max(100) });

export const createJournalEntryTool = defineWorkspaceTool({
  name: "create_journal_entry",
  title: "Create journal entry",
  description:
    "Creates a manual entry ('Neue Buchung'). Lines must balance (sum 0 after tax lines); a line with taxCode gets " +
    "its tax lines added automatically. book: true books it at once, otherwise it waits in 'Zu prüfen'. A date in a " +
    "submitted (locked) period is refused with 'locked'. " +
    SIGN_NOTE +
    " Admin only (finance.manage).",
  input: z.object({ entry: entryField, book: z.boolean().default(false) }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await createJournalEntryAction(input));
  },
});

export const updateJournalEntryTool = defineWorkspaceTool({
  name: "update_journal_entry",
  title: "Update journal entry",
  description:
    "Replaces an entry's date, text and lines (full replace; read it with get_journal_entry first). A booked entry " +
    "needs a reason and gets a revision; pass expectedRevision to refuse the save if someone changed it meanwhile. " +
    "An entry in a submitted period cannot change ('locked'). Admin only (finance.manage).",
  input: z.object({ entryId: z.uuid(), entry: entryField, reason: z.string().max(500).nullable().optional(), expectedRevision: z.number().int().min(1).optional() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await updateJournalEntryAction(input));
  },
});

export const bookJournalEntriesTool = defineWorkspaceTool({
  name: "book_journal_entries",
  title: "Book entries",
  description:
    "Books proposals ('buchen'), one or many. Each is booked on its own; the result lists booked ids and failed ones " +
    "with their error code (e.g. unbalanced, locked). Review warnings first: an entry with warnings usually needs a " +
    "decision. Open items are matched automatically afterwards. Admin only (finance.manage).",
  input: z.object({ entryIds: z.array(z.uuid()).min(1).max(MAX_BULK_ENTRIES) }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await bulkBookJournalEntriesAction(input));
  },
});

export const unbookJournalEntryTool = defineWorkspaceTool({
  name: "unbook_journal_entry",
  title: "Unbook entry",
  description:
    "Takes a booked entry back to a proposal ('Buchung zurücknehmen'), e.g. to correct it; its open-item matches are " +
    "removed. Refused for an entry in a submitted period. reason is recorded in the revision. Admin only (finance.manage).",
  input: z.object({ entryId: z.uuid(), reason: z.string().max(500).nullable().optional() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await unbookJournalEntryAction(input), { unbooked: true });
  },
});

export const deleteJournalEntryTool = defineWorkspaceTool({
  name: "delete_journal_entry",
  title: "Delete entry",
  description:
    "Deletes a manual entry or a proposal. Cannot be undone (the revision history keeps what it was). For a proposal " +
    "you do not want, prefer dismiss_proposal: it stays restorable. Admin only (finance.manage).",
  input: z.object({ entryId: z.uuid(), reason: z.string().max(500).nullable().optional() }),
  permission: PERMISSIONS.financeManage,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await deleteJournalEntryAction(input), { deleted: true });
  },
});

export const dismissProposalTool = defineWorkspaceTool({
  name: "dismiss_proposal",
  title: "Dismiss proposal",
  description: "Dismisses a proposal ('Verwerfen'): it leaves 'Zu prüfen' and is not proposed again. Restorable with restore_proposal. Admin only.",
  input: z.object({ entryId: z.uuid() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await dismissProposalAction(input), { dismissed: true });
  },
});

export const restoreProposalTool = defineWorkspaceTool({
  name: "restore_proposal",
  title: "Restore proposal",
  description: "Brings a dismissed proposal back to 'Zu prüfen'. Admin only.",
  input: z.object({ entryId: z.uuid() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await restoreProposalAction(input), { restored: true });
  },
});

export const syncLedgerProposalsTool = defineWorkspaceTool({
  name: "sync_ledger_proposals",
  title: "Refresh proposals",
  description:
    "'Vorschläge aktualisieren': proposes an entry for every document and bank transaction not booked yet (templates, " +
    "booking rules, then the AI for the rest), optionally only for sources dated from..to. Booked, edited and " +
    "dismissed entries are kept. Returns counts (created, updated, kept, unproposed, ...). Admin only (finance.manage).",
  input: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await syncLedgerProposalsAction(input));
  },
});

// --- Accounts and reports ----------------------------------------------------------------------

export const listLedgerAccountsTool = defineWorkspaceTool({
  name: "list_ledger_accounts",
  title: "Chart of accounts",
  description:
    "The chart of accounts (SKR 04 based): number, name, kind, group, whether it keeps open items, and its owner " +
    "(a bank account, a contact's clearing account, a platform, a shareholder). Admin only (finance.read).",
  input: z.object({ includeArchived: z.boolean().default(false) }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    return whileEnabled(ctx, async () => {
      const accounts = await listLedgerAccountsProjection(ctx.workspace.id);
      return ok({ accounts: input.includeArchived ? accounts : accounts.filter((account) => !account.archived) });
    });
  },
});

export const getLedgerBalancesTool = defineWorkspaceTool({
  name: "get_ledger_balances",
  title: "Trial balance",
  description:
    "The Summen- und Saldenliste for a period: per account opening balance, debit and credit totals and closing " +
    "balance, booked entries only. " +
    SIGN_NOTE +
    " Admin only (finance.read).",
  input: z.object(periodFields),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    const period = periodOf(input);
    if (!period) return fail("invalid_input");
    return whileEnabled(ctx, async () => ok({ period, balances: await getLedgerBalancesProjection(ctx.workspace.id, period.from, period.to) }));
  },
});

export const getLedgerAccountSheetTool = defineWorkspaceTool({
  name: "get_ledger_account_sheet",
  title: "Account sheet",
  description:
    "One account's sheet (Kontenblatt): every line in the period with counter accounts and running balance. " +
    "includeProposals also counts proposals into the balance. " +
    SIGN_NOTE +
    " Admin only (finance.read).",
  input: z.object({ accountNumber: accountNumberSchema, ...periodFields, includeProposals: z.boolean().default(false) }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    const period = periodOf(input);
    if (!period) return fail("invalid_input");
    return whileEnabled(ctx, async () => {
      const sheet = await getLedgerAccountSheetProjection(ctx.workspace.id, input.accountNumber, period.from, period.to, input.includeProposals);
      return sheet ? ok({ sheet }) : fail(MCP_ERROR.notFound);
    });
  },
});

export const getLedgerOpenItemsTool = defineWorkspaceTool({
  name: "get_ledger_open_items",
  title: "Open items of an account",
  description:
    "The open items (Offene Posten) of one open-item account (payables 3300, receivables, a clearing account) as of " +
    "a date: unmatched lines, existing matches (matchId) and suggested groups that sum to zero (lineIds), ready for " +
    "create_open_item_match. Admin only (finance.read).",
  input: z.object({ accountNumber: accountNumberSchema, asOf: isoDate.optional().describe("YYYY-MM-DD, default today") }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    return whileEnabled(ctx, async () => {
      const openItems = await getLedgerOpenItemsProjection(ctx.workspace.id, input.accountNumber, input.asOf ?? today());
      if (!openItems) return fail(MCP_ERROR.notFound);
      const suggestions = await getLedgerMatchSuggestionsProjection(ctx.workspace.id, openItems.account.id);
      return ok({ openItems, suggestions });
    });
  },
});

export const getVatPreviewTool = defineWorkspaceTool({
  name: "get_vat_preview",
  title: "VAT return preview",
  description:
    "The Umsatzsteuer-Voranmeldung preview for a period (usually a quarter or month): every Kennzahl (81, 86, 21, 46, " +
    "47, 66, 67, 83, ...) with base and tax, and the resulting payable (positive) or refund (negative). Booked entries " +
    "only. Admin only (finance.read).",
  input: z.object({ from: isoDate, to: isoDate }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    if (input.from > input.to) return fail("invalid_input");
    return whileEnabled(ctx, async () => ok({ preview: await getLedgerVatPreviewProjection(ctx.workspace.id, input.from, input.to) }));
  },
});

export const createLedgerAccountTool = defineWorkspaceTool({
  name: "create_ledger_account",
  title: "Create ledger account",
  description:
    "Adds an account to the chart, e.g. a clearing account for a supplier or shareholder (openItems: true, ownerType " +
    "contact/person) or a specific expense account. The number must be free. Admin only (finance.manage).",
  input: z.object(createAccountInputSchema.shape),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await createLedgerAccountAction(input));
  },
});

export const updateLedgerAccountTool = defineWorkspaceTool({
  name: "update_ledger_account",
  title: "Update ledger account",
  description: "Renames an account or changes its group, open-item flag and description (number and kind stay). Admin only (finance.manage).",
  input: z.object(updateAccountInputSchema.shape),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await updateLedgerAccountAction(input));
  },
});

export const setLedgerAccountArchivedTool = defineWorkspaceTool({
  name: "set_ledger_account_archived",
  title: "Archive or restore ledger account",
  description: "Archives an account (no new bookings, history stays) or restores it. Admin only (finance.manage).",
  input: z.object({ accountId: z.uuid(), archived: z.boolean() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  idempotent: true,
  async run(input) {
    const action = input.archived ? archiveLedgerAccountAction : restoreLedgerAccountAction;
    return fromActionResult(await action({ accountId: input.accountId }));
  },
});

// --- Open items --------------------------------------------------------------------------------

export const createOpenItemMatchTool = defineWorkspaceTool({
  name: "create_open_item_match",
  title: "Match open items",
  description:
    "Settles open items of one account ('Ausgleichen'): kind 'match' needs lines summing to zero; kind 'explained' " +
    "settles a remainder with a note ('Rest erklären', e.g. a few cents of exchange difference). Line ids come from " +
    "get_ledger_open_items. Admin only (finance.manage).",
  input: z.object(createMatchInputSchema.shape),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await createOpenItemMatchAction(input));
  },
});

export const deleteOpenItemMatchTool = defineWorkspaceTool({
  name: "delete_open_item_match",
  title: "Remove open-item match",
  description: "Removes a match: every line of it becomes open again (match them anew to restore). Admin only (finance.manage).",
  input: z.object({ matchId: z.uuid() }),
  permission: PERMISSIONS.financeManage,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await deleteOpenItemMatchAction(input), { deleted: true });
  },
});

// --- Booking rules -----------------------------------------------------------------------------

export const listBookingRulesTool = defineWorkspaceTool({
  name: "list_booking_rules",
  title: "List booking rules",
  description:
    "The booking rules the proposals follow: per contact or counterparty pattern, direction (incoming = expense side, " +
    "outgoing = revenue side, any), account, tax code, and noDocument rules for transactions without a document " +
    "(share capital, bank fees). Admin only (finance.read).",
  input: z.object({}),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(_input, ctx) {
    return whileEnabled(ctx, async () => ok({ rules: await listLedgerRulesProjection(ctx.workspace.id) }));
  },
});

const ruleField = ruleInputSchema.describe(
  "contactId or counterpartyPattern (lower-cased substring of counterparty name or remittance text). direction: " +
    "'incoming' = money out / supplier invoice, 'outgoing' = money in / revenue, 'any'.",
);

export const createBookingRuleTool = defineWorkspaceTool({
  name: "create_booking_rule",
  title: "Create booking rule",
  description: "Adds a booking rule; it applies from the next sync_ledger_proposals on. Admin only (finance.manage).",
  input: z.object({ rule: ruleField }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await createBookingRuleAction(input.rule));
  },
});

export const updateBookingRuleTool = defineWorkspaceTool({
  name: "update_booking_rule",
  title: "Update booking rule",
  description: "Replaces a booking rule (full replace). Admin only (finance.manage).",
  input: z.object({ ruleId: z.uuid(), rule: ruleField }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await updateBookingRuleAction(input));
  },
});

export const learnBookingRuleFromEntryTool = defineWorkspaceTool({
  name: "learn_booking_rule_from_entry",
  title: "Save entry as rule",
  description: "'Als Regel speichern': derives a rule from an entry, so its contact or counterparty is proposed the same way next time. Admin only.",
  input: z.object({ entryId: z.uuid() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await learnLedgerRuleFromEntryAction(input));
  },
});

export const deleteBookingRuleTool = defineWorkspaceTool({
  name: "delete_booking_rule",
  title: "Delete booking rule",
  description: "Deletes a booking rule. Cannot be undone; entries already booked stay as they are. Admin only (finance.manage).",
  input: z.object({ ruleId: z.uuid() }),
  permission: PERMISSIONS.financeManage,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await deleteBookingRuleAction(input), { deleted: true });
  },
});

// --- Periods, filings, handovers ---------------------------------------------------------------

export const listLedgerPeriodsTool = defineWorkspaceTool({
  name: "list_ledger_periods",
  title: "Periods and filings",
  description:
    "The 'Zeiträume' page for a year: per VAT period its status (open, handed over, submitted), failing controls, " +
    "booked/proposed counts and changes since the last handover; plus every filing (VAT return, annual statement) " +
    "and handover to the tax advisor. Admin only (finance.read).",
  input: z.object({ year: z.number().int().min(2000).max(2100).optional().describe("Default: the current year") }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    return whileEnabled(ctx, async () => {
      const id = ctx.workspace.id;
      const year = input.year ?? Number(today().slice(0, 4));
      const [periods, filings, handovers] = await Promise.all([getLedgerPeriodOverviewProjection(id, year), listLedgerFilingsProjection(id), listLedgerHandoversProjection(id)]);
      return ok({ year, periods, filings, handovers });
    });
  },
});

export const createFilingTool = defineWorkspaceTool({
  name: "create_filing",
  title: "Create filing draft",
  description:
    "Creates a draft filing (a VAT return or annual statement) for a period. A draft locks nothing; mark it with " +
    "submit_filing once it was actually filed with the Finanzamt. Admin only (finance.manage).",
  input: z.object({ kind: z.enum(FILING_KINDS), periodFrom: isoDate, periodTo: isoDate, amountCents: z.number().int().nullable().optional(), note: z.string().max(1000).nullable().optional() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await createFilingAction({ ...input, status: "draft" }));
  },
});

export const submitFilingTool = defineWorkspaceTool({
  name: "submit_filing",
  title: "Mark filing as submitted (locks the period)",
  description:
    "Marks a draft filing as submitted to the Finanzamt ('Als eingereicht markieren'). From then on every entry in its " +
    "period is LOCKED: it can no longer be booked, changed, unbooked or deleted. This CANNOT be undone; a later " +
    "correction only works through create_correction_filing. Only call this after the user explicitly confirmed " +
    "that the return was filed. amountCents is the filed payable (positive) or refund (negative). Admin only (finance.manage).",
  input: z.object({ filingId: z.uuid(), submittedOn: isoDate, amountCents: z.number().int().nullable().optional() }),
  permission: PERMISSIONS.financeManage,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await submitFilingAction(input));
  },
});

export const createCorrectionFilingTool = defineWorkspaceTool({
  name: "create_correction_filing",
  title: "Create correction filing",
  description:
    "'Berichtigte Meldung anlegen' for a submitted filing: a new draft for the same period; correcting entries are " +
    "booked into it while the original stays locked. Admin only (finance.manage).",
  input: z.object({ filingId: z.uuid() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await createCorrectionFilingAction(input));
  },
});

export const createHandoverTool = defineWorkspaceTool({
  name: "create_handover",
  title: "Record handover to tax advisor",
  description:
    "Records that a period was handed over to the tax advisor ('An Steuerberaterin übergeben'); later changes in it " +
    "are counted as 'changes since handover'. Locks nothing. Admin only (finance.manage).",
  input: z.object({ periodFrom: isoDate, periodTo: isoDate, note: z.string().max(1000).nullable().optional() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await createHandoverAction(input));
  },
});

// --- The tax advisor's balance lists -----------------------------------------------------------

export const getAdvisorComparisonTool = defineWorkspaceTool({
  name: "get_advisor_comparison",
  title: "Compare with tax advisor",
  description:
    "The tax advisor's imported balance lists (Summen- und Saldenliste); with uploadId, the comparison of that list " +
    "with Digipost's own balances per account, differences first. Admin only (finance.read).",
  input: z.object({ uploadId: z.uuid().optional() }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    return whileEnabled(ctx, async () => {
      const uploads = await listLedgerAdvisorUploadsProjection(ctx.workspace.id);
      if (!input.uploadId) return ok({ uploads });
      const comparison = await getLedgerAdvisorComparisonProjection(ctx.workspace.id, input.uploadId);
      return comparison ? ok({ uploads, comparison }) : fail(MCP_ERROR.notFound);
    });
  },
});

export const importAdvisorBalancesTool = defineWorkspaceTool({
  name: "import_advisor_balances",
  title: "Import tax advisor's balance list",
  description:
    "Imports the tax advisor's Summen- und Saldenliste for a period as CSV text (DATEV export: account number, " +
    "name, balance), for get_advisor_comparison. Changes no booking. Admin only (finance.manage).",
  input: z.object({ periodFrom: isoDate, periodTo: isoDate, fileName: z.string().max(255).nullable().optional(), csvText: z.string().min(1).max(MAX_ADVISOR_CSV_LENGTH) }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await uploadAdvisorBalancesAction(input));
  },
});

export const deleteAdvisorBalancesTool = defineWorkspaceTool({
  name: "delete_advisor_balances",
  title: "Delete tax advisor's balance list",
  description: "Deletes one imported balance list of the tax advisor. Cannot be undone (import it again if needed). Admin only (finance.manage).",
  input: z.object({ uploadId: z.uuid() }),
  permission: PERMISSIONS.financeManage,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await deleteAdvisorUploadAction(input), { deleted: true });
  },
});

export const LEDGER_TOOLS = [
  getLedgerOverviewTool,
  listJournalEntriesTool,
  getJournalEntryTool,
  createJournalEntryTool,
  updateJournalEntryTool,
  bookJournalEntriesTool,
  unbookJournalEntryTool,
  deleteJournalEntryTool,
  dismissProposalTool,
  restoreProposalTool,
  syncLedgerProposalsTool,
  listLedgerAccountsTool,
  getLedgerBalancesTool,
  getLedgerAccountSheetTool,
  getLedgerOpenItemsTool,
  getVatPreviewTool,
  createLedgerAccountTool,
  updateLedgerAccountTool,
  setLedgerAccountArchivedTool,
  createOpenItemMatchTool,
  deleteOpenItemMatchTool,
  listBookingRulesTool,
  createBookingRuleTool,
  updateBookingRuleTool,
  learnBookingRuleFromEntryTool,
  deleteBookingRuleTool,
  listLedgerPeriodsTool,
  createFilingTool,
  submitFilingTool,
  createCorrectionFilingTool,
  createHandoverTool,
  getAdvisorComparisonTool,
  importAdvisorBalancesTool,
  deleteAdvisorBalancesTool,
];
