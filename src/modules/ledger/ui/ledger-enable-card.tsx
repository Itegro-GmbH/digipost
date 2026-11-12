"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Input, Label } from "@/shared/ui-primitives";

import { saveLedgerSettingsAction } from "../actions";
import type { LedgerActionErrorCode } from "../core/error-codes";
import type { VatBasis, VatPeriod } from "../core/types";

/**
 * "Buchhaltung aktivieren" (decisions/0080 spec section 8): the admin card shown on
 * `/dashboard/buchhaltung` while the ledger is off. Enabling seeds the SKR 04 chart; the start
 * date decides from when sources are proposed. `canManage` false (no `finance.manage`) shows
 * the explanation without the form.
 */
export function LedgerEnableCard({ defaultStartDate, canManage }: { defaultStartDate: string; canManage: boolean }) {
  const t = useTranslations("Ledger.enable");
  const tErrors = useTranslations("Ledger.errors");
  const router = useRouter();
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [vatPeriod, setVatPeriod] = useState<VatPeriod>("month");
  const [vatBasis, setVatBasis] = useState<VatBasis>("soll");
  const [errorCode, setErrorCode] = useState<LedgerActionErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrorCode(null);
    startTransition(async () => {
      const result = await saveLedgerSettingsAction({ enabled: true, vatPeriod, vatBasis, startDate: startDate || null });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      router.refresh();
    });
  }

  const radio = <T extends string>(name: string, value: T, current: T, set: (value: T) => void, label: string, hint: string) => (
    <label className="flex cursor-pointer gap-2 rounded-lg border border-border p-3 has-checked:border-ring has-checked:bg-muted/50">
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => set(value)} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("heading")}</CardTitle>
        <CardDescription>
          {t("what")} {t("control")}
        </CardDescription>
      </CardHeader>
      {canManage ? (
        <form onSubmit={submit}>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ledger-start-date">{t("startDate")}</Label>
              <Input id="ledger-start-date" type="date" required value={startDate} onChange={(event) => setStartDate(event.target.value)} aria-describedby="ledger-start-date-hint" className="w-fit" />
              <p id="ledger-start-date-hint" className="text-xs text-muted-foreground">
                {t("startDateHint")}
              </p>
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-sm font-medium text-foreground">{t("vatPeriod")}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {radio("vatPeriod", "month", vatPeriod, setVatPeriod, t("month"), t("monthHint"))}
                {radio("vatPeriod", "quarter", vatPeriod, setVatPeriod, t("quarter"), t("quarterHint"))}
              </div>
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-sm font-medium text-foreground">{t("vatBasis")}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {radio("vatBasis", "soll", vatBasis, setVatBasis, t("soll"), t("sollHint"))}
                {radio("vatBasis", "ist", vatBasis, setVatBasis, t("ist"), t("istHint"))}
              </div>
            </fieldset>
            {errorCode ? (
              <p role="alert" className="text-sm text-destructive">
                {tErrors(errorCode)}
              </p>
            ) : null}
          </CardContent>
          <CardFooter className="mt-4">
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? t("pending") : t("submit")}
            </Button>
          </CardFooter>
        </form>
      ) : (
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      )}
    </Card>
  );
}
