"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";

import { cn } from "@/shared/ui-primitives";

import type { JournalEntryListItem } from "../core/types";
import { AccountTag } from "./account-tag";
import { AmountCell } from "./amount-cell";
import { formatShortDate } from "./format";
import { OriginPill, StatusPill } from "./pills";

/** The main account of each side: the largest base line, as DATEV shows "Soll an Haben". */
function mainLine(entry: JournalEntryListItem, side: 1 | -1) {
  const lines = entry.lines.filter((line) => line.taxRole !== "tax" && Math.sign(line.amountCents) === side);
  return lines.sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents))[0] ?? null;
}

/**
 * The journal: every entry with date, text, Soll and Haben account, amount, origin and status.
 * Proposals have a dashed outline, an entry a filing locks a lock; every row links to the entry.
 */
export function JournalTable({ entries, lockedIds }: { entries: readonly JournalEntryListItem[]; lockedIds: readonly string[] }) {
  const t = useTranslations("Ledger");
  const locked = new Set(lockedIds);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{t("journal.caption")}</caption>
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("journal.columns.date")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("journal.columns.text")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("journal.columns.debit")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("journal.columns.credit")}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t("journal.columns.amount")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("journal.columns.origin")}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t("journal.columns.status")}
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const debit = mainLine(entry, 1);
            const credit = mainLine(entry, -1);
            const proposal = entry.status === "proposed";
            const isLocked = locked.has(entry.id);
            const cell = cn("border-t border-border px-3 py-2 align-top", proposal && "border-dashed");
            return (
              <tr key={entry.id} data-status={entry.status} className={cn("hover:bg-muted/40", proposal && "text-muted-foreground", entry.dismissed && "line-through decoration-muted-foreground/60")}>
                <td className={cn(cell, "whitespace-nowrap tabular-nums")}>{formatShortDate(entry.bookingDate)}</td>
                <td className={cell}>
                  <Link href={`/dashboard/buchhaltung/buchung/${entry.id}`} className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline">
                    {isLocked ? <Lock aria-label={t("pills.locked")} className="size-3.5 shrink-0" /> : null}
                    {entry.text}
                  </Link>
                </td>
                <td className={cell}>{debit ? <AccountTag name={debit.accountName} number={debit.accountNumber} /> : null}</td>
                <td className={cell}>{credit ? <AccountTag name={credit.accountName} number={credit.accountNumber} /> : null}</td>
                <AmountCell cents={entry.totalCents} className={cell} />
                <td className={cell}>
                  <OriginPill origin={entry.origin} />
                </td>
                <td className={cell}>
                  <StatusPill status={entry.status} dismissed={entry.dismissed} locked={isLocked} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
