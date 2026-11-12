import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";

import { firstOpenDate } from "@/modules/ledger";
import { EntryEditor, SourcePanel, type EditorEntry, type EditorSeed } from "@/modules/ledger/client";
import {
  getJournalEntryProjection,
  getLedgerSourcesProjection,
  isLedgerEnabledProjection,
  listLedgerAccountsProjection,
  listLedgerFilingsProjection,
} from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(value: string | string[] | undefined): string | null {
  const text = Array.isArray(value) ? value[0] : value;
  return text && UUID.test(text) ? text : null;
}

function formatDate(isoDate: string): string {
  return new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(`${isoDate}T00:00:00`));
}

/**
 * A new entry (decisions/0080): empty (a manual entry such as the share capital), from a
 * document (`?beleg=`) or a bank transaction (`?umsatz=`) nothing was proposed for, or as the
 * correction of an entry a filing locks (`?korrektur=`: its lines reversed, dated in the first
 * period no submitted filing locks). Writing needs `finance.manage`, so without it this page is
 * `notFound()`, like a disabled ledger. Ids are only ever looked up within the caller's
 * workspace; one that is not found there is ignored or `notFound()`.
 */
export default async function NewLedgerEntryPage({ searchParams }: PageProps<"/dashboard/buchhaltung/buchung/neu">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeManage)) notFound();
  const workspaceId = access.workspace.id;
  if (!(await isLedgerEnabledProjection(workspaceId))) notFound();

  const params = await searchParams;
  const documentId = uuidParam(params.beleg);
  const transactionId = uuidParam(params.umsatz);
  const correctionOfId = uuidParam(params.korrektur);

  const [t, accounts] = await Promise.all([getTranslations("Ledger"), listLedgerAccountsProjection(workspaceId)]);
  const todayIso = new Date().toISOString().slice(0, 10);

  let seed: EditorSeed = "entry";
  let entry: EditorEntry = {
    id: null,
    status: null,
    dismissed: false,
    origin: "manual",
    revision: 0,
    bookingDate: "",
    documentDate: null,
    serviceDate: null,
    text: "",
    documentId: null,
    transactionId: null,
    correctionOfEntryId: null,
    filingId: null,
    lines: [],
  };
  let heading = t("editor.headingNew");

  if (correctionOfId) {
    const [original, filings] = await Promise.all([getJournalEntryProjection(workspaceId, correctionOfId), listLedgerFilingsProjection(workspaceId)]);
    if (!original) notFound();
    seed = "reverse";
    heading = t("editor.headingCorrection");
    entry = {
      ...entry,
      bookingDate: firstOpenDate(filings, original.bookingDate),
      documentDate: original.documentDate,
      text: t("editor.correctionText", { text: original.text, date: formatDate(original.bookingDate) }).slice(0, 500),
      documentId: original.documentId,
      correctionOfEntryId: original.id,
      lines: original.lines,
    };
  } else if (documentId) {
    seed = "document";
    entry = { ...entry, documentId };
  } else if (transactionId) {
    seed = "transaction";
    entry = { ...entry, transactionId };
  }

  const sources = await getLedgerSourcesProjection(workspaceId, entry.documentId ? [entry.documentId] : [], entry.transactionId ? [entry.transactionId] : []);
  const document = sources.documents[0] ?? null;
  const transaction = sources.transactions[0] ?? null;
  // A source id that is not in this workspace (or no longer exists) is not linked at all.
  if (seed === "document" && !document) entry = { ...entry, documentId: null };
  if (seed === "transaction" && !transaction) entry = { ...entry, transactionId: null };
  if (seed === "entry" && !entry.bookingDate) entry = { ...entry, bookingDate: todayIso };
  const ruleSubject = seed === "reverse" ? null : (document?.contactName ?? transaction?.counterpartyName ?? document?.sender ?? null);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/dashboard/buchhaltung/zu-pruefen" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft aria-hidden className="size-3.5" />
          {t("editor.back")}
        </Link>
        <h1 className="text-xl font-semibold text-foreground">{heading}</h1>
        {seed === "reverse" ? <p className="text-sm text-muted-foreground">{t("editor.correctionNote")}</p> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <aside aria-label={t("source.heading")}>
          <SourcePanel documentId={entry.documentId} document={document} transactionId={entry.transactionId} transaction={transaction} />
        </aside>
        <EntryEditor
          entry={entry}
          seed={(seed === "document" && !document) || (seed === "transaction" && !transaction) ? "entry" : seed}
          accounts={accounts}
          sourceDocument={document}
          sourceTransaction={transaction}
          canManage
          lockedBy={null}
          ruleSubject={ruleSubject}
        />
      </div>
    </div>
  );
}
