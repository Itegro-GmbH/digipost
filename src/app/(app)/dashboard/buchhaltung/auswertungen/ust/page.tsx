import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Lock } from "lucide-react";

import { lockingFilingFor, startedVatPeriods, vatKennzahlenOfEntry, vatPeriodOf, type VatKennzahl } from "@/modules/ledger";
import { PeriodName, PeriodSelect, ReportsTabs, VatPreviewView, type VatEntryRef } from "@/modules/ledger/client";
import {
  getLedgerSettingsProjection,
  getLedgerVatPreviewProjection,
  isLedgerEnabledProjection,
  listJournalEntriesProjection,
  listLedgerFilingsProjection,
} from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { buttonVariants, Label } from "@/shared/ui-primitives";

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * "USt-VA" (decisions/0080 UI concept B, screen F): the preview of one USt-VA period
 * (`?zeitraum=2026-07` or `2026-Q3`, default the current one) from the booked entries, per
 * Kennzahl with the entries behind it, and which taxation basis it follows. Admin-only
 * (`finance.read`) and only with the ledger enabled, else `notFound()`.
 */
export default async function LedgerVatPage({ searchParams }: PageProps<"/dashboard/buchhaltung/auswertungen/ust">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  if (!(await isLedgerEnabledProjection(workspaceId))) notFound();

  const today = new Date().toISOString().slice(0, 10);
  const [t, settings, filings, params] = await Promise.all([getTranslations("Ledger"), getLedgerSettingsProjection(workspaceId), listLedgerFilingsProjection(workspaceId), searchParams]);
  const periods = startedVatPeriods(settings, today);
  const requested = firstParam(params.zeitraum);
  const period = periods.find((candidate) => candidate.key === requested) ?? periods[0] ?? vatPeriodOf(today, settings.vatPeriod);

  const [preview, booked, proposed] = await Promise.all([
    getLedgerVatPreviewProjection(workspaceId, period.from, period.to),
    listJournalEntriesProjection(workspaceId, { from: period.from, to: period.to, status: "booked", limit: 2000 }),
    listJournalEntriesProjection(workspaceId, { from: period.from, to: period.to, status: "proposed", limit: 2000 }),
  ]);
  const entriesByKennzahl: Partial<Record<VatKennzahl, VatEntryRef[]>> = {};
  for (const entry of [...booked].reverse()) {
    for (const kennzahl of vatKennzahlenOfEntry(entry.lines)) {
      (entriesByKennzahl[kennzahl] ??= []).push({ id: entry.id, bookingDate: entry.bookingDate, text: entry.text, totalCents: entry.totalCents });
    }
  }
  const submitted = filings.find((filing) => filing.kind === "vat_return" && filing.status === "submitted" && filing.periodFrom === period.from && filing.periodTo === period.to) ?? lockingFilingFor(filings, period.to);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("reports.heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("reports.description")}</p>
      </div>
      <ReportsTabs active="ust" />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="vat-period" className="text-xs text-muted-foreground">
              {t("vat.period")}
            </Label>
            <PeriodSelect id="vat-period" name="zeitraum" periods={periods} value={period.key} />
          </div>
          <button type="submit" className={buttonVariants({ variant: "outline" })}>
            {t("filters.show")}
          </button>
        </form>
        {submitted ? (
          <Link href="/dashboard/buchhaltung/auswertungen/zeitraeume" className="inline-flex items-center gap-1.5 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
            <Lock aria-hidden className="size-3" />
            {t("vat.submitted", { date: new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(`${submitted.submittedOn ?? today}T00:00:00`)) })}
          </Link>
        ) : (
          <Link href="/dashboard/buchhaltung/auswertungen/zeitraeume" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
            {t("vat.notSubmitted")}
          </Link>
        )}
      </div>

      <section aria-labelledby="vat-heading" className="flex flex-col gap-3">
        <h2 id="vat-heading" className="text-base font-semibold text-foreground">
          {t("vat.heading")} <PeriodName from={period.from} to={period.to} />
        </h2>
        <VatPreviewView preview={preview} entriesByKennzahl={entriesByKennzahl} />
      </section>

      <div className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
        <p className="font-medium text-foreground">{t("vat.basisHeading", { basis: t(`vatBases.${settings.vatBasis}`) })}</p>
        <p className="text-muted-foreground">{t(settings.vatBasis === "ist" ? "vat.basisIstNotApplied" : "vat.basisSoll")}</p>
        {proposed.length > 0 ? (
          <p className="text-muted-foreground">
            {t("vat.proposalsMissing", { count: proposed.length })}{" "}
            <Link href={`/dashboard/buchhaltung/zu-pruefen?von=${period.from}&bis=${period.to}`} className="text-foreground underline underline-offset-4">
              {t("vat.reviewProposals")}
            </Link>
          </p>
        ) : null}
        <Link href="/dashboard/buchhaltung/einstellungen" className="w-fit text-foreground underline underline-offset-4">
          {t("vat.changeBasis")}
        </Link>
      </div>
    </div>
  );
}
