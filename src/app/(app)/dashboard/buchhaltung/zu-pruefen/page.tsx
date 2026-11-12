import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { isQueueFiltered, JOURNAL_ENTRY_ORIGINS, parseQueueSearchParams } from "@/modules/ledger";
import { ReviewQueueClient, SyncProposalsButton, type QueueProblem } from "@/modules/ledger/client";
import {
  getLedgerControlsProjection,
  getLedgerSettingsProjection,
  getLedgerSourcesProjection,
  listJournalEntriesProjection,
} from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { buttonVariants } from "@/shared/ui-primitives";

const SELECT = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/**
 * "Zu prüfen" (decisions/0080, UI concept A): every open proposal grouped by certainty, plus the
 * sources nothing was proposed for ("Probleme": a bank transaction or a document of the period
 * the books do not account for yet, from the controls). Filters live in the URL
 * (`?von=&bis=&herkunft=&nur=warnungen`). Admin-only (`finance.read`) and only with the ledger
 * enabled, else `notFound()`.
 */
export default async function LedgerQueuePage({ searchParams }: PageProps<"/dashboard/buchhaltung/zu-pruefen">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  const settings = await getLedgerSettingsProjection(workspaceId);
  if (!settings.enabled) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  const values = parseQueueSearchParams(await searchParams);
  const todayIso = new Date().toISOString().slice(0, 10);
  const controlsFrom = values.von || settings.startDate || `${todayIso.slice(0, 4)}-01-01`;
  const controlsTo = values.bis || todayIso;

  // Every proposal, dismissed ones included: a source with a dismissed proposal is still a
  // problem (nothing books it), but the row says so.
  const [t, proposals, controls] = await Promise.all([
    getTranslations("Ledger"),
    listJournalEntriesProjection(workspaceId, { status: "proposed", dismissed: "include", limit: 2000 }),
    getLedgerControlsProjection(workspaceId, controlsFrom, controlsTo <= controlsFrom ? controlsFrom : controlsTo),
  ]);

  const open = proposals.filter((entry) => !entry.dismissed);
  const shown = open.filter(
    (entry) =>
      (!values.von || entry.bookingDate >= values.von) &&
      (!values.bis || entry.bookingDate <= values.bis) &&
      (!values.herkunft || entry.origin === values.herkunft) &&
      (!values.nurWarnungen || entry.warnings.length > 0),
  );

  const proposedDocuments = new Set(open.map((entry) => entry.documentId).filter(Boolean));
  const proposedTransactions = new Set(open.map((entry) => entry.transactionId).filter(Boolean));
  const dismissedDocuments = new Set(proposals.filter((entry) => entry.dismissed).map((entry) => entry.documentId));
  const dismissedTransactions = new Set(proposals.filter((entry) => entry.dismissed).map((entry) => entry.transactionId));
  const subjects = (id: string) => controls.find((control) => control.id === id)?.subjects ?? [];
  // "Nur mit Warnung" and an origin filter are about proposals; problems have neither.
  const showProblems = !values.nurWarnungen && !values.herkunft;
  const transactionIds = showProblems ? subjects("unbooked_bank_transactions").filter((id) => !proposedTransactions.has(id)) : [];
  const documentIds = showProblems ? subjects("unbooked_documents").filter((id) => !proposedDocuments.has(id)) : [];
  const sources = await getLedgerSourcesProjection(workspaceId, documentIds, transactionIds);

  const problems: QueueProblem[] = [
    ...sources.transactions.map(
      (transaction): QueueProblem => ({
        kind: "transaction",
        id: transaction.id,
        date: transaction.bookingDate,
        title: transaction.counterpartyName ?? transaction.remittanceText ?? t("queue.problemTransaction"),
        amountCents: transaction.amountCents,
        dismissed: dismissedTransactions.has(transaction.id),
      }),
    ),
    ...sources.documents.map(
      (document): QueueProblem => ({
        kind: "document",
        id: document.id,
        date: document.documentDate ?? document.effectiveDate,
        title: [document.contactName ?? document.sender, document.title].filter(Boolean).join(", ") || document.originalFileName,
        amountCents: document.totalAmountCents,
        dismissed: dismissedDocuments.has(document.id),
      }),
    ),
  ].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("queue.heading")}</h1>
          <p className="text-sm text-muted-foreground">{t("queue.description")}</p>
        </div>
        {canManage ? <SyncProposalsButton from={values.von || undefined} to={values.bis || undefined} /> : null}
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3" aria-label={t("queue.filtersLabel")}>
        <div className="flex flex-col gap-1">
          <label htmlFor="queue-from" className="text-xs text-muted-foreground">
            {t("filters.from")}
          </label>
          <input id="queue-from" type="date" name="von" defaultValue={values.von} className={SELECT} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="queue-to" className="text-xs text-muted-foreground">
            {t("filters.to")}
          </label>
          <input id="queue-to" type="date" name="bis" defaultValue={values.bis} className={SELECT} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="queue-origin" className="text-xs text-muted-foreground">
            {t("filters.origin")}
          </label>
          <select id="queue-origin" name="herkunft" defaultValue={values.herkunft} className={SELECT}>
            <option value="">{t("filters.originAll")}</option>
            {JOURNAL_ENTRY_ORIGINS.map((origin) => (
              <option key={origin} value={origin}>
                {t(`origins.${origin}`)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex h-8 items-center gap-2 text-sm">
          <input type="checkbox" name="nur" value="warnungen" defaultChecked={values.nurWarnungen} />
          {t("filters.onlyWarnings")}
        </label>
        <button type="submit" className={buttonVariants({ variant: "outline" })}>
          {t("filters.apply")}
        </button>
        {isQueueFiltered(values) ? (
          <Link href="/dashboard/buchhaltung/zu-pruefen" className={buttonVariants({ variant: "ghost" })}>
            {t("filters.reset")}
          </Link>
        ) : null}
      </form>

      <ReviewQueueClient entries={shown} problems={problems} canManage={canManage} filtered={isQueueFiltered(values)} />
    </div>
  );
}
