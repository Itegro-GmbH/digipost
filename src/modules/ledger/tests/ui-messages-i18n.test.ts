// Every message key the ledger's pages and components use resolves in `de.json`: the closed
// value sets the UI maps to copy, and every literal `t("...")` key in the UI source files
// (resolved against the namespaces that file declares), so a page never shows a raw key.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";
import {
  BALANCE_VIEW_MODES,
  CONTROL_IDS,
  FILING_KINDS,
  JOURNAL_STATUS_FILTERS,
  LEDGER_ACCOUNT_GROUPS,
  LEDGER_ACCOUNT_KINDS,
  LEDGER_OWNER_TYPES,
  MATCH_SUGGESTION_REASONS,
  OPEN_ITEM_ACCOUNT_STATUSES,
  OPEN_ITEM_ACCOUNT_TYPES,
  OPEN_ITEM_MATCH_KINDS,
  PERIOD_STATUSES,
  PROPOSAL_WARNING_CODES,
  BOOKING_RULE_DIRECTIONS,
  TAX_CODES,
  VAT_BASES,
  VAT_KENNZAHLEN,
} from "@/modules/ledger";

import { EDITOR_ISSUES, EDITOR_MODES } from "../ui/editor-model";
import { REPORT_TABS, SETTINGS_TABS } from "../ui/section-tabs";

const root = de as unknown as Record<string, unknown>;

function resolve(path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), root);
}

const isMessage = (path: string) => typeof resolve(path) === "string";

describe("closed value sets the ledger UI shows", () => {
  it.each(PROPOSAL_WARNING_CODES)("warningLabels.%s", (code) => expect(isMessage(`Ledger.warningLabels.${code}`)).toBe(true));
  it.each(EDITOR_MODES)("editor.modes.%s", (mode) => expect(isMessage(`Ledger.editor.modes.${mode}`)).toBe(true));
  it.each(EDITOR_ISSUES)("editor.issues.%s", (issue) => expect(isMessage(`Ledger.editor.issues.${issue}`)).toBe(true));
  it.each(CONTROL_IDS)("overview.checkShort.%s", (id) => expect(isMessage(`Ledger.overview.checkShort.${id}`)).toBe(true));
  it.each(PERIOD_STATUSES)("periodStatus.%s", (status) => expect(isMessage(`Ledger.periodStatus.${status}`)).toBe(true));
  it.each(JOURNAL_STATUS_FILTERS)("statuses.%s", (status) => expect(isMessage(`Ledger.statuses.${status}`)).toBe(true));
  it.each(FILING_KINDS)("periods.filingShort.%s", (kind) => expect(isMessage(`Ledger.periods.filingShort.${kind}`)).toBe(true));
  it.each(TAX_CODES)("taxCodes.%s.hint", (code) => expect(isMessage(`Ledger.taxCodes.${code}.hint`)).toBe(true));
  it.each(TAX_CODES)("taxCodes.%s.label", (code) => expect(isMessage(`Ledger.taxCodes.${code}.label`)).toBe(true));
  it.each(BALANCE_VIEW_MODES)("accounts.modes.%s", (mode) => expect(isMessage(`Ledger.accounts.modes.${mode}`)).toBe(true));
  it.each(LEDGER_ACCOUNT_GROUPS)("groups.%s", (group) => expect(isMessage(`Ledger.groups.${group}`)).toBe(true));
  it.each(LEDGER_ACCOUNT_KINDS)("accountKinds.%s", (kind) => expect(isMessage(`Ledger.accountKinds.${kind}`)).toBe(true));
  it.each(LEDGER_OWNER_TYPES)("ownerTypes.%s and chart.owner.%s", (type) => {
    expect(isMessage(`Ledger.ownerTypes.${type}`)).toBe(true);
    expect(isMessage(`Ledger.chart.owner.${type}`)).toBe(true);
  });
  it.each(OPEN_ITEM_ACCOUNT_TYPES)("openItems.types.%s", (type) => {
    expect(isMessage(`Ledger.openItems.types.${type}.title`)).toBe(true);
    expect(isMessage(`Ledger.openItems.types.${type}.text`)).toBe(true);
  });
  it.each(OPEN_ITEM_ACCOUNT_STATUSES)("openItemStatuses.%s", (status) => expect(isMessage(`Ledger.openItemStatuses.${status}`)).toBe(true));
  it.each(OPEN_ITEM_MATCH_KINDS)("matchKinds.%s", (kind) => expect(isMessage(`Ledger.matchKinds.${kind}`)).toBe(true));
  it.each(MATCH_SUGGESTION_REASONS)("matchSuggestionReasons.%s", (reason) => expect(isMessage(`Ledger.matchSuggestionReasons.${reason}`)).toBe(true));
  it.each(BOOKING_RULE_DIRECTIONS)("ruleDirections.%s", (direction) => expect(isMessage(`Ledger.ruleDirections.${direction}`)).toBe(true));
  it.each(VAT_BASES)("vatBases.%s", (basis) => expect(isMessage(`Ledger.vatBases.${basis}`)).toBe(true));
  it.each(VAT_KENNZAHLEN)("kennzahlen.%s", (kennzahl) => expect(isMessage(`Ledger.kennzahlen.${kennzahl}`)).toBe(true));
  it.each(REPORT_TABS)("reports.tabs.%s", (tab) => expect(isMessage(`Ledger.reports.tabs.${tab}`)).toBe(true));
  it.each(SETTINGS_TABS)("settings.tabs.%s", (tab) => expect(isMessage(`Ledger.settings.tabs.${tab}`)).toBe(true));
  it.each(["locked", "booked", "proposed", "none"])("documentCard.states.%s", (state) => expect(isMessage(`Ledger.documentCard.states.${state}`)).toBe(true));
  it.each(["ledgerOverview", "ledgerQueue", "ledgerAccounts", "ledgerJournal", "ledgerReports", "ledgerSettings"])("DashboardShell.nav.%s", (key) => expect(isMessage(`DashboardShell.nav.${key}`)).toBe(true));
});

describe("the ledger copy has no em or en dash (AGENTS.md)", () => {
  it("never uses either character", () => {
    expect(JSON.stringify(de.Ledger)).not.toMatch(/[\u2013\u2014]/);
  });
});

const REPO = join(__dirname, "..", "..", "..", "..");
const SOURCES = [
  ...readdirSync(join(__dirname, "..", "ui"))
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => join(__dirname, "..", "ui", name)),
  ...[
    "page.tsx",
    "zu-pruefen/page.tsx",
    "journal/page.tsx",
    "buchung/[id]/page.tsx",
    "buchung/neu/page.tsx",
    "konten/page.tsx",
    "konten/[nummer]/page.tsx",
    "auswertungen/ust/page.tsx",
    "auswertungen/abgleich/page.tsx",
    "auswertungen/zeitraeume/page.tsx",
    "einstellungen/page.tsx",
    "einstellungen/kontenplan/page.tsx",
    "einstellungen/regeln/page.tsx",
  ].map((name) => join(REPO, "src", "app", "(app)", "dashboard", "buchhaltung", name)),
  join(REPO, "src", "app", "(app)", "dashboard", "finance", "page.tsx"),
  join(REPO, "src", "app", "(app)", "dashboard", "abschluss", "page.tsx"),
];

describe("literal message keys in the ledger UI", () => {
  it.each(SOURCES)("%s", (file) => {
    const source = readFileSync(file, "utf8");
    const namespaces = [...source.matchAll(/(?:useTranslations|getTranslations)\("([^"]+)"\)/g)].map((match) => match[1]!);
    const keys = [...source.matchAll(/\bt[A-Z]?\w*\(\s*"([^"]+)"/g)].map((match) => match[1]!).filter((key) => !key.includes("${"));
    if (keys.length > 0) expect(namespaces.length, "declares a namespace").toBeGreaterThan(0);
    // Keys picked by a condition (`t(cond ? "a" : "b")`) are matched as quoted strings too.
    const conditional = [...source.matchAll(/\bt\w*\([^()"]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)].flatMap((match) => [match[1]!, match[2]!]);
    keys.push(...conditional);
    const missing = keys.filter((key) => !namespaces.some((namespace) => isMessage(`${namespace}.${key}`)));
    expect(missing).toEqual([]);
  });
});
