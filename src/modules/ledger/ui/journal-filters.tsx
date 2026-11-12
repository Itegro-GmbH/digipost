"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { buttonVariants, Input, Label } from "@/shared/ui-primitives";

import { JOURNAL_STATUS_FILTERS, type JournalFilterValues } from "../core/search-params";
import { JOURNAL_ENTRY_ORIGINS, type HandoverView, type LedgerAccountView } from "../core/types";
import { formatIsoDate, SELECT_CLASSES } from "./format";
import { usePeriodLabel } from "./period-name";

/**
 * The journal's filters: a plain GET form (no client state), so a filtered journal is a link.
 * "Geändert seit Übergabe" appears only once a handover exists.
 */
export function JournalFilters({ values, accounts, handovers }: { values: JournalFilterValues; accounts: readonly LedgerAccountView[]; handovers: readonly HandoverView[] }) {
  const t = useTranslations("Ledger");
  const period = usePeriodLabel();

  return (
    <form method="get" className="flex flex-wrap items-end gap-3" aria-label={t("journal.filtersLabel")}>
      <div className="flex flex-col gap-1">
        <Label htmlFor="journal-from" className="text-xs text-muted-foreground">
          {t("filters.from")}
        </Label>
        <Input id="journal-from" type="date" name="von" defaultValue={values.von} className="w-fit" />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="journal-to" className="text-xs text-muted-foreground">
          {t("filters.to")}
        </Label>
        <Input id="journal-to" type="date" name="bis" defaultValue={values.bis} className="w-fit" />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="journal-status" className="text-xs text-muted-foreground">
          {t("journal.status")}
        </Label>
        <select id="journal-status" name="status" defaultValue={values.status} className={SELECT_CLASSES}>
          <option value="">{t("journal.statusAll")}</option>
          {JOURNAL_STATUS_FILTERS.map((status) => (
            <option key={status} value={status}>
              {t(`statuses.${status}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="journal-origin" className="text-xs text-muted-foreground">
          {t("filters.origin")}
        </Label>
        <select id="journal-origin" name="herkunft" defaultValue={values.herkunft} className={SELECT_CLASSES}>
          <option value="">{t("filters.originAll")}</option>
          {JOURNAL_ENTRY_ORIGINS.map((origin) => (
            <option key={origin} value={origin}>
              {t(`origins.${origin}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="journal-account" className="text-xs text-muted-foreground">
          {t("journal.account")}
        </Label>
        <select id="journal-account" name="konto" defaultValue={values.konto} className={`${SELECT_CLASSES} max-w-64`}>
          <option value="">{t("journal.accountAll")}</option>
          {accounts.map((account) => (
            <option key={account.number} value={account.number}>
              {account.number} {account.name}
            </option>
          ))}
        </select>
      </div>
      {handovers.length > 0 ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="journal-since" className="text-xs text-muted-foreground">
            {t("journal.changedSince")}
          </Label>
          <select id="journal-since" name="seit" defaultValue={values.seit} className={SELECT_CLASSES}>
            <option value="">{t("journal.changedSinceNone")}</option>
            {handovers.map((handover) => (
              <option key={handover.id} value={handover.id}>
                {t("journal.changedSinceOption", { date: formatIsoDate(handover.createdAt), period: period(handover.periodFrom, handover.periodTo) })}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <button type="submit" className={buttonVariants({ variant: "outline" })}>
        {t("filters.apply")}
      </button>
      <Link href="/dashboard/buchhaltung/journal" className={buttonVariants({ variant: "ghost" })}>
        {t("filters.reset")}
      </Link>
    </form>
  );
}
