// The booking editor's pure model: what each simple mode books, how existing lines are
// recognized, and what keeps an entry from being saved or booked (decisions/0080 spec section 5).
import { describe, expect, it } from "vitest";

import { expandTaxLines } from "../core/tax-codes";
import {
  detectMode,
  editorIssues,
  emptyExpertRow,
  emptySimple,
  emptySplitRow,
  expandedLines,
  fitMode,
  reversedLines,
  splitRemaining,
  switchMode,
  toLineInputs,
  type AccountFacts,
  type EditorLinesState,
} from "../ui/editor-model";

const ACCOUNTS = new Map<string, AccountFacts>(
  [
    { number: "6810", kind: "expense" },
    { number: "6600", kind: "expense" },
    { number: "6825", kind: "expense" },
    { number: "6855", kind: "expense" },
    { number: "4400", kind: "revenue" },
    { number: "1800", kind: "asset" },
    { number: "1461", kind: "asset" },
    { number: "3300", kind: "liability" },
    { number: "1200", kind: "asset" },
    { number: "2900", kind: "equity" },
  ].map((account) => [account.number, account as AccountFacts]),
);

const summary = (state: EditorLinesState) => expandedLines(state).map((line) => [line.accountNumber, line.amountCents, line.taxRole]);

const ionos: EditorLinesState = { mode: "expense", simple: { ...emptySimple("1800"), accountNumber: "6810", amount: "1,50", taxCode: "vst19" } };
const meta: EditorLinesState = { mode: "expense", simple: { ...emptySimple("1461"), accountNumber: "6600", amount: "13,00", taxCode: "rc13b" } };
const court: EditorLinesState = {
  mode: "split",
  split: {
    direction: "expense",
    total: "305,00",
    paymentAccountNumber: "3300",
    counterDocumentId: null,
    rows: [
      { ...emptySplitRow(), accountNumber: "6825", amount: "300,00", taxCode: "not_taxable" },
      { ...emptySplitRow(), accountNumber: "6855", amount: "5,00", taxCode: "not_taxable" },
    ],
  },
};

describe("simple modes", () => {
  it("books IONOS 1,50 gross with 19 % input tax against the bank", () => {
    expect(summary(ionos)).toEqual([
      ["6810", 126, "base"],
      ["1406", 24, "tax"],
      ["1800", -150, null],
    ]);
    expect(editorIssues(ionos, "book")).toEqual([]);
  });

  it("books a net amount with the tax on top and the gross on the other side", () => {
    const net: EditorLinesState = { mode: "expense", simple: { ...ionos.simple, amount: "1,26", amountMode: "net" } };
    expect(summary(net)).toEqual([
      ["6810", 126, "base"],
      ["1406", 24, "tax"],
      ["1800", -150, null],
    ]);
  });

  it("books Meta under reverse charge: 1407 and 3837 cancel out, the counter carries the amount", () => {
    expect(summary(meta)).toEqual([
      ["6600", 1300, "base"],
      ["1407", 247, "tax"],
      ["3837", -247, "tax"],
      ["1461", -1300, null],
    ]);
    expect(editorIssues(meta, "book")).toEqual([]);
  });

  it("books income as a credit with output tax and the receivable as debit", () => {
    const sale: EditorLinesState = { mode: "income", simple: { ...emptySimple("1200"), accountNumber: "4400", amount: "119,00", taxCode: "ust19" } };
    expect(summary(sale)).toEqual([
      ["4400", -10000, "base"],
      ["3806", -1900, "tax"],
      ["1200", 11900, null],
    ]);
  });

  it("keeps a printed tax amount while the amount is unchanged", () => {
    const printed: EditorLinesState = { mode: "expense", simple: { ...ionos.simple, amount: "10,00", taxCents: 159 } };
    expect(summary(printed)[1]).toEqual(["1406", 159, "tax"]);
  });

  it("books a transfer (Umbuchung) without tax", () => {
    const transfer: EditorLinesState = { mode: "transfer", transfer: { fromAccountNumber: "1800", toAccountNumber: "1461", amount: "100", fromDocumentId: null, toDocumentId: null } };
    expect(summary(transfer)).toEqual([
      ["1461", 10000, null],
      ["1800", -10000, null],
    ]);
  });
});

describe("Aufteilen", () => {
  it("splits the court letter into 300 court fees and 5 dunning fee against the payables", () => {
    expect(summary(court)).toEqual([
      ["6825", 30000, "base"],
      ["6855", 500, "base"],
      ["3300", -30500, null],
    ]);
    expect(splitRemaining(court.mode === "split" ? court.split : (undefined as never))).toBe(0);
    expect(editorIssues(court, "book")).toEqual([]);
  });

  it("refuses to book while something is left to distribute", () => {
    const short: EditorLinesState = court.mode === "split" ? { mode: "split", split: { ...court.split, total: "310,00" } } : court;
    expect(editorIssues(short, "book")).toContain("remaining");
    expect(editorIssues(short, "save")).toContain("remaining");
  });
});

describe("Experte", () => {
  it("blocks booking an unbalanced entry but lets it be saved as a proposal", () => {
    const rows: EditorLinesState = {
      mode: "expert",
      rows: [
        { ...emptyExpertRow(), accountNumber: "6825", debit: "300,00" },
        { ...emptyExpertRow(), accountNumber: "1800", credit: "305,00" },
      ],
    };
    expect(editorIssues(rows, "book")).toEqual(["unbalanced"]);
    expect(editorIssues(rows, "save")).toEqual([]);
  });

  it("treats a taxed amount as net and generates the tax line", () => {
    const rows: EditorLinesState = {
      mode: "expert",
      rows: [
        { ...emptyExpertRow(), accountNumber: "6810", debit: "1,26", taxCode: "vst19" },
        { ...emptyExpertRow(), accountNumber: "1800", credit: "1,50" },
        emptyExpertRow(),
      ],
    };
    expect(summary(rows)).toEqual([
      ["6810", 126, "base"],
      ["1406", 24, "tax"],
      ["1800", -150, null],
    ]);
    expect(editorIssues(rows, "book")).toEqual([]);
  });

  it("names a row without an account", () => {
    const rows: EditorLinesState = { mode: "expert", rows: [{ ...emptyExpertRow(), debit: "5" }, { ...emptyExpertRow(), accountNumber: "1800", credit: "5" }] };
    expect(editorIssues(rows, "book")).toContain("account_missing");
  });
});

describe("recognizing existing lines", () => {
  it("opens an IONOS entry as Ausgabe with the gross amount and the exact tax", () => {
    const state = detectMode(expandedLines(ionos), ACCOUNTS);
    expect(state).toMatchObject({ mode: "expense", simple: { accountNumber: "6810", amount: "1,50", taxCode: "vst19", taxCents: 24, paymentAccountNumber: "1800" } });
  });

  it("opens the share capital (bank to 2900) as Umbuchung", () => {
    const lines = expandTaxLines([
      { accountNumber: "1800", amountCents: 416700 },
      { accountNumber: "2900", amountCents: -416700 },
    ]).map((line) => ({ ...line }));
    expect(detectMode(lines, ACCOUNTS).mode).toBe("transfer");
  });

  it("opens the court letter as Aufteilen and an unbalanced proposal in the expert grid", () => {
    expect(detectMode(expandedLines(court), ACCOUNTS).mode).toBe("split");
    const unbalanced = expandTaxLines([
      { accountNumber: "6825", amountCents: 300 },
      { accountNumber: "1800", amountCents: -305 },
    ]);
    expect(detectMode(unbalanced, ACCOUNTS).mode).toBe("expert");
  });

  it("round-trips: the recognized state books the same lines", () => {
    for (const state of [ionos, meta, court]) {
      const again = detectMode(expandedLines(state), ACCOUNTS);
      expect(summary(again)).toEqual(summary(state));
    }
  });

  it("does not fit income lines into Ausgabe", () => {
    const sale = expandTaxLines([
      { accountNumber: "4400", amountCents: -11900, taxCode: "ust19" },
      { accountNumber: "1200", amountCents: 11900 },
    ]);
    expect(fitMode(sale, "expense")).toBeNull();
    expect(fitMode(sale, "income")?.mode).toBe("income");
  });
});

describe("switching modes", () => {
  it("keeps the lines when going to the expert grid and back", () => {
    const expert = switchMode(meta, "expert");
    if (!("state" in expert)) throw new Error("blocked");
    expect(summary(expert.state)).toEqual(summary(meta));
    const back = switchMode(expert.state, "expense");
    if (!("state" in back)) throw new Error("blocked");
    expect(back.state.mode).toBe("expense");
    expect(summary(back.state)).toEqual(summary(meta));
  });

  it("refuses to squeeze an expert entry that fits no template into a simple mode", () => {
    const expert: EditorLinesState = {
      mode: "expert",
      rows: [
        { ...emptyExpertRow(), accountNumber: "6825", debit: "300" },
        { ...emptyExpertRow(), accountNumber: "6855", debit: "5" },
        { ...emptyExpertRow(), accountNumber: "1800", credit: "200" },
        { ...emptyExpertRow(), accountNumber: "3300", credit: "105" },
      ],
    };
    expect(switchMode(expert, "expense")).toEqual({ blocked: true });
  });

  it("carries amount and payment into another simple mode, swapping the open account for the direction", () => {
    const draft: EditorLinesState = { mode: "expense", simple: { ...emptySimple("3300"), amount: "20" } };
    const result = switchMode(draft, "income");
    if (!("state" in result) || result.state.mode !== "income") throw new Error("unexpected");
    expect(result.state.simple).toMatchObject({ amount: "20", paymentAccountNumber: "1200", accountNumber: "" });
  });

  it("turns one Ausgabe into an Aufteilen row", () => {
    const result = switchMode(ionos, "split");
    if (!("state" in result) || result.state.mode !== "split") throw new Error("unexpected");
    expect(result.state.split.rows).toHaveLength(1);
    expect(summary(result.state)).toEqual(summary(ionos));
  });
});

describe("Korrektur buchen", () => {
  it("reverses every line, tax lines included", () => {
    const reversed = reversedLines(expandedLines(ionos));
    expect(summary(reversed)).toEqual([
      ["6810", -126, "base"],
      ["1406", -24, "tax"],
      ["1800", 150, null],
    ]);
  });
});

describe("toLineInputs", () => {
  it("sends base lines only, the use case generates the tax lines", () => {
    expect(toLineInputs(ionos)).toEqual([
      { accountNumber: "6810", amountCents: 150, taxCode: "vst19", amountMode: "gross", taxCents: null, documentId: null, text: null },
      { accountNumber: "1800", amountCents: -150, taxCode: null, amountMode: undefined, taxCents: null, documentId: null, text: null },
    ]);
  });
});
