import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { MAX_TAX_BACKFILL_PER_REQUEST } from "@/modules/documents";
import { requestTaxFieldBackfillAction } from "@/modules/documents/actions";
import { countTaxFieldBackfillCandidatesProjection } from "@/modules/documents/server";
import { SettingsGeneralForm, SettingsTabs, TaxBackfillCard } from "@/modules/ledger/client";
import { getLedgerSettingsProjection } from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";

/**
 * "Einstellungen > Allgemein" (decisions/0080 spec section 5): start date, USt-VA period,
 * taxation basis, "Kontenplan aktualisieren", "Steuerdaten alter Belege nachträglich erkennen"
 * (the documents owner's backfill, its action handed to the ledger's card), and turning the
 * ledger off. Admin-only
 * (`finance.read`, saving needs `finance.manage`); only with the ledger enabled, else
 * `notFound()` (turning it on happens on `/dashboard/buchhaltung`).
 */
export default async function LedgerSettingsPage() {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  const [t, settings, taxBackfillCandidates] = await Promise.all([
    getTranslations("Ledger"),
    getLedgerSettingsProjection(workspaceId),
    countTaxFieldBackfillCandidatesProjection(workspaceId),
  ]);
  if (!settings.enabled) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("settings.heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.description")}</p>
      </div>
      <SettingsTabs active="allgemein" />
      <SettingsGeneralForm settings={settings} canManage={canManage}>
        <TaxBackfillCard candidates={taxBackfillCandidates} maxPerRequest={MAX_TAX_BACKFILL_PER_REQUEST} canManage={canManage} action={requestTaxFieldBackfillAction} />
      </SettingsGeneralForm>
    </div>
  );
}
