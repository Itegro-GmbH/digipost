import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { accountsSearch, buildBalanceGroups, parseAccountsSearchParams, type AccountStatusChip } from "@/modules/ledger";
import { BalanceListView, LedgerTabs } from "@/modules/ledger/client";
import {
  getLedgerBalancesProjection,
  getLedgerBankComparisonsProjection,
  isLedgerEnabledProjection,
  listLedgerAccountsProjection,
  listLedgerOpenItemAccountsProjection,
} from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { buttonVariants, Input, Label } from "@/shared/ui-primitives";

/**
 * "Konten", the living Summen- und Saldenliste (decisions/0080 UI concept B, screen A): every
 * account with a balance in the period (`?von=&bis=`, default the current year), grouped, with
 * status chips for bank accounts (against the statement) and open-item accounts (settled,
 * explained, open). `?ansicht=soll-haben` switches to the DATEV columns, `?alle=1` adds the
 * accounts without movement. Admin-only (`finance.read`) and only with the ledger enabled, else
 * `notFound()`.
 */
export default async function LedgerAccountsPage({ searchParams }: PageProps<"/dashboard/buchhaltung/konten">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  if (!(await isLedgerEnabledProjection(workspaceId))) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  const today = new Date().toISOString().slice(0, 10);
  const values = parseAccountsSearchParams(await searchParams, today);
  const [t, balances, accounts, bank, openItems] = await Promise.all([
    getTranslations("Ledger"),
    getLedgerBalancesProjection(workspaceId, values.von, values.bis),
    listLedgerAccountsProjection(workspaceId),
    getLedgerBankComparisonsProjection(workspaceId, values.von, values.bis),
    listLedgerOpenItemAccountsProjection(workspaceId, values.bis),
  ]);

  const statuses: Record<string, AccountStatusChip> = {};
  for (const comparison of bank) statuses[comparison.accountNumber] = comparison.ok ? { kind: "bank_ok" } : { kind: "bank_diff", since: comparison.firstDivergenceDate };
  for (const summary of openItems) {
    if (summary.status === "zero") statuses[summary.account.number] = { kind: "items_zero" };
    else if (summary.status === "explained") statuses[summary.account.number] = { kind: "items_explained" };
    else statuses[summary.account.number] = { kind: "items_open", count: summary.unmatchedCount };
  }
  const groups = buildBalanceGroups(balances.rows, accounts, { showEmpty: values.alle });
  const base = "/dashboard/buchhaltung/konten";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("accounts.heading")}</h1>
          <p className="text-sm text-muted-foreground">{t("accounts.description")}</p>
        </div>
        {canManage ? (
          <Link href="/dashboard/buchhaltung/buchung/neu" className={buttonVariants({ variant: "outline" })}>
            {t("accounts.newEntry")}
          </Link>
        ) : null}
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3" aria-label={t("accounts.filtersLabel")}>
        <div className="flex flex-col gap-1">
          <Label htmlFor="accounts-from" className="text-xs text-muted-foreground">
            {t("filters.from")}
          </Label>
          <Input id="accounts-from" type="date" name="von" defaultValue={values.von} className="w-fit" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="accounts-to" className="text-xs text-muted-foreground">
            {t("filters.to")}
          </Label>
          <Input id="accounts-to" type="date" name="bis" defaultValue={values.bis} className="w-fit" />
        </div>
        {values.ansicht !== "einfach" ? <input type="hidden" name="ansicht" value={values.ansicht} /> : null}
        <label className="flex h-8 items-center gap-2 text-sm text-foreground">
          <input type="checkbox" name="alle" value="1" defaultChecked={values.alle} />
          {t("accounts.showEmpty")}
        </label>
        <button type="submit" className={buttonVariants({ variant: "outline" })}>
          {t("filters.show")}
        </button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <LedgerTabs
          variant="toggle"
          label={t("accounts.modeLabel")}
          items={[
            { href: `${base}${accountsSearch(values, { ansicht: "einfach" })}`, label: t("accounts.modes.einfach"), active: values.ansicht === "einfach" },
            { href: `${base}${accountsSearch(values, { ansicht: "soll-haben" })}`, label: t("accounts.modes.soll-haben"), active: values.ansicht === "soll-haben" },
          ]}
        />
        <p className="text-xs text-muted-foreground">{t(values.ansicht === "einfach" ? "accounts.modeHintSimple" : "accounts.modeHintExpert")}</p>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{t("accounts.empty")}</p>
      ) : (
        <BalanceListView groups={groups} totals={balances.totals} statuses={statuses} mode={values.ansicht} sheetQuery={`?von=${values.von}&bis=${values.bis}`} />
      )}
    </div>
  );
}
