"use client";

import { useTranslations } from "next-intl";

import { describePeriod } from "../core/periods";
import type { FilingKind } from "../core/types";
import { formatIsoDate, formatMonth } from "./format";

/** "Juli 2026", "3. Quartal 2026", "2026" or "01.07.2026 bis 15.07.2026". */
export function usePeriodLabel(): (from: string, to: string) => string {
  const t = useTranslations("Ledger.periods");
  return (from, to) => {
    const shape = describePeriod(from, to);
    switch (shape.kind) {
      case "month":
        return formatMonth(from);
      case "quarter":
        return t("quarter", { quarter: shape.quarter, year: shape.year });
      case "year":
        return String(shape.year);
      case "range":
        return t("range", { from: formatIsoDate(shape.from), to: formatIsoDate(shape.to) });
    }
  };
}

/** "USt-VA 3. Quartal 2026", "Jahresabschluss 2026". */
export function useFilingLabel(): (filing: { kind: FilingKind; periodFrom: string; periodTo: string }) => string {
  const t = useTranslations("Ledger.periods");
  const period = usePeriodLabel();
  return (filing) => t("filing", { kind: t(`filingShort.${filing.kind}`), period: period(filing.periodFrom, filing.periodTo) });
}

export function PeriodName({ from, to }: { from: string; to: string }) {
  return <>{usePeriodLabel()(from, to)}</>;
}
