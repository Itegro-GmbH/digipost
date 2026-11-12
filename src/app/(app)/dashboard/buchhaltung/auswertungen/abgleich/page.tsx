import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import type { AccountSheetRow } from "@/modules/ledger";
import { AdvisorComparisonTable, AdvisorUploadForm, AdvisorUploadsList, LedgerTabs, PeriodName, ReportsTabs } from "@/modules/ledger/client";
import {
  getLedgerAccountSheetsProjection,
  getLedgerAdvisorComparisonProjection,
  isLedgerEnabledProjection,
  listLedgerAdvisorUploadsProjection,
} from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";

/** How many differing accounts open to their lines; more is a sign of a wrong period. */
const MAX_EXPANDED_ACCOUNTS = 60;

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * "Abgleich Steuerberaterin" (decisions/0080 acceptance test, UI concept B screen G): upload the
 * tax advisor's Summen- und Saldenliste (DATEV CSV), then compare it account by account with
 * Digipost's own closing balances for the same period. `?upload=` picks one of the caller's own
 * uploads (default the newest), `?nur=abweichungen` hides the equal rows. Admin-only
 * (`finance.read`), uploading and deleting need `finance.manage`; ledger enabled, else
 * `notFound()`.
 */
export default async function LedgerAdvisorPage({ searchParams }: PageProps<"/dashboard/buchhaltung/auswertungen/abgleich">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  if (!(await isLedgerEnabledProjection(workspaceId))) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  const params = await searchParams;
  const [t, uploads] = await Promise.all([getTranslations("Ledger"), listLedgerAdvisorUploadsProjection(workspaceId)]);
  const selected = uploads.find((upload) => upload.id === firstParam(params.upload)) ?? uploads[0] ?? null;
  const onlyDifferences = firstParam(params.nur) === "abweichungen";
  const comparison = selected ? await getLedgerAdvisorComparisonProjection(workspaceId, selected.id) : null;

  const differing = comparison?.comparison.rows.filter((row) => row.differenceCents !== 0) ?? [];
  const sheets =
    comparison && differing.length > 0
      ? await getLedgerAccountSheetsProjection(
          workspaceId,
          differing.slice(0, MAX_EXPANDED_ACCOUNTS).map((row) => row.accountNumber),
          comparison.upload.periodFrom,
          comparison.upload.periodTo,
        )
      : [];
  const sheetLines: Record<string, AccountSheetRow[]> = Object.fromEntries(sheets.map((sheet) => [sheet.account.number, sheet.rows]));
  const allRows = comparison?.comparison.rows ?? [];
  const rows = onlyDifferences ? differing : allRows;

  const today = new Date().toISOString().slice(0, 10);
  const base = selected ? `/dashboard/buchhaltung/auswertungen/abgleich?upload=${selected.id}` : "/dashboard/buchhaltung/auswertungen/abgleich";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("reports.heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("reports.description")}</p>
      </div>
      <ReportsTabs active="abgleich" />

      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
        <p>{t("advisor.intro")}</p>
        <p>{t("advisor.totalsOnly")}</p>
      </div>

      {canManage ? <AdvisorUploadForm defaultFrom={`${today.slice(0, 4)}-01-01`} defaultTo={today} /> : null}

      {uploads.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{t("advisor.noUploads")}</p>
      ) : (
        <AdvisorUploadsList uploads={uploads} selectedId={selected?.id ?? null} canManage={canManage} />
      )}

      {comparison ? (
        <section aria-labelledby="advisor-comparison-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="advisor-comparison-heading" className="text-base font-semibold text-foreground">
                {t("advisor.comparisonHeading")} <PeriodName from={comparison.upload.periodFrom} to={comparison.upload.periodTo} />
              </h2>
              <p className="text-sm text-muted-foreground">
                {comparison.comparison.differenceCount === 0 ? t("advisor.allEqual") : t("advisor.differences", { count: comparison.comparison.differenceCount })}
              </p>
            </div>
            <LedgerTabs
              variant="toggle"
              label={t("advisor.filterLabel")}
              items={[
                { href: base, label: t("advisor.showAll"), active: !onlyDifferences },
                { href: `${base}${base.includes("?") ? "&" : "?"}nur=abweichungen`, label: t("advisor.onlyDifferences"), active: onlyDifferences },
              ]}
            />
          </div>
          <AdvisorComparisonTable rows={rows} sheetLines={sheetLines} sheetQuery={`?von=${comparison.upload.periodFrom}&bis=${comparison.upload.periodTo}`} />
          <p className="text-xs text-muted-foreground">
            {t("advisor.signHint")}{" "}
            <Link href={`/dashboard/buchhaltung/konten?von=${comparison.upload.periodFrom}&bis=${comparison.upload.periodTo}&ansicht=soll-haben`} className="text-foreground underline underline-offset-4">
              {t("advisor.ownList")}
            </Link>
          </p>
        </section>
      ) : null}
    </div>
  );
}
