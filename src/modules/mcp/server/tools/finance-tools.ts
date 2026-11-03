// Owner: src/modules/mcp (decisions/0078-mcp-server.md). Finance tools: bank/clearing accounts and
// their transactions (`src/modules/accounts`), payment matching (`src/modules/payments`) and the
// Abschluss completeness check (`src/modules/closing`). Admin-only end to end, exactly like
// `/dashboard/finance/**` and `/dashboard/abschluss`: every read needs `finance.read`, every write
// `finance.manage` (decisions/0024-accounts-and-transactions.md). The one exception is
// `mark_document_settled_without_payment` ("ohne Zahlung erledigt"), which only touches the
// document's own status and stays at `documents.write`, as in the dashboard.
import "server-only";

import { z } from "zod";

import {
  createAccountAction,
  createContactClearingAccountAction,
  importFromDocumentAction,
  updateAccountAction,
} from "@/modules/accounts/actions";
import {
  getAccountOverviewProjection,
  listAccountsOverviewProjection,
  listImportBatchesProjection,
  listPendingAccountDocumentsProjection,
  listTransactionsProjection,
} from "@/modules/accounts/server";
import { currentClosingPeriod, parseClosingPeriod } from "@/modules/closing";
import { getClosingReportProjection } from "@/modules/closing/server";
import { PAYMENT_AUTO_CONFIRM_MODES } from "@/modules/payments";
import {
  confirmSuggestionAction,
  deletePaymentAliasAction,
  linkManuallyAction,
  markNoDocumentNeededAction,
  markSettledWithoutPaymentAction,
  rejectSuggestionAction,
  setPaymentAutoConfirmAction,
  unlinkTransactionAction,
} from "@/modules/payments/actions";
import { getPaymentAutoConfirmModeProjection, listOpenItemsProjection, listUnmatchedTransactionsProjection } from "@/modules/payments/server";
import { PERMISSIONS } from "@/platform/access";
import { ACCOUNT_TYPES, CREDIT_DEBIT_INDICATORS } from "@/persistence/repositories/contracts";

import { defineWorkspaceTool, fail, fromActionResult, MCP_ERROR, ok } from "../../core/tool-kit";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);
const offset = z.number().int().min(0).default(0);

function pageOf<T>(rows: readonly T[], from: number, count: number) {
  return { items: rows.slice(from, from + count), total: rows.length, offset: from, hasMore: from + count < rows.length };
}

// --- Accounts (src/modules/accounts) ----------------------------------------------------------

export const listAccountsTool = defineWorkspaceTool({
  name: "list_accounts",
  title: "List accounts",
  description:
    "Every bank and clearing account with its latest balance (cents; balanceIsExact false = summed from " +
    "transactions), coverage gaps, plus confirmed bank statements still waiting for an account ('Konto zuordnen'). " +
    "Admin only (finance.read).",
  input: z.object({}),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(_input, ctx) {
    const [accounts, pendingStatements] = await Promise.all([
      listAccountsOverviewProjection(ctx.workspace.id),
      listPendingAccountDocumentsProjection(ctx.workspace.id),
    ]);
    return ok({ accounts, pendingStatements });
  },
});

export const listTransactionsTool = defineWorkspaceTool({
  name: "list_transactions",
  title: "List transactions",
  description:
    "Transactions of one account, newest first, 25 per page. Filters: text (counterparty/remittance), booking date " +
    "range, amount range in signed cents (credit positive, debit negative), credit/debit. Admin only (finance.read).",
  input: z.object({
    accountId: z.uuid(),
    q: z.string().trim().max(200).optional(),
    dateFrom: isoDate.optional(),
    dateTo: isoDate.optional(),
    minAmountCents: z.number().int().optional(),
    maxAmountCents: z.number().int().optional(),
    creditDebit: z.enum(CREDIT_DEBIT_INDICATORS).optional(),
    page: z.number().int().min(1).default(1),
    includeImportBatches: z.boolean().default(false).describe("Also list the account's import batches (statements)"),
  }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    const account = await getAccountOverviewProjection(ctx.workspace.id, input.accountId);
    if (!account) return fail(MCP_ERROR.notFound);
    const { accountId, includeImportBatches, ...query } = input;
    const [transactions, importBatches] = await Promise.all([
      listTransactionsProjection(ctx.workspace.id, accountId, { ...query, q: query.q || undefined }),
      includeImportBatches ? listImportBatchesProjection(ctx.workspace.id, accountId) : Promise.resolve(undefined),
    ]);
    return ok({
      account: { id: account.id, name: account.name, type: account.type, iban: account.iban, currency: account.currency, latestBalanceCents: account.latestBalanceCents },
      transactions: transactions.items.map((t) => ({
        id: t.id,
        bookingDate: t.bookingDate,
        valueDate: t.valueDate,
        amountCents: t.amountCents,
        currency: t.currency,
        creditDebit: t.creditDebit,
        counterpartyName: t.counterpartyName,
        counterpartyIban: t.counterpartyIban,
        remittanceText: t.remittanceText,
        endToEndId: t.endToEndId,
      })),
      hasMore: transactions.hasMore,
      page: input.page,
      ...(importBatches ? { importBatches } : {}),
    });
  },
});

const accountFields = {
  type: z.enum(ACCOUNT_TYPES),
  name: z.string().min(1).max(200),
  iban: z.string().max(34).optional(),
  bic: z.string().max(11).optional(),
  currency: z.string().length(3).optional().describe("ISO 4217, default EUR"),
  holder: z.string().max(200).optional(),
  platform: z.string().max(60).optional().describe("For a clearing account: the platform it settles (e.g. PayPal)"),
};

export const createAccountTool = defineWorkspaceTool({
  name: "create_account",
  title: "Create account",
  description: "Creates a bank or clearing account by hand. An IBAN must pass the checksum. Admin only (finance.manage).",
  input: z.object(accountFields),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await createAccountAction(input));
  },
});

export const updateAccountTool = defineWorkspaceTool({
  name: "update_account",
  title: "Update account",
  description:
    "Replaces an account's fields (full replace). The IBAN of an account that already has imports cannot change. " +
    "Admin only (finance.manage).",
  input: z.object({ accountId: z.uuid(), ...accountFields }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await updateAccountAction(input));
  },
});

export const createContactClearingAccountTool = defineWorkspaceTool({
  name: "create_contact_clearing_account",
  title: "Create supplier clearing account",
  description:
    "Creates a clearing account for a contact that is paid by card/direct debit without one invoice per charge " +
    "('Verrechnungskonto'). paymentName is how the bank statement names the supplier (e.g. FACEBK). Admin only (finance.manage).",
  input: z.object({ contactId: z.uuid(), paymentName: z.string().max(200).optional() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await createContactClearingAccountAction(input));
  },
});

export const importStatementTool = defineWorkspaceTool({
  name: "import_statement",
  title: "Import statement into account",
  description:
    "Imports (or re-imports) a confirmed bank statement or settlement report document into an account; pass " +
    "accountId to resolve a statement waiting for an account. Idempotent: rows already imported are skipped. " +
    "Payment matching runs afterwards in the background. Admin only (finance.manage).",
  input: z.object({ documentId: z.uuid(), accountId: z.uuid().optional() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await importFromDocumentAction(input));
  },
});

// --- Payment matching (src/modules/payments) --------------------------------------------------

export const listUnmatchedTransactionsTool = defineWorkspaceTool({
  name: "list_unmatched_transactions",
  title: "List unmatched transactions",
  description:
    "The 'Zuordnung' work list: bank transactions without a document, each with Digipost's open match suggestions " +
    "(documentTransactionId, confidence, reasons). Confirm or reject a suggestion with " +
    "confirm_payment_suggestion / reject_payment_suggestion, link by hand with link_payment, or mark it " +
    "mark_transactions_no_document_needed. Optional booking-date range. Admin only (finance.read).",
  input: z.object({ from: isoDate.optional(), to: isoDate.optional(), offset, limit: limit(200, 50) }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    const [rows, autoConfirmMode] = await Promise.all([
      listUnmatchedTransactionsProjection(ctx.workspace.id, input.from, input.to),
      getPaymentAutoConfirmModeProjection(ctx.workspace.id),
    ]);
    return ok({ ...pageOf(rows, input.offset, input.limit), autoConfirmMode });
  },
});

export const listOpenItemsTool = defineWorkspaceTool({
  name: "list_open_items",
  title: "List open items",
  description:
    "The 'Offene Posten' list: invoices not (fully) paid yet, incoming and outgoing, sorted by due date, with open " +
    "amounts in cents and totals. Optional document-date range. Admin only (finance.read).",
  input: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    return ok({ ...(await listOpenItemsProjection(ctx.workspace.id, input.from, input.to)) });
  },
});

const documentTransactionId = z.uuid().describe("documentTransactionId of a suggestion or match");

export const confirmPaymentSuggestionTool = defineWorkspaceTool({
  name: "confirm_payment_suggestion",
  title: "Confirm payment suggestion",
  description: "Confirms a suggested match between a document and a bank transaction; the document's payment status updates. Admin only.",
  input: z.object({ documentTransactionId }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await confirmSuggestionAction(input), { confirmed: true });
  },
});

export const rejectPaymentSuggestionTool = defineWorkspaceTool({
  name: "reject_payment_suggestion",
  title: "Reject payment suggestion",
  description: "Rejects a suggested match; Digipost will not suggest this pair again. Admin only.",
  input: z.object({ documentTransactionId }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await rejectSuggestionAction(input), { rejected: true });
  },
});

export const unlinkPaymentTool = defineWorkspaceTool({
  name: "unlink_payment",
  title: "Unlink payment",
  description: "Removes a confirmed match between a document and a transaction; the document becomes open again. Admin only.",
  input: z.object({ documentTransactionId }),
  permission: PERMISSIONS.financeManage,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await unlinkTransactionAction(input), { unlinked: true });
  },
});

export const linkPaymentTool = defineWorkspaceTool({
  name: "link_payment",
  title: "Link payment manually",
  description:
    "Links a transaction to a document by hand. allocatedAmountCents (positive cents) splits a transaction across " +
    "several documents; omitted, the smaller of the transaction amount and the document's open amount is used. Admin only.",
  input: z.object({ documentId: z.uuid(), transactionId: z.uuid(), allocatedAmountCents: z.number().int().positive().optional() }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  async run(input) {
    return fromActionResult(await linkManuallyAction(input), { linked: true });
  },
});

export const markTransactionsNoDocumentNeededTool = defineWorkspaceTool({
  name: "mark_transactions_no_document_needed",
  title: "Mark: no document needed",
  description:
    "Marks transactions as needing no document ('kein Beleg nötig', e.g. bank fees, transfers between own accounts). " +
    "forCounterparty: true also remembers the rule for future transactions of the same counterparty. Admin only.",
  input: z.object({ transactionIds: z.array(z.uuid()).min(1).max(200), forCounterparty: z.boolean().default(false) }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await markNoDocumentNeededAction(input), { marked: input.transactionIds.length });
  },
});

export const markDocumentSettledWithoutPaymentTool = defineWorkspaceTool({
  name: "mark_document_settled_without_payment",
  title: "Mark settled without payment",
  description:
    "Marks an invoice as settled although no payment will appear ('ohne Zahlung erledigt', e.g. offset or paid in " +
    "cash). Only changes the document's own payment status; any member may do this.",
  input: z.object({ documentId: z.uuid() }),
  permission: PERMISSIONS.documentsWrite,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await markSettledWithoutPaymentAction(input), { settled: true });
  },
});

export const setPaymentAutoConfirmModeTool = defineWorkspaceTool({
  name: "set_payment_auto_confirm_mode",
  title: "Set auto-confirm mode",
  description:
    "Which unambiguous payment suggestions Digipost confirms without asking: 'all' (AI suggestions included), " +
    "'system' (default, only those found by deterministic rules and arithmetic), 'none' (a human accepts every " +
    "suggestion). Admin only.",
  input: z.object({ mode: z.enum(PAYMENT_AUTO_CONFIRM_MODES) }),
  permission: PERMISSIONS.financeManage,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await setPaymentAutoConfirmAction(input), { mode: input.mode });
  },
});

export const deletePaymentAliasTool = defineWorkspaceTool({
  name: "delete_payment_alias",
  title: "Delete learned payment name",
  description: "Forgets one payment name learned for a contact (see get_contact's paymentAliases). Cannot be undone. Admin only.",
  input: z.object({ aliasId: z.uuid() }),
  permission: PERMISSIONS.financeManage,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await deletePaymentAliasAction(input), { deleted: true });
  },
});

// --- Abschluss (src/modules/closing) ----------------------------------------------------------

export const getClosingReportTool = defineWorkspaceTool({
  name: "get_closing_report",
  title: "Closing check",
  description:
    "The 'Abschluss' completeness check for a month (YYYY-MM) or year (YYYY), default the current month: totals and " +
    "every gap (unmatched transactions, invoices without payment, pending confirmations, failed processing, open " +
    "suggestions). The ZIP export for the tax advisor is only available in the dashboard. Admin only (finance.read).",
  input: z.object({ period: z.string().regex(/^\d{4}(-\d{2})?$/).optional().describe("YYYY-MM or YYYY") }),
  permission: PERMISSIONS.financeRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    const period = input.period === undefined ? currentClosingPeriod(new Date().toISOString().slice(0, 10)) : parseClosingPeriod(input.period);
    if (!period) return fail("invalid_input");
    return ok({ report: await getClosingReportProjection(ctx.workspace.id, period) });
  },
});

export const FINANCE_TOOLS = [
  listAccountsTool,
  listTransactionsTool,
  createAccountTool,
  updateAccountTool,
  createContactClearingAccountTool,
  importStatementTool,
  listUnmatchedTransactionsTool,
  listOpenItemsTool,
  confirmPaymentSuggestionTool,
  rejectPaymentSuggestionTool,
  unlinkPaymentTool,
  linkPaymentTool,
  markTransactionsNoDocumentNeededTool,
  markDocumentSettledWithoutPaymentTool,
  setPaymentAutoConfirmModeTool,
  deletePaymentAliasTool,
  getClosingReportTool,
];
