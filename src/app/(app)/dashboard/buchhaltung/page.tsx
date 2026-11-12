import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowRight, CircleCheck, Scale, TriangleAlert } from "lucide-react";

import { vatPeriodOf, type ControlId, type ControlResult, type PeriodOverviewRow } from "@/modules/ledger";
import { LedgerEnableCard, PeriodName, PeriodStatusPill, SyncProposalsButton } from "@/modules/ledger/client";
import {
  countLedgerWaitingProposalsProjection,
  getLedgerControlsProjection,
  getLedgerPeriodOverviewProjection,
  getLedgerSettingsProjection,
  getLedgerVatPreviewProjection,
  listLedgerOpenItemAccountsProjection,
} from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { buttonVariants } from "@/shared/ui-primitives";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat("de", { style: "currency", currency: "EUR" }).format(cents / 100);
}

function formatDate(isoDate: string): string {
  return new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(`${isoDate.slice(0, 10)}T00:00:00`));
}

/** Where a failing check is fixed: the review queue, the accounts page or the comparison with
 * the tax advisor. */
function controlHref(id: ControlId, row: Pick<PeriodOverviewRow, "from" | "to">): string {
  const period = `von=${row.from}&bis=${row.to}`;
  switch (id) {
    case "unbooked_bank_transactions":
    case "unbooked_documents":
    case "proposals_waiting":
    case "unbalanced_entries":
      return `/dashboard/buchhaltung/zu-pruefen?${period}`;
    case "bank_matches_statement":
    case "open_item_accounts":
      return `/dashboard/buchhaltung/konten?${period}`;
    case "advisor_differences":
      return "/dashboard/buchhaltung/auswertungen/abgleich";
  }
}

/**
 * "Buchhaltung", the ledger's overview (decisions/0080-ledger-double-entry-bookkeeping.md, spec
 * section 5): proposals waiting, the year's USt-VA periods with their derived status and the
 * checks still failing, and three quick answers (does the bank match, are the open-item
 * accounts settled, what does the current USt-VA come to). Admin-only (`finance.read`, else
 * `notFound()`, decisions/0027). While the ledger is off, an admin sees the "Buchhaltung
 * aktivieren" card instead. The year is `?jahr=` (absent or malformed: the current year).
 */
export default async function LedgerOverviewPage({ searchParams }: PageProps<"/dashboard/buchhaltung">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);
  const workspaceId = access.workspace.id;

  const [t, settings] = await Promise.all([getTranslations("Ledger"), getLedgerSettingsProjection(workspaceId)]);
  const todayIso = new Date().toISOString().slice(0, 10);
  const currentYear = Number(todayIso.slice(0, 4));

  if (!settings.enabled) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("overview.heading")}</h1>
          <p className="text-sm text-muted-foreground">{t("overview.disabledDescription")}</p>
        </div>
        <LedgerEnableCard defaultStartDate={`${currentYear}-01-01`} canManage={canManage} />
      </div>
    );
  }

  const params = await searchParams;
  const startYear = Number((settings.startDate ?? todayIso).slice(0, 4));
  const requestedYear = Number.parseInt(firstParam(params.jahr) ?? "", 10);
  const year = Number.isFinite(requestedYear) && requestedYear >= startYear && requestedYear <= currentYear ? requestedYear : currentYear;
  const current = vatPeriodOf(todayIso, settings.vatPeriod);

  const [overview, waiting, controls, openItemAccounts, vat] = await Promise.all([
    getLedgerPeriodOverviewProjection(workspaceId, year),
    countLedgerWaitingProposalsProjection(workspaceId),
    getLedgerControlsProjection(workspaceId, current.from, current.to),
    listLedgerOpenItemAccountsProjection(workspaceId, todayIso),
    getLedgerVatPreviewProjection(workspaceId, current.from, current.to),
  ]);

  // Periods that have started and do not end before the ledger's start date, newest first.
  const periods = overview.filter((row) => row.from <= todayIso && (!settings.startDate || row.to >= settings.startDate)).reverse();
  const bank = controls.find((control) => control.id === "bank_matches_statement");
  const notZero = openItemAccounts.filter((summary) => summary.status !== "zero");
  const explained = notZero.filter((summary) => summary.status === "explained").length;
  const years = Array.from({ length: currentYear - startYear + 1 }, (_, index) => currentYear - index);

  const controlMessage = (control: ControlResult) => {
    const values = { ...control.message.params };
    if (typeof values.date === "string" && values.date) values.date = formatDate(values.date);
    return t(control.message.key, values);
  };

  function bankAnswer() {
    if (bank?.status === "ok") {
      return (
        <p className="inline-flex items-center gap-1.5 font-medium text-brand-positive">
          <CircleCheck aria-hidden className="size-4" />
          {t("overview.bankYes")}
        </p>
      );
    }
    if (bank?.status === "failed") {
      return (
        <p className="inline-flex items-center gap-1.5 font-medium text-destructive">
          <TriangleAlert aria-hidden className="size-4" />
          {t("overview.bankNo")}
        </p>
      );
    }
    return <p className="font-medium text-muted-foreground">{t("overview.bankUnknown")}</p>;
  }

  /** One line per period: every check passes, nothing is booked yet, or links to what fails. */
  function periodSummary(row: PeriodOverviewRow) {
    if (row.failingControls.length === 0) return row.bookedCount > 0 ? t("overview.allChecksOk") : t("overview.nothingBooked");
    return (
      <>
        {t("overview.stillOpen")}{" "}
        {row.failingControls.map((id, index) => (
          <span key={id}>
            {index > 0 ? ", " : null}
            <Link href={controlHref(id, row)} className="text-foreground underline underline-offset-4">
              {t(`overview.checkShort.${id}`)}
            </Link>
          </span>
        ))}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("overview.heading")}</h1>
          <p className="text-sm text-muted-foreground">{t("overview.description")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage ? (
            <Link href="/dashboard/buchhaltung/buchung/neu" className={buttonVariants({ variant: "outline" })}>
              {t("overview.newEntry")}
            </Link>
          ) : null}
          <Link href="/dashboard/buchhaltung/journal" className={buttonVariants({ variant: "ghost" })}>
            {t("overview.journal")}
          </Link>
        </div>
      </div>

      <section aria-labelledby="ledger-waiting" className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="flex flex-col gap-1">
          <h2 id="ledger-waiting" className="font-medium text-foreground">
            {waiting > 0 ? t("overview.waiting", { count: waiting }) : t("overview.noneWaiting")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("overview.waitingHint")}</p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {waiting > 0 ? (
            <Link href="/dashboard/buchhaltung/zu-pruefen" className={buttonVariants()}>
              {t("overview.reviewNow")}
              <ArrowRight aria-hidden />
            </Link>
          ) : null}
          {canManage ? <SyncProposalsButton /> : null}
        </div>
      </section>

      <section aria-labelledby="ledger-tiles" className="flex flex-col gap-2">
        <h2 id="ledger-tiles" className="sr-only">
          {t("overview.tilesHeading")}
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          <Link href="/dashboard/buchhaltung/konten" className="flex flex-col gap-1 rounded-lg border border-border p-4 hover:bg-muted">
            <p className="text-sm text-muted-foreground">{t("overview.bankTile")}</p>
            {bankAnswer()}
            {bank ? <p className="text-xs text-muted-foreground">{controlMessage(bank)}</p> : null}
          </Link>
          <Link href="/dashboard/buchhaltung/konten" className="flex flex-col gap-1 rounded-lg border border-border p-4 hover:bg-muted">
            <p className="text-sm text-muted-foreground">{t("overview.openItemsTile")}</p>
            <p className={notZero.length - explained > 0 ? "inline-flex items-center gap-1.5 font-medium text-destructive" : "inline-flex items-center gap-1.5 font-medium text-foreground"}>
              {notZero.length - explained > 0 ? <TriangleAlert aria-hidden className="size-4" /> : <Scale aria-hidden className="size-4" />}
              {t("overview.openItemsValue", { count: notZero.length })}
            </p>
            {explained > 0 ? <p className="text-xs text-muted-foreground">{t("overview.openItemsExplained", { count: explained })}</p> : null}
          </Link>
          <Link href={`/dashboard/buchhaltung/auswertungen/ust?zeitraum=${current.key}`} className="flex flex-col gap-1 rounded-lg border border-border p-4 hover:bg-muted">
            <p className="text-sm text-muted-foreground">
              {t("overview.vatTile")} <PeriodName from={current.from} to={current.to} />
            </p>
            <p className="font-medium tabular-nums text-foreground">
              {t(vat.payableCents >= 0 ? "overview.vatPayable" : "overview.vatRefund", { amount: formatCents(Math.abs(vat.payableCents)) })}
            </p>
            <p className="text-xs text-muted-foreground">{t("overview.vatHint")}</p>
          </Link>
        </div>
      </section>

      <section aria-labelledby="ledger-periods" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="ledger-periods" className="text-base font-semibold text-foreground">
              {t("overview.periodsHeading", { year })}
            </h2>
            <p className="text-sm text-muted-foreground">{t(settings.vatPeriod === "quarter" ? "overview.periodsHintQuarter" : "overview.periodsHintMonth")}</p>
          </div>
          {years.length > 1 ? (
            <form method="get" className="flex items-end gap-2">
              <div className="flex flex-col gap-1">
                <label htmlFor="ledger-year" className="text-xs text-muted-foreground">
                  {t("overview.year")}
                </label>
                <select id="ledger-year" name="jahr" defaultValue={String(year)} className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none dark:bg-input/30">
                  {years.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className={buttonVariants({ variant: "outline" })}>
                {t("filters.show")}
              </button>
            </form>
          ) : null}
        </div>

        {periods.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("overview.noPeriods")}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {periods.map((row) => (
              <li key={row.key} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/dashboard/buchhaltung/journal?von=${row.from}&bis=${row.to}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                      <PeriodName from={row.from} to={row.to} />
                    </Link>
                    <PeriodStatusPill status={row.status} />
                    {row.status === "handed_over" || row.changesSince > 0 ? <span className="text-xs text-muted-foreground">{t("periodChangesSince", { count: row.changesSince })}</span> : null}
                  </div>
                  <p className="text-sm text-muted-foreground">{periodSummary(row)}</p>
                </div>
                <p className="shrink-0 text-xs text-muted-foreground tabular-nums">{t("overview.counts", { booked: row.bookedCount, proposed: row.proposedCount })}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="flex flex-col gap-1 rounded-lg border border-border p-4">
        <Link href="/dashboard/abschluss" className="w-fit font-medium text-foreground underline underline-offset-4">
          {t("overview.closingLink")}
        </Link>
        <p className="text-sm text-muted-foreground">{t("overview.closingHint")}</p>
      </div>
    </div>
  );
}
