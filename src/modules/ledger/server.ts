import "server-only";

/**
 * Public server entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2) of src/modules/ledger
 * (decisions/0080-ledger-double-entry-bookkeeping.md): the read models for
 * `/dashboard/buchhaltung/**`.
 */
export {
  getJournalEntryProjection,
  getLedgerAccountSheetProjection,
  getLedgerAdvisorComparisonProjection,
  getLedgerBalancesProjection,
  getLedgerControlsProjection,
  getLedgerMatchSuggestionsProjection,
  getLedgerOpenItemsProjection,
  getLedgerPeriodOverviewProjection,
  getLedgerSettingsProjection,
  getLedgerVatPreviewProjection,
  isLedgerEnabledProjection,
  listJournalEntriesProjection,
  listLedgerAccountsProjection,
  listLedgerAdvisorUploadsProjection,
  listLedgerFilingsProjection,
  listLedgerHandoversProjection,
  listLedgerOpenItemAccountsProjection,
  listLedgerRulesProjection,
} from "./server/read-models";
