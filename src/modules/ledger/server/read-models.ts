import "server-only";

import { cache } from "react";

import { getRequestServices } from "@/persistence/composition/request-services";
import type { AdvisorComparisonView } from "@/persistence/use-cases/ledger-use-cases";

import type { AccountSheet, BalanceList, OpenItems, Period, VatPreview } from "../core/reports";
import type { BankBalanceComparison, ControlResult } from "../core/controls";
import { ledgerDocumentStatusOf } from "../core/document-status";
import type { ListEntriesFilter } from "../core/schemas";
import type {
  AdvisorUploadView,
  BookingRuleView,
  FilingView,
  HandoverView,
  JournalEntryListItem,
  JournalEntryView,
  LedgerAccountView,
  LedgerDocumentStatus,
  LedgerSettingsView,
  LedgerSourcesView,
  MatchSuggestion,
  OpenItemAccountSummary,
  PeriodOverviewRow,
} from "../core/types";

// Projections for `/dashboard/buchhaltung/**` (decisions/0080-ledger-double-entry-bookkeeping.md).
// `workspaceId` is always the caller's own resolved membership, never client input; the page
// checks `finance.read` and `isLedgerEnabledProjection` before calling any other projection
// (every one but the settings throws `disabled` while the ledger is off).

export const getLedgerSettingsProjection = cache(async (workspaceId: string): Promise<LedgerSettingsView> => {
  return getRequestServices().ledger.getSettings(workspaceId);
});

export const isLedgerEnabledProjection = cache(async (workspaceId: string): Promise<boolean> => {
  return getRequestServices().ledger.isEnabled(workspaceId);
});

export const listLedgerAccountsProjection = cache(async (workspaceId: string): Promise<LedgerAccountView[]> => {
  return getRequestServices().ledger.listAccounts(workspaceId);
});

/** `filter` is compared by reference by `cache()`; pass a fresh object per request. */
export const listJournalEntriesProjection = cache(async (workspaceId: string, filter: ListEntriesFilter): Promise<JournalEntryListItem[]> => {
  return getRequestServices().ledger.listEntries(workspaceId, filter);
});

/** The navigation's "Zu prüfen" badge; only called once the ledger is known to be on. */
export const countLedgerWaitingProposalsProjection = cache(async (workspaceId: string): Promise<number> => {
  return getRequestServices().ledger.countWaitingProposals(workspaceId);
});

/** The documents and bank transactions behind entries (source panel, "Probleme"). Ids come from
 * the caller's own entries or controls; `cache()` compares the arrays by reference. */
export const getLedgerSourcesProjection = cache(async (workspaceId: string, documentIds: readonly string[], transactionIds: readonly string[]): Promise<LedgerSourcesView> => {
  return getRequestServices().ledger.getSources(workspaceId, { documentIds, transactionIds });
});

export const getJournalEntryProjection = cache(async (workspaceId: string, entryId: string): Promise<JournalEntryView | null> => {
  return getRequestServices().ledger.getEntry(workspaceId, entryId);
});

export const getLedgerBalancesProjection = cache(async (workspaceId: string, from: string, to: string): Promise<BalanceList> => {
  return getRequestServices().ledger.getBalances(workspaceId, { from, to });
});

/** Proposals are listed; they count toward the balance only with `countProposals`. */
export const getLedgerAccountSheetProjection = cache(
  async (workspaceId: string, accountNumber: string, from: string, to: string, countProposals = false): Promise<AccountSheet | null> => {
    return getRequestServices().ledger.getAccountSheet(workspaceId, { accountNumber, from, to, countProposals });
  },
);

/** Booked-only sheets of several accounts in one read; `cache()` compares the array by reference. */
export const getLedgerAccountSheetsProjection = cache(async (workspaceId: string, accountNumbers: readonly string[], from: string, to: string): Promise<AccountSheet[]> => {
  return getRequestServices().ledger.getAccountSheets(workspaceId, { accountNumbers, from, to });
});

/** Per bank ledger account: matches the real bank balance up to `to`, or from which day it does not. */
export const getLedgerBankComparisonsProjection = cache(async (workspaceId: string, from: string, to: string): Promise<BankBalanceComparison[]> => {
  return getRequestServices().ledger.getBankComparisons(workspaceId, { from, to });
});

/**
 * The ledger's status of one document for the document page (decisions/0080 UI): `null` while
 * the ledger is off. The caller checks `finance.read` first (an entry's accounts and amounts are
 * finance information); `documentId` is the page's own document, already found in the caller's
 * workspace, and is only matched against that workspace's entries.
 */
export const getLedgerDocumentStatusProjection = cache(async (workspaceId: string, documentId: string): Promise<LedgerDocumentStatus | null> => {
  const ledger = getRequestServices().ledger;
  if (!(await ledger.isEnabled(workspaceId))) return null;
  const [entries, filings] = await Promise.all([ledger.listEntries(workspaceId, { documentId, dismissed: "include", limit: 20 }), ledger.listFilings(workspaceId)]);
  return ledgerDocumentStatusOf(entries, filings);
});

export const getLedgerOpenItemsProjection = cache(
  async (workspaceId: string, accountNumber: string, asOf: string): Promise<(OpenItems & { account: LedgerAccountView }) | null> => {
    return getRequestServices().ledger.getOpenItems(workspaceId, { accountNumber, asOf });
  },
);

export const listLedgerOpenItemAccountsProjection = cache(async (workspaceId: string, asOf: string): Promise<OpenItemAccountSummary[]> => {
  return getRequestServices().ledger.listOpenItemAccounts(workspaceId, asOf);
});

export const getLedgerVatPreviewProjection = cache(async (workspaceId: string, from: string, to: string): Promise<VatPreview> => {
  return getRequestServices().ledger.getVatPreview(workspaceId, { from, to } satisfies Period);
});

export const getLedgerControlsProjection = cache(async (workspaceId: string, from: string, to: string): Promise<ControlResult[]> => {
  return getRequestServices().ledger.getControls(workspaceId, { from, to });
});

export const getLedgerPeriodOverviewProjection = cache(async (workspaceId: string, year: number): Promise<PeriodOverviewRow[]> => {
  return getRequestServices().ledger.getPeriodOverview(workspaceId, year);
});

export const listLedgerRulesProjection = cache(async (workspaceId: string): Promise<BookingRuleView[]> => {
  return getRequestServices().ledger.listRules(workspaceId);
});

export const listLedgerFilingsProjection = cache(async (workspaceId: string): Promise<FilingView[]> => {
  return getRequestServices().ledger.listFilings(workspaceId);
});

export const listLedgerHandoversProjection = cache(async (workspaceId: string): Promise<HandoverView[]> => {
  return getRequestServices().ledger.listHandovers(workspaceId);
});

export const listLedgerAdvisorUploadsProjection = cache(async (workspaceId: string): Promise<AdvisorUploadView[]> => {
  return getRequestServices().ledger.listAdvisorUploads(workspaceId);
});

export const getLedgerAdvisorComparisonProjection = cache(async (workspaceId: string, uploadId: string): Promise<AdvisorComparisonView | null> => {
  return getRequestServices().ledger.getAdvisorComparison(workspaceId, uploadId);
});

/** Candidate groups for the open items of one account (decisions/0080 phase 4, never applied by
 * themselves). `accountId` is looked up within the caller's workspace only. */
export const getLedgerMatchSuggestionsProjection = cache(async (workspaceId: string, accountId: string): Promise<MatchSuggestion[]> => {
  return getRequestServices().ledger.suggestMatches(workspaceId, accountId);
});
