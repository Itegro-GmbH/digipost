"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";

import { cn } from "@/shared/ui-primitives";

import type { VatPreview } from "../core/reports";
import type { VatKennzahl } from "../core/types";
import { formatCents, formatShortDate } from "./format";

export type VatEntryRef = { id: string; bookingDate: string; text: string; totalCents: number };

/**
 * The USt-VA preview (decisions/0080 UI concept B, screen F; concept C, screen F): one row per
 * Kennzahl the period fills, with its number, plain label, base and tax; each row opens to the
 * booked entries behind it. The last row is the Zahllast (Kennzahl 83) or the Erstattung.
 */
export function VatPreviewView({ preview, entriesByKennzahl }: { preview: VatPreview; entriesByKennzahl: Readonly<Partial<Record<VatKennzahl, VatEntryRef[]>>> }) {
  const t = useTranslations("Ledger");
  const rows = preview.rows.filter((row) => row.kennzahl !== "83" && (row.baseCents !== null || row.taxCents !== null));
  const payable = preview.payableCents;

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{t("vat.empty")}</p>
      ) : (
        <div className="rounded-lg border border-border text-sm" role="table" aria-label={t("vat.caption")}>
          <div role="row" className="grid grid-cols-[3.5rem_minmax(0,1fr)_8rem_8rem] gap-2 bg-muted/50 px-3 py-2 text-xs text-muted-foreground sm:grid-cols-[3.5rem_minmax(0,1fr)_9rem_9rem]">
            <span role="columnheader">{t("vat.columns.kennzahl")}</span>
            <span role="columnheader">{t("vat.columns.label")}</span>
            <span role="columnheader" className="text-right">
              {t("vat.columns.base")}
            </span>
            <span role="columnheader" className="text-right">
              {t("vat.columns.tax")}
            </span>
          </div>
          {rows.map((row) => {
            const entries = entriesByKennzahl[row.kennzahl] ?? [];
            return (
              <details key={row.kennzahl} className="group border-t border-border" data-kennzahl={row.kennzahl}>
                <summary role="row" className="grid cursor-pointer list-none grid-cols-[3.5rem_minmax(0,1fr)_8rem_8rem] items-baseline gap-2 px-3 py-2 hover:bg-muted/40 sm:grid-cols-[3.5rem_minmax(0,1fr)_9rem_9rem]">
                  <span role="cell" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                    <ChevronRight aria-hidden className="size-3 transition-transform group-open:rotate-90" />
                    {row.kennzahl}
                  </span>
                  <span role="cell" className="flex flex-col">
                    <span className="text-foreground">{t(`kennzahlen.${row.kennzahl}`)}</span>
                    <span className="text-xs text-muted-foreground">{t("vat.entryCount", { count: entries.length })}</span>
                  </span>
                  <span role="cell" className="text-right tabular-nums">
                    {row.baseCents === null ? "" : formatCents(row.baseCents)}
                  </span>
                  <span role="cell" className="text-right tabular-nums">
                    {row.taxCents === null ? "" : formatCents(row.taxCents)}
                  </span>
                </summary>
                {entries.length === 0 ? (
                  <p className="px-3 pb-3 pl-[4.5rem] text-xs text-muted-foreground">{t("vat.noEntries")}</p>
                ) : (
                  <ul className="flex flex-col gap-1 px-3 pb-3 pl-[4.5rem]">
                    {entries.map((entry) => (
                      <li key={entry.id} className="flex items-baseline justify-between gap-3">
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatShortDate(entry.bookingDate)}</span>
                          <Link href={`/dashboard/buchhaltung/buchung/${entry.id}`} className="truncate text-foreground underline-offset-4 hover:underline">
                            {entry.text}
                          </Link>
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatCents(entry.totalCents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            );
          })}
          <div role="row" className="grid grid-cols-[3.5rem_minmax(0,1fr)_8rem_8rem] items-baseline gap-2 border-t-2 border-border bg-muted/30 px-3 py-2 font-medium sm:grid-cols-[3.5rem_minmax(0,1fr)_9rem_9rem]">
            <span role="cell" className="pl-4 font-mono text-xs text-muted-foreground">
              83
            </span>
            <span role="cell" className="text-foreground">
              {t(payable >= 0 ? "vat.payable" : "vat.refund")}
            </span>
            <span role="cell" />
            <span role="cell" data-testid="vat-payable" className={cn("text-right tabular-nums", payable < 0 && "text-brand-positive")}>
              {formatCents(Math.abs(payable))}
            </span>
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("vat.roundingHint")}</p>
    </div>
  );
}
