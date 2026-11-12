"use client";

import { useTranslations } from "next-intl";

import { LedgerTabs } from "./ledger-tabs";

export const REPORT_TABS = ["susa", "ust", "abgleich", "zeitraeume"] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

const REPORT_HREFS: Record<ReportTab, string> = {
  susa: "/dashboard/buchhaltung/konten?ansicht=soll-haben",
  ust: "/dashboard/buchhaltung/auswertungen/ust",
  abgleich: "/dashboard/buchhaltung/auswertungen/abgleich",
  zeitraeume: "/dashboard/buchhaltung/auswertungen/zeitraeume",
};

/** The tab bar of "Auswertungen". "Summen und Salden" is the accounts page in its Soll/Haben
 * view: one list, not two that could disagree. */
export function ReportsTabs({ active }: { active: ReportTab }) {
  const t = useTranslations("Ledger.reports");
  return <LedgerTabs label={t("tabsLabel")} items={REPORT_TABS.map((tab) => ({ href: REPORT_HREFS[tab], label: t(`tabs.${tab}`), active: tab === active }))} />;
}

export const SETTINGS_TABS = ["allgemein", "kontenplan", "regeln"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const SETTINGS_HREFS: Record<SettingsTab, string> = {
  allgemein: "/dashboard/buchhaltung/einstellungen",
  kontenplan: "/dashboard/buchhaltung/einstellungen/kontenplan",
  regeln: "/dashboard/buchhaltung/einstellungen/regeln",
};

/** The tab bar of "Einstellungen". */
export function SettingsTabs({ active }: { active: SettingsTab }) {
  const t = useTranslations("Ledger.settings");
  return <LedgerTabs label={t("tabsLabel")} items={SETTINGS_TABS.map((tab) => ({ href: SETTINGS_HREFS[tab], label: t(`tabs.${tab}`), active: tab === active }))} />;
}
