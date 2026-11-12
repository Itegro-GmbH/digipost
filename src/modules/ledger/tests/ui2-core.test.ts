// Pure pieces behind the ledger's second UI stage (decisions/0080): the account sheet with
// proposals, the USt-VA fields of an entry, the document card's status and the accounts page's
// URL parameters.
import { describe, expect, it } from "vitest";

import {
  accountSheetSearch,
  accountsSearch,
  computeAccountSheet,
  ledgerDocumentStatusOf,
  parseAccountSheetSearchParams,
  parseAccountsSearchParams,
  startedVatPeriods,
  vatKennzahlenOfEntry,
  type FilingView,
  type JournalEntryListItem,
  type ReportLine,
} from "@/modules/ledger";

function line(id: string, entryId: string, accountId: string, accountNumber: string, bookingDate: string, amountCents: number, proposed = false): ReportLine {
  return { lineId: id, entryId, position: 1, accountId, accountNumber, bookingDate, amountCents, taxCode: null, taxRole: null, text: null, entryText: `Buchung ${entryId}`, documentId: null, transactionId: null, ...(proposed ? { proposed } : {}) };
}

describe("computeAccountSheet with proposals", () => {
  const bank = { id: "bank", number: "1800", name: "Bank", kind: "asset" as const, group: "bank" as const, openItems: false };
  const lines = [
    line("a1", "e1", "bank", "1800", "2026-06-01", 416700),
    line("a2", "e1", "cap", "2900", "2026-06-01", -416700),
    line("b1", "e2", "bank", "1800", "2026-06-12", -150, true),
    line("b2", "e2", "net", "6810", "2026-06-12", 150, true),
  ];

  it("lists a proposal but keeps it out of the balance by default", () => {
    const sheet = computeAccountSheet(bank, lines, { from: "2026-06-01", to: "2026-06-30" });
    expect(sheet.rows.map((row) => [row.lineId, row.proposed, row.runningBalanceCents])).toEqual([
      ["a1", false, 416700],
      ["b1", true, 416700],
    ]);
    expect(sheet).toMatchObject({ debitCents: 416700, creditCents: 0, closingCents: 416700 });
  });

  it("counts it with countProposals", () => {
    const sheet = computeAccountSheet(bank, lines, { from: "2026-06-01", to: "2026-06-30" }, { countProposals: true });
    expect(sheet.rows[1]!.runningBalanceCents).toBe(416550);
    expect(sheet).toMatchObject({ creditCents: 150, closingCents: 416550 });
    expect(sheet.rows[1]!.counterAccountNumbers).toEqual(["6810"]);
  });
});

describe("vatKennzahlenOfEntry", () => {
  it("names the base field of a code and the field of every tax account", () => {
    expect(
      vatKennzahlenOfEntry([
        { accountNumber: "6600", taxCode: "rc13b", taxRole: "base" },
        { accountNumber: "1407", taxCode: "rc13b", taxRole: "tax" },
        { accountNumber: "3837", taxCode: "rc13b", taxRole: "tax" },
        { accountNumber: "1461", taxCode: null, taxRole: null },
      ]),
    ).toEqual(["46", "47", "67"]);
    expect(vatKennzahlenOfEntry([{ accountNumber: "6810", taxCode: "vst19", taxRole: "base" }, { accountNumber: "1406", taxCode: "vst19", taxRole: "tax" }])).toEqual(["66"]);
    expect(vatKennzahlenOfEntry([{ accountNumber: "2900", taxCode: "not_taxable", taxRole: "base" }])).toEqual([]);
  });
});

function entry(id: string, overrides: Partial<JournalEntryListItem>): JournalEntryListItem {
  return {
    id,
    bookingDate: "2026-07-03",
    documentDate: null,
    text: id,
    status: "proposed",
    origin: "template",
    dismissed: false,
    sourceKey: null,
    originReason: null,
    documentId: "doc",
    transactionId: null,
    totalCents: 150,
    differenceCents: 0,
    warnings: [],
    revision: 1,
    updatedAt: "2026-07-03T00:00:00.000Z",
    summary: { key: "summaries.manual", params: {} },
    lines: [],
    ...overrides,
  };
}

const Q3: FilingView = { id: "f", kind: "vat_return", status: "submitted", periodFrom: "2026-07-01", periodTo: "2026-09-30", submittedOn: "2026-10-10", amountCents: 0, correctsFilingId: null, note: null, createdAt: "2026-10-10T00:00:00.000Z" };

describe("ledgerDocumentStatusOf", () => {
  it("is none without entries or with only a dismissed proposal", () => {
    expect(ledgerDocumentStatusOf([], []).state).toBe("none");
    expect(ledgerDocumentStatusOf([entry("x", { dismissed: true })], []).state).toBe("none");
  });

  it("puts the strongest entry first: locked over booked over proposed", () => {
    const status = ledgerDocumentStatusOf([entry("p", {}), entry("b", { status: "booked", bookingDate: "2026-06-30" }), entry("l", { status: "booked" })], [Q3]);
    expect(status.state).toBe("locked");
    expect(status.entries.map((item) => item.id)).toEqual(["l", "b", "p"]);
    expect(status.entries[0]!.lockedBy).toMatchObject({ id: "f", kind: "vat_return" });
    expect(status.entries[1]!.lockedBy).toBeNull();
  });
});

describe("accounts page parameters", () => {
  it("defaults to the current year in the plain view", () => {
    expect(parseAccountsSearchParams({}, "2026-11-12")).toEqual({ von: "2026-01-01", bis: "2026-11-12", ansicht: "einfach", alle: false });
  });

  it("reads and writes the expert view and empty accounts", () => {
    const values = parseAccountsSearchParams({ von: "2026-09-30", bis: "2026-07-01", ansicht: "soll-haben", alle: "1" }, "2026-11-12");
    expect(values).toEqual({ von: "2026-07-01", bis: "2026-09-30", ansicht: "soll-haben", alle: true });
    expect(accountsSearch(values, { ansicht: "einfach" })).toBe("?von=2026-07-01&bis=2026-09-30&alle=1");
    expect(parseAccountsSearchParams({ ansicht: "bogus" }, "2026-11-12").ansicht).toBe("einfach");
  });

  it("keeps the sheet's tab and proposal toggle in the URL", () => {
    const values = parseAccountSheetSearchParams({ tab: "offen", vorschlaege: "1" }, "2026-11-12");
    expect(values).toMatchObject({ tab: "offen", vorschlaege: true });
    expect(accountSheetSearch(values, { tab: "blatt" })).toBe("?von=2026-01-01&bis=2026-11-12&vorschlaege=1");
  });
});

describe("startedVatPeriods", () => {
  it("lists the started periods since the start date, newest first", () => {
    expect(startedVatPeriods({ vatPeriod: "quarter", startDate: "2026-06-01" }, "2026-11-12").map((period) => period.key)).toEqual(["2026-Q4", "2026-Q3", "2026-Q2"]);
    expect(startedVatPeriods({ vatPeriod: "month", startDate: "2025-12-01" }, "2026-02-03").map((period) => period.key)).toEqual(["2026-02", "2026-01", "2025-12"]);
  });
});
