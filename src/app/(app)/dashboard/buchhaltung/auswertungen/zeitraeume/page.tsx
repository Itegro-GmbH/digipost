import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { yearPeriod, type FilingKind, type FilingView, type HandoverView } from "@/modules/ledger";
import { PeriodsClient, ReportsTabs, type FilingPeriodView } from "@/modules/ledger/client";
import {
  getLedgerPeriodOverviewProjection,
  getLedgerSettingsProjection,
  getLedgerVatPreviewProjection,
  isLedgerEnabledProjection,
  listLedgerFilingsProjection,
  listLedgerHandoversProjection,
} from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { buttonVariants } from "@/shared/ui-primitives";

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function newest<T extends { createdAt: string }>(items: readonly T[]): T | null {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/** The filings of one period and kind: the newest submitted one, the original it corrects, and a
 * draft waiting for submission. */
function filingsOf(filings: readonly FilingView[], kind: FilingKind, from: string, to: string): Pick<FilingPeriodView, "submitted" | "original" | "draft"> {
  const own = filings.filter((filing) => filing.kind === kind && filing.periodFrom === from && filing.periodTo === to);
  const submitted = own.filter((filing) => filing.status === "submitted");
  return {
    submitted: newest(submitted),
    original: submitted.find((filing) => filing.correctsFilingId === null) ?? null,
    draft: newest(own.filter((filing) => filing.status === "draft")),
  };
}

function handoverOf(handovers: readonly HandoverView[], from: string, to: string): FilingPeriodView["handover"] {
  const latest = newest(handovers.filter((handover) => handover.periodFrom <= from && handover.periodTo >= to));
  return latest ? { id: latest.id, createdAt: latest.createdAt, changesSince: latest.changesSince, note: latest.note } : null;
}

/**
 * "Zeiträume und Meldungen" (decisions/0080 UI concept C): the year's USt-VA periods (`?jahr=`,
 * default the current year) with status, handover and filing, and the annual statement.
 * Marking a filing as submitted locks its period's booked entries (the database enforces it).
 * Admin-only (`finance.read`), every action needs `finance.manage`; ledger enabled, else
 * `notFound()`.
 */
export default async function LedgerPeriodsPage({ searchParams }: PageProps<"/dashboard/buchhaltung/auswertungen/zeitraeume">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  if (!(await isLedgerEnabledProjection(workspaceId))) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  const today = new Date().toISOString().slice(0, 10);
  const currentYear = Number(today.slice(0, 4));
  const [t, settings, filings, handovers, params] = await Promise.all([
    getTranslations("Ledger"),
    getLedgerSettingsProjection(workspaceId),
    listLedgerFilingsProjection(workspaceId),
    listLedgerHandoversProjection(workspaceId),
    searchParams,
  ]);
  const startYear = Math.min(Number((settings.startDate ?? today).slice(0, 4)), currentYear);
  const requested = Number.parseInt(firstParam(params.jahr), 10);
  const year = Number.isFinite(requested) && requested >= startYear && requested <= currentYear ? requested : currentYear;
  const years = Array.from({ length: currentYear - startYear + 1 }, (_, index) => currentYear - index);

  const overview = await getLedgerPeriodOverviewProjection(workspaceId, year);
  const started = overview.filter((row) => row.from <= today && (!settings.startDate || row.to >= settings.startDate));
  const previews = await Promise.all(
    started.map((row) => (row.submittedFilingId ? Promise.resolve(null) : getLedgerVatPreviewProjection(workspaceId, row.from, row.to))),
  );

  const periods: FilingPeriodView[] = started
    .map((row, index) => ({
      key: row.key,
      kind: "vat_return" as const,
      from: row.from,
      to: row.to,
      status: row.status,
      bookedCount: row.bookedCount,
      proposedCount: row.proposedCount,
      previewPayableCents: previews[index]?.payableCents ?? null,
      handover: handoverOf(handovers, row.from, row.to),
      ...filingsOf(filings, "vat_return", row.from, row.to),
    }))
    .reverse();
  const whole = yearPeriod(year);
  const annual: FilingPeriodView = {
    key: whole.key,
    kind: "annual_statement",
    from: whole.from,
    to: whole.to,
    status: null,
    bookedCount: overview.reduce((sum, row) => sum + row.bookedCount, 0),
    proposedCount: overview.reduce((sum, row) => sum + row.proposedCount, 0),
    previewPayableCents: null,
    handover: null,
    ...filingsOf(filings, "annual_statement", whole.from, whole.to),
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("reports.heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("reports.description")}</p>
      </div>
      <ReportsTabs active="zeitraeume" />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex max-w-prose flex-col gap-1 text-sm text-muted-foreground">
          <p>{t("filing.intro")}</p>
          <p>{t(settings.vatPeriod === "quarter" ? "overview.periodsHintQuarter" : "overview.periodsHintMonth")}</p>
        </div>
        {years.length > 1 ? (
          <form method="get" className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="periods-year" className="text-xs text-muted-foreground">
                {t("overview.year")}
              </label>
              <select id="periods-year" name="jahr" defaultValue={String(year)} className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none dark:bg-input/30">
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

      <PeriodsClient periods={periods} annual={annual} today={today} canManage={canManage} />
    </div>
  );
}
