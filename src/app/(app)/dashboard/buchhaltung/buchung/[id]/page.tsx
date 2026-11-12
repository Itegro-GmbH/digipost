import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";

import { draftCorrectionFilings } from "@/modules/ledger";
import { EntryEditor, OriginPill, RevisionHistory, SourcePanel, StatusPill } from "@/modules/ledger/client";
import { getJournalEntryProjection, getLedgerSourcesProjection, isLedgerEnabledProjection, listLedgerAccountsProjection, listLedgerFilingsProjection } from "@/modules/ledger/server";
import { listTeamProjection } from "@/modules/workspaces/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One journal entry (decisions/0080, UI concepts A and B): what it books on the left (the
 * document and/or bank transaction), the editor on the right, the revision history below.
 * Admin-only (`finance.read`) and only with the ledger enabled, else `notFound()`; an id that
 * is not an entry of the caller's own workspace is `notFound()` too.
 */
export default async function LedgerEntryPage({ params }: PageProps<"/dashboard/buchhaltung/buchung/[id]">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  if (!(await isLedgerEnabledProjection(workspaceId))) notFound();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const entry = await getJournalEntryProjection(workspaceId, id);
  if (!entry) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  const [t, accounts, sources, team, filings] = await Promise.all([
    getTranslations("Ledger"),
    listLedgerAccountsProjection(workspaceId),
    getLedgerSourcesProjection(workspaceId, entry.documentId ? [entry.documentId] : [], entry.transactionId ? [entry.transactionId] : []),
    listTeamProjection(workspaceId),
    listLedgerFilingsProjection(workspaceId),
  ]);
  const document = sources.documents[0] ?? null;
  const transaction = sources.transactions[0] ?? null;
  const users = Object.fromEntries(team.members.map((member) => [member.userId, member.name || member.email]));
  const ruleSubject = document?.contactName ?? transaction?.counterpartyName ?? document?.sender ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/dashboard/buchhaltung/zu-pruefen" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft aria-hidden className="size-3.5" />
          {t("editor.back")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-foreground">{entry.text}</h1>
          <StatusPill status={entry.status} dismissed={entry.dismissed} locked={entry.lockedBy !== null} />
          <OriginPill origin={entry.origin} />
        </div>
        <p className="text-sm text-muted-foreground">{t(entry.summary.key, entry.summary.params)}</p>
        {entry.origin === "ai" && entry.originReason ? (
          <details className="text-sm">
            <summary className="w-fit cursor-pointer text-brand-warm underline-offset-4 hover:underline">{t("queue.why")}</summary>
            <p className="mt-1 text-muted-foreground">{entry.originReason}</p>
          </details>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <aside aria-label={t("source.heading")}>
          <SourcePanel documentId={entry.documentId} document={document} transactionId={entry.transactionId} transaction={transaction} />
        </aside>
        <EntryEditor
          key={entry.revision}
          entry={{
            id: entry.id,
            status: entry.status,
            dismissed: entry.dismissed,
            origin: entry.origin,
            revision: entry.revision,
            bookingDate: entry.bookingDate,
            documentDate: entry.documentDate,
            serviceDate: entry.serviceDate,
            text: entry.text,
            documentId: entry.documentId,
            transactionId: entry.transactionId,
            correctionOfEntryId: entry.correctionOfEntryId,
            filingId: entry.filingId,
            lines: entry.lines,
          }}
          seed="entry"
          accounts={accounts}
          sourceDocument={document}
          sourceTransaction={transaction}
          canManage={canManage}
          lockedBy={entry.lockedBy}
          ruleSubject={ruleSubject}
          correctionFilings={draftCorrectionFilings(filings)}
        />
      </div>

      <RevisionHistory revisions={entry.revisions} currentLines={entry.lines} users={users} />
    </div>
  );
}
