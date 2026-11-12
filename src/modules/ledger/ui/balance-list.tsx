"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { CircleCheck, CircleDot, CircleHelp, CircleX } from "lucide-react";

import { cn } from "@/shared/ui-primitives";

import type { BalanceList } from "../core/reports";
import type { BalanceViewMode } from "../core/search-params";
import type { AccountStatusChip, BalanceViewGroup, BalanceViewRow } from "../core/balance-view";
import { formatCents, formatSaldo, formatShortDate, PILL_CLASSES } from "./format";

/** The status chip of one row: label and icon, never colour alone. */
export function AccountStatusBadge({ chip }: { chip: AccountStatusChip }) {
  const t = useTranslations("Ledger.accounts.chips");
  switch (chip.kind) {
    case "bank_ok":
      return (
        <span className={cn(PILL_CLASSES, "bg-brand-positive/10 text-brand-positive")}>
          <CircleCheck aria-hidden className="size-3" />
          {t("bankOk")}
        </span>
      );
    case "bank_diff":
      return (
        <span className={cn(PILL_CLASSES, "bg-destructive/10 text-destructive")}>
          <CircleX aria-hidden className="size-3" />
          {chip.since ? t("bankDiffSince", { date: formatShortDate(chip.since) }) : t("bankDiff")}
        </span>
      );
    case "items_zero":
      return (
        <span className={cn(PILL_CLASSES, "bg-brand-positive/10 text-brand-positive")}>
          <CircleCheck aria-hidden className="size-3" />
          {t("itemsZero")}
        </span>
      );
    case "items_explained":
      return (
        <span className={cn(PILL_CLASSES, "bg-muted text-foreground")}>
          <CircleDot aria-hidden className="size-3" />
          {t("itemsExplained")}
        </span>
      );
    case "items_open":
      return (
        <span className={cn(PILL_CLASSES, "bg-destructive/10 text-destructive")}>
          <CircleX aria-hidden className="size-3" />
          {t("itemsOpen", { count: chip.count })}
        </span>
      );
  }
}

function AmountLink({ cents, href, format = formatCents, label }: { cents: number; href: string; format?: (cents: number) => string; label: string }) {
  return (
    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
      <Link href={href} className="text-foreground underline-offset-4 hover:underline" aria-label={`${label}: ${format(cents)}`}>
        {format(cents)}
      </Link>
    </td>
  );
}

/**
 * "Konten", the living Summen- und Saldenliste (decisions/0080 UI concept B, screen A): one
 * collapsible group per account group with its subtotal, every amount a link to the account's
 * Kontenblatt for the same period. "Einfach" shows what went in and out and the resulting
 * "Stand" in the account's own direction; "Soll/Haben" shows the DATEV columns (EB, Soll, Haben,
 * Saldo with S/H). The footer checks that both sides add up.
 */
export function BalanceListView({
  groups,
  totals,
  statuses,
  mode,
  sheetQuery,
}: {
  groups: readonly BalanceViewGroup[];
  totals: BalanceList["totals"];
  /** Status chip per account number (bank and open-item accounts). */
  statuses: Readonly<Record<string, AccountStatusChip>>;
  mode: BalanceViewMode;
  /** The period part of every Kontenblatt link (`?von=...&bis=...`). */
  sheetQuery: string;
}) {
  const t = useTranslations("Ledger");
  const simple = mode === "einfach";
  const balanced = totals.debitCents === totals.creditCents;

  function accountCell(row: BalanceViewRow) {
    return (
      <td className="px-3 py-2 align-top">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <Link href={`/dashboard/buchhaltung/konten/${row.number}${sheetQuery}`} className="min-w-0 font-medium text-foreground underline-offset-4 hover:underline">
              <span className="truncate">{row.name}</span> <span className="font-mono text-xs font-normal text-muted-foreground">{row.number}</span>
            </Link>
            {row.description ? (
              <details className="group shrink-0 text-xs">
                <summary className="inline-flex cursor-pointer list-none items-center text-muted-foreground hover:text-foreground" aria-label={t("accounts.whatIsThis", { name: row.name })}>
                  <CircleHelp aria-hidden className="size-3.5" />
                </summary>
                <p className="mt-1 max-w-prose text-muted-foreground">{row.description}</p>
              </details>
            ) : null}
          </span>
        </div>
      </td>
    );
  }

  const columns = simple ? ["in", "out", "balance"] : ["opening", "debit", "credit", "saldo"];

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const simpleSubtotal = group.naturalCents === null ? null : formatCents(group.naturalCents);
        const subtotal = simple ? simpleSubtotal : formatSaldo(group.totals.closingCents);
        return (
          <details key={group.group} open className="rounded-lg border border-border" data-group={group.group}>
            <summary className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-muted/50">
              <span className="font-medium text-foreground">{t(`groups.${group.group}`)}</span>
              <span className="text-sm tabular-nums text-muted-foreground">{subtotal}</span>
            </summary>
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full table-fixed text-sm">
                <caption className="sr-only">{t(`groups.${group.group}`)}</caption>
                <colgroup>
                  <col className="w-[38%]" />
                  <col className="w-[22%]" />
                  {columns.map((column) => (
                    <col key={column} />
                  ))}
                </colgroup>
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("accounts.columns.account")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("accounts.columns.status")}
                    </th>
                    {columns.map((column) => (
                      <th key={column} scope="col" className="px-3 py-2 text-right font-medium">
                        {t(`accounts.columns.${column}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => {
                    const href = `/dashboard/buchhaltung/konten/${row.number}${sheetQuery}`;
                    const chip = statuses[row.number];
                    return (
                      <tr key={row.accountId} className="border-t border-border hover:bg-muted/40">
                        {accountCell(row)}
                        <td className="px-3 py-2 align-top">{chip ? <AccountStatusBadge chip={chip} /> : null}</td>
                        {simple ? (
                          <>
                            <AmountLink cents={row.inCents} href={href} label={t("accounts.columns.in")} />
                            <AmountLink cents={row.outCents} href={href} label={t("accounts.columns.out")} />
                            <AmountLink cents={row.naturalCents} href={href} label={t("accounts.columns.balance")} />
                          </>
                        ) : (
                          <>
                            <AmountLink cents={row.openingCents} href={href} format={formatSaldo} label={t("accounts.columns.opening")} />
                            <AmountLink cents={row.debitCents} href={href} label={t("accounts.columns.debit")} />
                            <AmountLink cents={row.creditCents} href={href} label={t("accounts.columns.credit")} />
                            <AmountLink cents={row.closingCents} href={href} format={formatSaldo} label={t("accounts.columns.saldo")} />
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t border-border text-xs text-muted-foreground">
                  <tr>
                    <th scope="row" colSpan={2} className="px-3 py-2 text-left font-medium">
                      {t("accounts.groupTotal", { group: t(`groups.${group.group}`) })}
                    </th>
                    {simple ? (
                      <>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCents(group.totals.inCents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCents(group.totals.outCents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{group.naturalCents === null ? t("accounts.mixedGroup") : formatCents(group.naturalCents)}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 text-right tabular-nums">{formatSaldo(group.totals.openingCents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCents(group.totals.debitCents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCents(group.totals.creditCents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatSaldo(group.totals.closingCents)}</td>
                      </>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
          </details>
        );
      })}

      <p role="status" className={cn("inline-flex items-center justify-end gap-1.5 text-sm tabular-nums", balanced ? "text-foreground" : "text-destructive")}>
        {balanced ? <CircleCheck aria-hidden className="size-4 text-brand-positive" /> : <CircleX aria-hidden className="size-4" />}
        {balanced
          ? t("accounts.balanced", { debit: formatCents(totals.debitCents), credit: formatCents(totals.creditCents) })
          : t("accounts.unbalanced", { debit: formatCents(totals.debitCents), credit: formatCents(totals.creditCents), difference: formatCents(totals.debitCents - totals.creditCents) })}
      </p>
    </div>
  );
}
