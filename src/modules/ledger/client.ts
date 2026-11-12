"use client";

// Public client entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2) of src/modules/ledger
// (decisions/0080-ledger-double-entry-bookkeeping.md): the components the
// `/dashboard/buchhaltung/**` pages render.
export { AccountTag } from "./ui/account-tag";
export { EntryEditor, type EditorEntry, type EditorSeed } from "./ui/entry-editor";
export { EntryLinesTable } from "./ui/entry-lines-table";
export { JournalFilters } from "./ui/journal-filters";
export { JournalTable } from "./ui/journal-table";
export { LedgerEnableCard } from "./ui/ledger-enable-card";
export { PeriodName } from "./ui/period-name";
export { OriginPill, PeriodStatusPill, StatusPill } from "./ui/pills";
export { ReviewQueueClient } from "./ui/review-queue-client";
export type { QueueProblem } from "./ui/queue-model";
export { RevisionHistory } from "./ui/revision-history";
export { SourcePanel } from "./ui/source-panel";
export { SyncProposalsButton } from "./ui/sync-proposals-button";
export { AccountSheetTable } from "./ui/account-sheet-table";
export { AdvisorComparisonTable, AdvisorUploadForm, AdvisorUploadsList } from "./ui/advisor-comparison";
export { AccountStatusBadge, BalanceListView } from "./ui/balance-list";
export { ChartSettings, type OwnerOption } from "./ui/chart-settings";
export { DocumentLedgerCard } from "./ui/document-ledger-card";
export { LedgerTabs, type LedgerTabItem } from "./ui/ledger-tabs";
export { OpenItemsClient, type OpenItemLineView, type OpenItemMatchGroupView, type OpenItemSuggestionView } from "./ui/open-items-client";
export { FilingConfirmCard, PeriodsClient, type FilingPeriodView, type PeriodHandoverView } from "./ui/periods-client";
export { PeriodSelect } from "./ui/period-select";
export { RuleForm, RulesSettings, type RuleContactOption } from "./ui/rules-settings";
export { ReportsTabs, SettingsTabs, type ReportTab, type SettingsTab } from "./ui/section-tabs";
export { SettingsGeneralForm } from "./ui/settings-general";
export { VatPreviewView, type VatEntryRef } from "./ui/vat-preview-view";
export { TaxBackfillCard, type TaxBackfillAction } from "./ui/tax-backfill-card";
