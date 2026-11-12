// Every code and value the ledger UI can show resolves to German copy in `de.json`.
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";
import {
  LEDGER_ACCOUNT_KINDS,
  AMOUNT_MODES,
  BOOKING_RULE_DIRECTIONS,
  computeControls,
  CONTROL_IDS,
  CONTROL_STATUSES,
  ENTRY_SUMMARY_KINDS,
  FILING_KINDS,
  FILING_STATUSES,
  JOURNAL_ENTRY_ORIGINS,
  JOURNAL_ENTRY_STATUSES,
  LEDGER_ACCOUNT_GROUPS,
  LEDGER_ACTION_ERROR_CODES,
  LEDGER_OWNER_TYPES,
  MATCH_SUGGESTION_REASONS,
  OPEN_ITEM_ACCOUNT_STATUSES,
  OPEN_ITEM_MATCH_KINDS,
  PERIOD_STATUSES,
  PROPOSAL_TEMPLATES,
  PROPOSAL_WARNING_CODES,
  REVISION_CHANGE_KINDS,
  TAX_CODES,
  TAX_ROLES,
  VAT_BASES,
  VAT_KENNZAHLEN,
  VAT_PERIODS,
} from "@/modules/ledger";

const messages = de.Ledger as unknown as Record<string, Record<string, unknown>>;
const flat = (group: string) => messages[group] as Record<string, unknown>;

describe("Ledger messages", () => {
  it.each(LEDGER_ACTION_ERROR_CODES)("errors.%s resolves", (code) => expect(typeof flat("errors")[code]).toBe("string"));
  it.each(TAX_CODES)("taxCodes.%s has a label and a hint", (code) => {
    const entry = flat("taxCodes")[code] as Record<string, unknown>;
    expect(typeof entry.label).toBe("string");
    expect(typeof entry.hint).toBe("string");
  });
  it.each(VAT_KENNZAHLEN)("kennzahlen.%s resolves", (kz) => expect(typeof flat("kennzahlen")[kz]).toBe("string"));
  it.each(LEDGER_ACCOUNT_KINDS)("accountKinds.%s resolves", (kind) => expect(typeof flat("accountKinds")[kind]).toBe("string"));
  it.each(LEDGER_ACCOUNT_GROUPS)("groups.%s resolves", (group) => expect(typeof flat("groups")[group]).toBe("string"));
  it.each(LEDGER_OWNER_TYPES)("ownerTypes.%s resolves", (type) => expect(typeof flat("ownerTypes")[type]).toBe("string"));
  it.each([...JOURNAL_ENTRY_STATUSES, "dismissed"])("statuses.%s resolves", (status) => expect(typeof flat("statuses")[status]).toBe("string"));
  it.each(JOURNAL_ENTRY_ORIGINS)("origins.%s resolves", (origin) => expect(typeof flat("origins")[origin]).toBe("string"));
  it.each(TAX_ROLES)("taxRoles.%s resolves", (role) => expect(typeof flat("taxRoles")[role]).toBe("string"));
  it.each(AMOUNT_MODES)("amountModes.%s resolves", (mode) => expect(typeof flat("amountModes")[mode]).toBe("string"));
  it.each(REVISION_CHANGE_KINDS)("revisionKinds.%s resolves", (kind) => expect(typeof flat("revisionKinds")[kind]).toBe("string"));
  it.each(OPEN_ITEM_MATCH_KINDS)("matchKinds.%s resolves", (kind) => expect(typeof flat("matchKinds")[kind]).toBe("string"));
  it.each(OPEN_ITEM_ACCOUNT_STATUSES)("openItemStatuses.%s resolves", (status) => expect(typeof flat("openItemStatuses")[status]).toBe("string"));
  it.each(BOOKING_RULE_DIRECTIONS)("ruleDirections.%s resolves", (direction) => expect(typeof flat("ruleDirections")[direction]).toBe("string"));
  it.each(FILING_KINDS)("filingKinds.%s resolves", (kind) => expect(typeof flat("filingKinds")[kind]).toBe("string"));
  it.each(FILING_STATUSES)("filingStatuses.%s resolves", (status) => expect(typeof flat("filingStatuses")[status]).toBe("string"));
  it.each(VAT_PERIODS)("vatPeriods.%s resolves", (period) => expect(typeof flat("vatPeriods")[period]).toBe("string"));
  it.each(VAT_BASES)("vatBases.%s resolves", (basis) => expect(typeof flat("vatBases")[basis]).toBe("string"));
  it.each(PERIOD_STATUSES)("periodStatus.%s resolves", (status) => expect(typeof flat("periodStatus")[status]).toBe("string"));
  it.each(PROPOSAL_WARNING_CODES)("warnings.%s resolves", (code) => expect(typeof flat("warnings")[code]).toBe("string"));
  it.each(CONTROL_STATUSES)("controlStatuses.%s resolves", (status) => expect(typeof flat("controlStatuses")[status]).toBe("string"));
  it.each(CONTROL_IDS)("controls.%s has a title", (id) => expect(typeof (flat("controls")[id] as Record<string, unknown>).title).toBe("string"));
  it.each(ENTRY_SUMMARY_KINDS)("summaries.%s resolves", (kind) => expect(typeof flat("summaries")[kind]).toBe("string"));
  it.each(PROPOSAL_TEMPLATES)("templates.%s resolves", (template) => expect(typeof flat("templates")[template]).toBe("string"));
  it.each(MATCH_SUGGESTION_REASONS)("matchSuggestionReasons.%s resolves", (reason) => expect(typeof flat("matchSuggestionReasons")[reason]).toBe("string"));

  it("every message key a control can produce renders", () => {
    const t = createTranslator({ locale: "de", messages: de, namespace: "Ledger" });
    const bank = { accountNumber: "1800", ok: false, firstDivergenceDate: "2026-08-19", ledgerClosingCents: 5000, realClosingCents: 0 };
    const variants = [
      computeControls({ bank: [], unbookedBankTransactionIds: [], unbookedDocumentIds: [], openItemAccounts: [], proposalsWaiting: 0, unbalancedProposals: 0, advisorDifferences: null }),
      computeControls({ bank: [{ ...bank, ok: true }], unbookedBankTransactionIds: [], unbookedDocumentIds: [], openItemAccounts: [{ accountNumber: "1461", status: "zero", balanceCents: 0 }], proposalsWaiting: 0, unbalancedProposals: 0, advisorDifferences: 0 }),
      computeControls({ bank: [bank], unbookedBankTransactionIds: ["a"], unbookedDocumentIds: ["b", "c"], openItemAccounts: [{ accountNumber: "1461", status: "open", balanceCents: 4 }], proposalsWaiting: 2, unbalancedProposals: 1, advisorDifferences: 3 }),
    ];
    for (const control of variants.flat()) {
      const text = t(control.message.key as Parameters<typeof t>[0], control.message.params as never);
      expect(text).not.toContain("Ledger.");
      expect(text.length).toBeGreaterThan(5);
    }
  });

  it("uses no em or en dash anywhere in the namespace", () => {
    expect(JSON.stringify(de.Ledger)).not.toMatch(/[–—]/);
  });
});
