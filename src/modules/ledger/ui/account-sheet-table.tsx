"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { FileText } from "lucide-react";

import { cn } from "@/shared/ui-primitives";

import type { AccountSheet } from "../core/reports";
import { AccountTag } from "./account-tag";
import { AmountCell } from "./amount-cell";
import { formatCents, formatSaldo, formatShortDate, PILL_CLASSES } from "./format";

/**
 * The Kontenblatt (decisions/0080 UI concept B, screen B): the opening balance, every line of the
 * account in the period with its counter accounts (each a link to that account's sheet), the
 * entry and the document behind it, and the running balance. A proposal's line is dashed and
 * marked "Vorschlag"; unless `countProposals`, it has no running balance and stays out of the
 * sums.
 */
export function AccountSheetTable({
  sheet,
  accountNames,
  countProposals,
  sheetQuery,
}: {
  sheet: AccountSheet;
  /** Plain names of the counter accounts, by number. */
  accountNames: Readonly<Record<string, string>>;
  countProposals: boolean;
  /** The period part of the counter-account links (`?von=...&bis=...`). */
  sheetQuery: string;
}) {
  const t = useTranslations("Ledger");

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{t("sheet.caption", { name: sheet.account.name, number: sheet.account.number })}</caption>
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("sheet.columns.date")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("sheet.columns.text")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("sheet.columns.counter")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("sheet.columns.document")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t("sheet.columns.debit")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t("sheet.columns.credit")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t("sheet.columns.balance")}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="border-t border-border px-3 py-2" />
            <td colSpan={5} className="border-t border-border px-3 py-2 text-muted-foreground">
              {t("sheet.opening")}
            </td>
            <td className="border-t border-border px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatSaldo(sheet.openingCents)}</td>
          </tr>
          {sheet.rows.map((row) => {
            const proposal = row.proposed;
            const cell = cn("border-t border-border px-3 py-2 align-top", proposal && "border-dashed");
            return (
              <tr key={row.lineId} data-status={proposal ? "proposed" : "booked"} className={cn("hover:bg-muted/40", proposal && "text-muted-foreground")}>
                <td className={cn(cell, "whitespace-nowrap tabular-nums")}>{formatShortDate(row.bookingDate)}</td>
                <td className={cell}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Link href={`/dashboard/buchhaltung/buchung/${row.entryId}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                      {row.text}
                    </Link>
                    {proposal ? <span className={cn(PILL_CLASSES, "border border-dashed border-border text-foreground")}>{t("statuses.proposed")}</span> : null}
                    {row.taxRole === "tax" ? <span className="text-xs text-muted-foreground">{t("sheet.taxLine")}</span> : null}
                  </span>
                </td>
                <td className={cell}>
                  <span className="flex flex-col gap-0.5">
                    {row.counterAccountNumbers.map((number) => (
                      <Link key={number} href={`/dashboard/buchhaltung/konten/${number}${sheetQuery}`} className="w-fit underline-offset-4 hover:underline">
                        <AccountTag name={accountNames[number] ?? number} number={number} />
                      </Link>
                    ))}
                  </span>
                </td>
                <td className={cell}>
                  {row.documentId ? (
                    <Link href={`/dashboard/documents/${row.documentId}`} className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline">
                      <FileText aria-hidden className="size-3.5" />
                      {t("sheet.documentLink")}
                    </Link>
                  ) : null}
                </td>
                <AmountCell cents={row.amountCents > 0 ? row.amountCents : null} className={cell} muted={proposal} />
                <AmountCell cents={row.amountCents < 0 ? -row.amountCents : null} className={cell} muted={proposal} />
                <td className={cn(cell, "text-right tabular-nums whitespace-nowrap")}>
                  {proposal && !countProposals ? <span className="text-xs">{t("sheet.notCounted")}</span> : formatSaldo(row.runningBalanceCents)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="bg-muted/50 text-xs font-medium text-foreground">
          <tr>
            <th scope="row" colSpan={4} className="border-t border-border px-3 py-2 text-left">
              {t("sheet.totals")}
            </th>
            <td className="border-t border-border px-3 py-2 text-right tabular-nums">{formatCents(sheet.debitCents)}</td>
            <td className="border-t border-border px-3 py-2 text-right tabular-nums">{formatCents(sheet.creditCents)}</td>
            <td className="border-t border-border px-3 py-2 text-right tabular-nums">{formatSaldo(sheet.closingCents)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
