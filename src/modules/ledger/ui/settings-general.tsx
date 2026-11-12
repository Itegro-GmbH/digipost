"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";

import { Button, Input, Label } from "@/shared/ui-primitives";

import { saveLedgerSettingsAction, syncLedgerChartAction } from "../actions";
import type { LedgerActionErrorCode } from "../core/error-codes";
import type { LedgerSettingsView, VatBasis, VatPeriod } from "../core/types";

/**
 * "Einstellungen > Allgemein" (decisions/0080 spec section 5): start date, USt-VA period and
 * taxation basis; "Kontenplan aktualisieren" (new bank and clearing accounts get their ledger
 * account); and turning the ledger off again, behind an inline confirmation. Turning it off
 * keeps every entry: the books are only hidden until it is turned on again.
 */
export function SettingsGeneralForm({ settings, canManage }: { settings: LedgerSettingsView; canManage: boolean }) {
  const t = useTranslations("Ledger");
  const router = useRouter();
  const [startDate, setStartDate] = useState(settings.startDate ?? "");
  const [vatPeriod, setVatPeriod] = useState<VatPeriod>(settings.vatPeriod);
  const [vatBasis, setVatBasis] = useState<VatBasis>(settings.vatBasis);
  const [errorCode, setErrorCode] = useState<LedgerActionErrorCode | null>(null);
  const [saved, setSaved] = useState(false);
  const [chartResult, setChartResult] = useState<number | null>(null);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [pending, startTransition] = useTransition();

  function save(event: React.FormEvent) {
    event.preventDefault();
    setErrorCode(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveLedgerSettingsAction({ enabled: true, vatPeriod, vatBasis, startDate: startDate || null });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  function syncChart() {
    setErrorCode(null);
    setChartResult(null);
    startTransition(async () => {
      const result = await syncLedgerChartAction();
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      setChartResult(result.data.accountCount);
      router.refresh();
    });
  }

  function disable() {
    setErrorCode(null);
    startTransition(async () => {
      const result = await saveLedgerSettingsAction({ enabled: false, vatPeriod: settings.vatPeriod, vatBasis: settings.vatBasis, startDate: settings.startDate });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      router.push("/dashboard/buchhaltung");
      router.refresh();
    });
  }

  const radio = <T extends string>(name: string, value: T, current: T, set: (value: T) => void, label: string, hint: string) => (
    <label className="flex cursor-pointer gap-2 rounded-lg border border-border p-3 has-checked:border-ring has-checked:bg-muted/50">
      <input type="radio" name={name} value={value} checked={current === value} disabled={!canManage} onChange={() => set(value)} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={save} className="flex flex-col gap-5 rounded-lg border border-border p-4" aria-labelledby="settings-general-heading">
        <h2 id="settings-general-heading" className="font-medium text-foreground">
          {t("settings.generalHeading")}
        </h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-start-date">{t("enable.startDate")}</Label>
          <Input id="settings-start-date" type="date" required value={startDate} disabled={!canManage} onChange={(event) => setStartDate(event.target.value)} className="w-fit" aria-describedby="settings-start-date-hint" />
          <p id="settings-start-date-hint" className="text-xs text-muted-foreground">
            {t("enable.startDateHint")}
          </p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium text-foreground">{t("enable.vatPeriod")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {radio("vatPeriod", "month", vatPeriod, setVatPeriod, t("enable.month"), t("enable.monthHint"))}
            {radio("vatPeriod", "quarter", vatPeriod, setVatPeriod, t("enable.quarter"), t("enable.quarterHint"))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium text-foreground">{t("enable.vatBasis")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {radio("vatBasis", "soll", vatBasis, setVatBasis, t("enable.soll"), t("enable.sollHint"))}
            {radio("vatBasis", "ist", vatBasis, setVatBasis, t("enable.ist"), t("enable.istHint"))}
          </div>
          {vatBasis === "ist" ? <p className="text-xs text-brand-warm">{t("settings.istNotApplied")}</p> : null}
        </fieldset>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {t("settings.save")}
            </Button>
            <p role="status" className="text-sm text-muted-foreground">
              {saved ? t("settings.saved") : null}
            </p>
          </div>
        ) : null}
      </form>

      <section aria-labelledby="settings-chart-heading" className="flex flex-col gap-2 rounded-lg border border-border p-4">
        <h2 id="settings-chart-heading" className="font-medium text-foreground">
          {t("settings.chartSyncHeading")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("settings.chartSyncHint")}</p>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" disabled={pending} onClick={syncChart}>
              <RefreshCw aria-hidden className={pending ? "animate-spin" : undefined} />
              {t("settings.chartSync")}
            </Button>
            <p role="status" className="text-sm text-muted-foreground">
              {chartResult !== null ? t("settings.chartSynced", { count: chartResult }) : null}
            </p>
          </div>
        ) : null}
      </section>

      {canManage ? (
        <section aria-labelledby="settings-disable-heading" className="flex flex-col gap-2 rounded-lg border border-destructive/40 p-4">
          <h2 id="settings-disable-heading" className="font-medium text-foreground">
            {t("settings.disableHeading")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("settings.disableHint")}</p>
          {confirmingDisable ? (
            <div role="alertdialog" aria-labelledby="settings-disable-confirm" className="flex flex-col gap-3 rounded-lg border border-destructive/50 p-3">
              <p id="settings-disable-confirm" className="text-sm text-foreground">
                {t("settings.disableConfirm")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="destructive" disabled={pending} onClick={disable}>
                  {t("settings.disableSubmit")}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmingDisable(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="outline" className="w-fit" onClick={() => setConfirmingDisable(true)}>
              {t("settings.disable")}
            </Button>
          )}
        </section>
      ) : null}

      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
    </div>
  );
}
