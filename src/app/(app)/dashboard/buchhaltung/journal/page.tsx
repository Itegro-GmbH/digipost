import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { JOURNAL_PAGE_SIZE, journalFilterFor, journalSearch, lockingFilingFor, parseJournalSearchParams } from "@/modules/ledger";
import { JournalFilters, JournalTable } from "@/modules/ledger/client";
import {
  isLedgerEnabledProjection,
  listJournalEntriesProjection,
  listLedgerAccountsProjection,
  listLedgerFilingsProjection,
  listLedgerHandoversProjection,
} from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { buttonVariants } from "@/shared/ui-primitives";

/**
 * The journal (decisions/0080): every entry, booked and proposed, filtered in the URL
 * (`?von=&bis=&status=&herkunft=&konto=&seit=`), `JOURNAL_PAGE_SIZE` at a time with "Mehr
 * laden" (`?anzahl=`). "Geändert seit Übergabe" (`seit`) names one of the caller's own handovers.
 * Admin-only (`finance.read`) and only with the ledger enabled, else `notFound()`.
 */
export default async function LedgerJournalPage({ searchParams }: PageProps<"/dashboard/buchhaltung/journal">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  if (!(await isLedgerEnabledProjection(workspaceId))) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  const values = parseJournalSearchParams(await searchParams);
  const [t, accounts, handovers, filings] = await Promise.all([
    getTranslations("Ledger"),
    listLedgerAccountsProjection(workspaceId),
    listLedgerHandoversProjection(workspaceId),
    listLedgerFilingsProjection(workspaceId),
  ]);
  const handover = handovers.find((candidate) => candidate.id === values.seit) ?? null;
  const filterValues = handover ? values : { ...values, seit: "" };
  const fetched = await listJournalEntriesProjection(workspaceId, journalFilterFor(filterValues, handover?.createdAt ?? null));
  const entries = fetched.slice(0, filterValues.limit);
  const hasMore = fetched.length > filterValues.limit;
  const lockedIds = entries.filter((entry) => entry.status === "booked" && lockingFilingFor(filings, entry.bookingDate)).map((entry) => entry.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("journal.heading")}</h1>
          <p className="text-sm text-muted-foreground">{t("journal.description")}</p>
        </div>
        {canManage ? (
          <Link href="/dashboard/buchhaltung/buchung/neu" className={buttonVariants({ variant: "outline" })}>
            {t("overview.newEntry")}
          </Link>
        ) : null}
      </div>

      <JournalFilters values={filterValues} accounts={accounts} handovers={handovers} />

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{t("journal.empty")}</p>
      ) : (
        <>
          <JournalTable entries={entries} lockedIds={lockedIds} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">{t("journal.shown", { count: entries.length })}</p>
            {hasMore ? (
              <Link href={`/dashboard/buchhaltung/journal${journalSearch(filterValues, { limit: filterValues.limit + JOURNAL_PAGE_SIZE })}`} scroll={false} className={buttonVariants({ variant: "outline" })}>
                {t("journal.loadMore")}
              </Link>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
