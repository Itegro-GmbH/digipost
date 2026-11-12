// Every message key the ledger's pages and components use resolves in `de.json`: the closed
// value sets the UI maps to copy, and every literal `t("...")` key in the UI source files
// (resolved against the namespaces that file declares), so a page never shows a raw key.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";
import { CONTROL_IDS, FILING_KINDS, JOURNAL_STATUS_FILTERS, PERIOD_STATUSES, PROPOSAL_WARNING_CODES, TAX_CODES } from "@/modules/ledger";

import { EDITOR_ISSUES, EDITOR_MODES } from "../ui/editor-model";

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
});

const REPO = join(__dirname, "..", "..", "..", "..");
const SOURCES = [
  ...readdirSync(join(__dirname, "..", "ui"))
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => join(__dirname, "..", "ui", name)),
  ...["page.tsx", "zu-pruefen/page.tsx", "journal/page.tsx", "buchung/[id]/page.tsx", "buchung/neu/page.tsx"].map((name) => join(REPO, "src", "app", "(app)", "dashboard", "buchhaltung", name)),
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
