import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { listContactSummariesProjection } from "@/modules/contacts/server";
import { RulesSettings, SettingsTabs } from "@/modules/ledger/client";
import { isLedgerEnabledProjection, listLedgerAccountsProjection, listLedgerRulesProjection } from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";

/** Enough for every contact a small business has; the rule form lists them by name. */
const CONTACT_OPTIONS_LIMIT = 1000;

/**
 * "Einstellungen > Regeln" (decisions/0080 UI concept B, screen I): the booking rules, learned
 * ("Als Regel speichern") or written by hand, with create, edit, deactivate and delete.
 * Admin-only (`finance.read`, changes need `finance.manage`), ledger enabled, else `notFound()`.
 */
export default async function LedgerRulesSettingsPage() {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  if (!(await isLedgerEnabledProjection(workspaceId))) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  const [t, rules, accounts, contacts] = await Promise.all([
    getTranslations("Ledger"),
    listLedgerRulesProjection(workspaceId),
    listLedgerAccountsProjection(workspaceId),
    listContactSummariesProjection(workspaceId, { page: 1, pageSize: CONTACT_OPTIONS_LIMIT }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("settings.heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.description")}</p>
      </div>
      <SettingsTabs active="regeln" />
      <RulesSettings rules={rules} accounts={accounts} contacts={contacts.items.map((contact) => ({ id: contact.id, name: contact.name }))} canManage={canManage} />
    </div>
  );
}
