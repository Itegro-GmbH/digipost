import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { listAccountsOverviewProjection } from "@/modules/accounts/server";
import { listContactSummariesProjection } from "@/modules/contacts/server";
import { ChartSettings, SettingsTabs } from "@/modules/ledger/client";
import { isLedgerEnabledProjection, listLedgerAccountsProjection } from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";

/** Enough for every contact a small business has; the owner select lists them by name. */
const CONTACT_OPTIONS_LIMIT = 1000;

/**
 * "Einstellungen > Kontenplan" (decisions/0080 UI concept B, screen I): the chart of accounts
 * with create, edit, archive and restore. The owner options are the workspace's own bank
 * accounts and contacts, read through their owners' read models. Admin-only (`finance.read`,
 * changes need `finance.manage`), ledger enabled, else `notFound()`.
 */
export default async function LedgerChartSettingsPage() {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  if (!(await isLedgerEnabledProjection(workspaceId))) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  const [t, accounts, bankAccounts, contacts] = await Promise.all([
    getTranslations("Ledger"),
    listLedgerAccountsProjection(workspaceId),
    listAccountsOverviewProjection(workspaceId),
    listContactSummariesProjection(workspaceId, { page: 1, pageSize: CONTACT_OPTIONS_LIMIT }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("settings.heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.description")}</p>
      </div>
      <SettingsTabs active="kontenplan" />
      <ChartSettings
        accounts={accounts}
        bankAccounts={bankAccounts.filter((account) => account.type === "bank").map((account) => ({ id: account.id, name: account.name }))}
        contacts={contacts.items.map((contact) => ({ id: contact.id, name: contact.name }))}
        canManage={canManage}
      />
    </div>
  );
}
