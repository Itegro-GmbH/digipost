"use client";

import { useTranslations } from "next-intl";
import { Check, TriangleAlert } from "lucide-react";

import { cn } from "@/shared/ui-primitives";

import { lineDifference } from "../core/tax-codes";
import type { TaxRole } from "../core/types";
import { AccountTag } from "./account-tag";
import { AmountCell, DebitCreditCells } from "./amount-cell";
import { formatCents } from "./format";

export type DisplayLine = {
  position: number;
  accountNumber: string;
  /** Empty while the editor has no account for the line yet. */
  accountName: string;
  amountCents: number;
  taxRole: TaxRole | null;
  generatedFromLinePosition: number | null;
  text?: string | null;
};

/**
 * The Buchungssatz: one row per line with the account's two names and the amount in its Soll
 * or Haben column. Generated tax lines are greyed and say which line they come from; the
 * footer sums both sides and says whether they balance.
 */
export function EntryLinesTable({ lines, caption, className }: { lines: readonly DisplayLine[]; caption?: string; className?: string }) {
  const t = useTranslations("Ledger.lines");
  const debit = lines.reduce((sum, line) => (line.amountCents > 0 ? sum + line.amountCents : sum), 0);
  const credit = lines.reduce((sum, line) => (line.amountCents < 0 ? sum - line.amountCents : sum), 0);
  const difference = lineDifference(lines);

  return (
    <div className={cn("overflow-x-auto rounded-lg border border-border", className)}>
      <table className="w-full text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("account")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t("debit")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t("credit")}
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const generated = line.taxRole === "tax";
            return (
              <tr key={line.position} className={cn("border-t border-border", generated && "bg-muted/30 text-muted-foreground")}>
                <td className="px-3 py-2">
                  <div className="flex flex-col">
                    {line.accountNumber ? <AccountTag name={line.accountName || line.accountNumber} number={line.accountNumber} /> : <span className="italic text-muted-foreground">{t("noAccount")}</span>}
                    {generated && line.generatedFromLinePosition !== null ? <span className="text-xs">{t("taxLine", { position: line.generatedFromLinePosition })}</span> : null}
                    {line.text ? <span className="text-xs text-muted-foreground">{line.text}</span> : null}
                  </div>
                </td>
                <DebitCreditCells amountCents={line.amountCents} muted={generated} />
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t border-border font-medium">
          <tr>
            <td className="px-3 py-2">
              {difference === 0 && lines.length >= 2 ? (
                <span className="inline-flex items-center gap-1 text-brand-positive">
                  <Check aria-hidden className="size-3.5" />
                  {t("balanced")}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-destructive">
                  <TriangleAlert aria-hidden className="size-3.5" />
                  {t("difference", { amount: formatCents(Math.abs(difference)) })}
                </span>
              )}
            </td>
            <AmountCell cents={debit} />
            <AmountCell cents={credit} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
