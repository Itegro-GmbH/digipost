import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { SettingsGeneralForm, SettingsTabs } from "@/modules/ledger/client";
import { getLedgerSettingsProjection } from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";

/**
 * "Einstellungen > Allgemein" (decisions/0080 spec section 5): start date, USt-VA period,
 * taxation basis, "Kontenplan aktualisieren", and turning the ledger off. Admin-only
 * (`finance.read`, saving needs `finance.manage`); only with the ledger enabled, else
 * `notFound()` (turning it on happens on `/dashboard/buchhaltung`).
 */
export default async function LedgerSettingsPage() {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  const [t, settings] = await Promise.all([getTranslations("Ledger"), getLedgerSettingsProjection(workspaceId)]);
  if (!settings.enabled) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("settings.heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.description")}</p>
      </div>
      <SettingsTabs active="allgemein" />
      <SettingsGeneralForm settings={settings} canManage={canManage} />
    </div>
  );
}
