"use server";

// The ledger actions (decisions/0080-ledger-double-entry-bookkeeping.md). Admin-only end to end
// like every finance write: each action needs `finance.manage` (only the admin bundle has it)
// and acts on the caller's own resolved workspace, never on a workspace id from the client. Ids
// from the client (entries, accounts, filings, matches, rules, uploads) are only ever looked up
// within that workspace. Every input is parsed with its Zod schema before the permission check,
// so a malformed request never reaches a use case.
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { PERMISSIONS } from "@/platform/access";
import { requirePermission, type WorkspaceAccess } from "@/platform/access/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { UseCaseError } from "@/persistence/use-cases/errors";
import type { BulkBookResult } from "@/persistence/use-cases/ledger-use-cases";
import type { ActionResult } from "@/shared/action-result";

import { isLedgerUseCaseErrorCode, type LedgerActionErrorCode } from "./core/error-codes";
import {
  accountIdInputSchema,
  advisorUploadIdInputSchema,
  bulkBookInputSchema,
  createAccountInputSchema,
  createEntryInputSchema,
  createFilingInputSchema,
  createHandoverInputSchema,
  createMatchInputSchema,
  entryIdInputSchema,
  entryReasonInputSchema,
  filingIdInputSchema,
  matchIdInputSchema,
  ruleIdInputSchema,
  ruleInputSchema,
  settingsInputSchema,
  submitFilingInputSchema,
  syncProposalsInputSchema,
  updateAccountInputSchema,
  updateEntryInputSchema,
  updateRuleInputSchema,
  uploadAdvisorInputSchema,
} from "./core/schemas";
import type { AdvisorUploadView, BookingRuleView, FilingView, HandoverView, LedgerAccountView, LedgerSettingsView, SyncProposalsResult } from "./core/types";

const LEDGER_PATH = "/dashboard/buchhaltung";

export type LedgerActionResult<T> = ActionResult<T, LedgerActionErrorCode>;

function mapUseCaseError(err: unknown): LedgerActionErrorCode {
  if (err instanceof UseCaseError && isLedgerUseCaseErrorCode(err.code)) return err.code;
  console.error("[ledger] action failed", err instanceof Error ? err.name : "unknown");
  return "unknown";
}

/** Parse, check `finance.manage`, run, revalidate the ledger pages. */
async function run<S extends z.ZodType, T>(schema: S, input: unknown, work: (data: z.output<S>, access: WorkspaceAccess) => Promise<T>): Promise<LedgerActionResult<T>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };
  const access = await requirePermission(PERMISSIONS.financeManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };
  try {
    const data = await work(parsed.data, access.access);
    revalidatePath(LEDGER_PATH, "layout");
    return { status: "success", data };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

const ledger = () => getRequestServices().ledger;

// Settings -------------------------------------------------------------------------------------

/** "Buchhaltung aktivieren" and the general settings; enabling seeds the chart. */
export async function saveLedgerSettingsAction(input: unknown): Promise<LedgerActionResult<LedgerSettingsView>> {
  return run(settingsInputSchema, input, (settings, access) => ledger().setSettings({ workspaceId: access.workspace.id, settings }));
}

/** Adds ledger accounts for bank and clearing accounts created since the ledger was enabled. */
export async function syncLedgerChartAction(): Promise<LedgerActionResult<{ accountCount: number }>> {
  return run(z.object({}), {}, async (_data, access) => ({ accountCount: (await ledger().syncChart(access.workspace.id)).length }));
}

// Chart of accounts ----------------------------------------------------------------------------

export async function createLedgerAccountAction(input: unknown): Promise<LedgerActionResult<LedgerAccountView>> {
  return run(createAccountInputSchema, input, (account, access) => ledger().createAccount({ workspaceId: access.workspace.id, account }));
}

export async function updateLedgerAccountAction(input: unknown): Promise<LedgerActionResult<LedgerAccountView>> {
  return run(updateAccountInputSchema, input, (account, access) => ledger().updateAccount({ workspaceId: access.workspace.id, account }));
}

export async function archiveLedgerAccountAction(input: unknown): Promise<LedgerActionResult<LedgerAccountView>> {
  return run(accountIdInputSchema, input, ({ accountId }, access) => ledger().setAccountArchived({ workspaceId: access.workspace.id, accountId, archived: true }));
}

export async function restoreLedgerAccountAction(input: unknown): Promise<LedgerActionResult<LedgerAccountView>> {
  return run(accountIdInputSchema, input, ({ accountId }, access) => ledger().setAccountArchived({ workspaceId: access.workspace.id, accountId, archived: false }));
}

// Journal --------------------------------------------------------------------------------------

export async function createJournalEntryAction(input: unknown): Promise<LedgerActionResult<{ entryId: string }>> {
  return run(createEntryInputSchema, input, ({ entry, book }, access) => ledger().createEntry({ workspaceId: access.workspace.id, userId: access.user.id, entry, book }));
}

export async function updateJournalEntryAction(input: unknown): Promise<LedgerActionResult<{ entryId: string; revision: number }>> {
  return run(updateEntryInputSchema, input, (data, access) => ledger().updateEntry({ workspaceId: access.workspace.id, userId: access.user.id, ...data }));
}

export async function deleteJournalEntryAction(input: unknown): Promise<LedgerActionResult<undefined>> {
  return run(entryReasonInputSchema, input, async ({ entryId, reason }, access) => {
    await ledger().deleteEntry({ workspaceId: access.workspace.id, userId: access.user.id, entryId, reason });
    return undefined;
  });
}

export async function bookJournalEntryAction(input: unknown): Promise<LedgerActionResult<undefined>> {
  return run(entryIdInputSchema, input, async ({ entryId }, access) => {
    await ledger().bookEntry({ workspaceId: access.workspace.id, userId: access.user.id, entryId });
    return undefined;
  });
}

export async function unbookJournalEntryAction(input: unknown): Promise<LedgerActionResult<undefined>> {
  return run(entryReasonInputSchema, input, async ({ entryId, reason }, access) => {
    await ledger().unbookEntry({ workspaceId: access.workspace.id, userId: access.user.id, entryId, reason });
    return undefined;
  });
}

/** "N buchen": books each selected proposal; reports which ones could not be booked. */
export async function bulkBookJournalEntriesAction(input: unknown): Promise<LedgerActionResult<BulkBookResult>> {
  return run(bulkBookInputSchema, input, ({ entryIds }, access) => ledger().bulkBook({ workspaceId: access.workspace.id, userId: access.user.id, entryIds }));
}

/** "Verwerfen". */
export async function dismissProposalAction(input: unknown): Promise<LedgerActionResult<undefined>> {
  return run(entryIdInputSchema, input, async ({ entryId }, access) => {
    await ledger().dismissProposal({ workspaceId: access.workspace.id, userId: access.user.id, entryId });
    return undefined;
  });
}

export async function restoreProposalAction(input: unknown): Promise<LedgerActionResult<undefined>> {
  return run(entryIdInputSchema, input, async ({ entryId }, access) => {
    await ledger().restoreProposal({ workspaceId: access.workspace.id, userId: access.user.id, entryId });
    return undefined;
  });
}

// Open items -----------------------------------------------------------------------------------

/** "Ausgleichen" (kind `match`, sum zero) or "Rest erklären" (kind `explained`, with a note). */
export async function createOpenItemMatchAction(input: unknown): Promise<LedgerActionResult<{ matchId: string }>> {
  return run(createMatchInputSchema, input, (match, access) => ledger().createMatch({ workspaceId: access.workspace.id, userId: access.user.id, match }));
}

export async function deleteOpenItemMatchAction(input: unknown): Promise<LedgerActionResult<undefined>> {
  return run(matchIdInputSchema, input, async ({ matchId }, access) => {
    await ledger().deleteMatch({ workspaceId: access.workspace.id, matchId });
    return undefined;
  });
}

// Booking rules --------------------------------------------------------------------------------

export async function createBookingRuleAction(input: unknown): Promise<LedgerActionResult<BookingRuleView>> {
  return run(ruleInputSchema, input, (rule, access) => ledger().createRule({ workspaceId: access.workspace.id, rule }));
}

export async function updateBookingRuleAction(input: unknown): Promise<LedgerActionResult<BookingRuleView>> {
  return run(updateRuleInputSchema, input, ({ ruleId, rule }, access) => ledger().updateRule({ workspaceId: access.workspace.id, ruleId, rule }));
}

export async function deleteBookingRuleAction(input: unknown): Promise<LedgerActionResult<undefined>> {
  return run(ruleIdInputSchema, input, async ({ ruleId }, access) => {
    await ledger().deleteRule({ workspaceId: access.workspace.id, ruleId });
    return undefined;
  });
}

// The proposal engine --------------------------------------------------------------------------

/** "Vorschläge aktualisieren": proposes an entry for every source not booked yet (decisions/0080
 * phase 3), optionally only for sources dated in `from`..`to`. Idempotent. */
export async function syncLedgerProposalsAction(input: unknown): Promise<LedgerActionResult<SyncProposalsResult>> {
  return run(syncProposalsInputSchema, input ?? {}, (period, access) => ledger().syncProposals({ workspaceId: access.workspace.id, ...period }));
}

/** "Als Regel speichern": the entry's contact or counterparty is proposed the same way next time. */
export async function learnLedgerRuleFromEntryAction(input: unknown): Promise<LedgerActionResult<BookingRuleView>> {
  return run(entryIdInputSchema, input, ({ entryId }, access) => ledger().learnRuleFromEntry({ workspaceId: access.workspace.id, entryId }));
}

// Filings and handovers ------------------------------------------------------------------------

export async function createFilingAction(input: unknown): Promise<LedgerActionResult<FilingView>> {
  return run(createFilingInputSchema, input, (filing, access) => ledger().createFiling({ workspaceId: access.workspace.id, userId: access.user.id, filing }));
}

/** "Als eingereicht markieren": from then on the period is locked. */
export async function submitFilingAction(input: unknown): Promise<LedgerActionResult<FilingView>> {
  return run(submitFilingInputSchema, input, (data, access) => ledger().submitFiling({ workspaceId: access.workspace.id, ...data }));
}

/** "Berichtigte Meldung anlegen". */
export async function createCorrectionFilingAction(input: unknown): Promise<LedgerActionResult<FilingView>> {
  return run(filingIdInputSchema, input, ({ filingId }, access) => ledger().createCorrectionFiling({ workspaceId: access.workspace.id, userId: access.user.id, filingId }));
}

/** "An Steuerberaterin übergeben". */
export async function createHandoverAction(input: unknown): Promise<LedgerActionResult<HandoverView>> {
  return run(createHandoverInputSchema, input, (data, access) => ledger().createHandover({ workspaceId: access.workspace.id, userId: access.user.id, ...data }));
}

// The tax advisor's balance lists ------------------------------------------------------------

/** Uploads a DATEV Summen- und Saldenliste (CSV text) for the comparison. */
export async function uploadAdvisorBalancesAction(input: unknown): Promise<LedgerActionResult<AdvisorUploadView>> {
  return run(uploadAdvisorInputSchema, input, (data, access) => ledger().uploadAdvisorBalances({ workspaceId: access.workspace.id, userId: access.user.id, ...data }));
}

export async function deleteAdvisorUploadAction(input: unknown): Promise<LedgerActionResult<undefined>> {
  return run(advisorUploadIdInputSchema, input, async ({ uploadId }, access) => {
    await ledger().deleteAdvisorUpload({ workspaceId: access.workspace.id, uploadId });
    return undefined;
  });
}
