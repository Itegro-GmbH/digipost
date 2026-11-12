// The booking editor's pure model (decisions/0080, spec section 5): the simple templates
// (Ausgabe, Einnahme, Umbuchung, Aufteilen) and the expert grid all describe the same thing,
// a list of base lines, which `expandTaxLines` (the one place tax lines are computed, shared
// with the use case) turns into the entry's full lines. Switching modes goes through those
// expanded lines, so nothing typed is lost; a simple mode only accepts lines that fit it.
//
// Amounts in the fields are the user's text (German "1,50"); the model parses them on use.
// Printed tax amounts (`taxCents`) are kept absolute and only while the amount and tax code they
// belong to are unchanged, so an entry loaded from a document books the document's exact tax.
import { PAYABLES_ACCOUNT, RECEIVABLES_ACCOUNT } from "../core/proposals";
import { expandTaxLines, lineDifference, TAX_CODE_DEFINITIONS, type BaseLineInput, type ExpandedLine } from "../core/tax-codes";
import type { AmountMode, LedgerAccountView, TaxCode, TaxRole } from "../core/types";
import { formatAmountInput, parseAmountInput } from "./format";

export const EDITOR_MODES = ["expense", "income", "transfer", "split", "expert"] as const;
export type EditorMode = (typeof EDITOR_MODES)[number];
export type SimpleDirection = "expense" | "income";

/** "Ohne Steuerschlüssel" is the empty string in a `<select>`. */
export type TaxCodeField = TaxCode | "";

export type SimpleFields = {
  /** "Wofür?": the expense or revenue account. */
  accountNumber: string;
  amount: string;
  amountMode: AmountMode;
  taxCode: TaxCodeField;
  /** Absolute printed tax kept from a loaded entry or document (see the file header). */
  taxCents: number | null;
  /** "Bezahlt über/von": a bank account, an open-item account, or the payables/receivables. */
  paymentAccountNumber: string;
  baseDocumentId: string | null;
  counterDocumentId: string | null;
};

export type TransferFields = { fromAccountNumber: string; toAccountNumber: string; amount: string; fromDocumentId: string | null; toDocumentId: string | null };

export type SplitRow = { key: string; accountNumber: string; amount: string; taxCode: TaxCodeField; taxCents: number | null; documentId: string | null };
export type SplitFields = { direction: SimpleDirection; total: string; paymentAccountNumber: string; counterDocumentId: string | null; rows: SplitRow[] };

/** One raw line of the expert grid. An amount with an input or output tax code is NET there;
 * the tax line is generated below it. */
export type ExpertRow = { key: string; accountNumber: string; debit: string; credit: string; taxCode: TaxCodeField; taxCents: number | null; text: string; documentId: string | null };

export type EditorLinesState =
  | { mode: "expense" | "income"; simple: SimpleFields }
  | { mode: "transfer"; transfer: TransferFields }
  | { mode: "split"; split: SplitFields }
  | { mode: "expert"; rows: ExpertRow[] };

/** What keeps the editor from saving or booking, rendered through `Ledger.editor.issues.*`. */
export const EDITOR_ISSUES = ["account_missing", "amount_missing", "remaining", "unbalanced", "too_few_lines"] as const;
export type EditorIssue = (typeof EDITOR_ISSUES)[number];

/** The account facts the model needs to recognize a template. */
export type AccountFacts = Pick<LedgerAccountView, "number" | "kind">;

/** A line as stored (`JournalLineView`) or as `expandTaxLines` returns it. */
export type ModelLine = Pick<ExpandedLine, "position" | "accountNumber" | "amountCents" | "taxCode" | "generatedFromLinePosition" | "documentId" | "text"> & { taxRole: TaxRole | null };

let keyCounter = 0;
/** A React key for a new split or expert row. */
export function rowKey(): string {
  keyCounter += 1;
  return `row-${keyCounter}`;
}

const cents = (text: string) => parseAmountInput(text) ?? 0;
const code = (field: TaxCodeField): TaxCode | null => (field === "" ? null : field);
const signed = (value: number | null, sign: 1 | -1) => (value === null ? null : sign * value);

export function emptySimple(paymentAccountNumber = ""): SimpleFields {
  return { accountNumber: "", amount: "", amountMode: "gross", taxCode: "", taxCents: null, paymentAccountNumber, baseDocumentId: null, counterDocumentId: null };
}

export function emptySplitRow(): SplitRow {
  return { key: rowKey(), accountNumber: "", amount: "", taxCode: "", taxCents: null, documentId: null };
}

export function emptyExpertRow(): ExpertRow {
  return { key: rowKey(), accountNumber: "", debit: "", credit: "", taxCode: "", taxCents: null, text: "", documentId: null };
}

export function emptyState(mode: EditorMode, paymentAccountNumber = ""): EditorLinesState {
  switch (mode) {
    case "expense":
    case "income":
      return { mode, simple: emptySimple(paymentAccountNumber) };
    case "transfer":
      return { mode, transfer: { fromAccountNumber: paymentAccountNumber, toAccountNumber: "", amount: "", fromDocumentId: null, toDocumentId: null } };
    case "split":
      return { mode, split: { direction: "expense", total: "", paymentAccountNumber, counterDocumentId: null, rows: [emptySplitRow(), emptySplitRow()] } };
    case "expert":
      return { mode, rows: [emptyExpertRow(), emptyExpertRow()] };
  }
}

/** "Noch offen": what an expense or a sale books against until it is paid. */
export function openAccountFor(direction: SimpleDirection): string {
  return direction === "expense" ? PAYABLES_ACCOUNT : RECEIVABLES_ACCOUNT;
}

function simpleBase(fields: SimpleFields, sign: 1 | -1): BaseLineInput {
  return {
    accountNumber: fields.accountNumber,
    amountCents: sign * cents(fields.amount),
    taxCode: code(fields.taxCode),
    amountMode: fields.amountMode,
    taxCents: signed(fields.taxCents, sign),
    documentId: fields.baseDocumentId,
  };
}

/** The other side of one or more base lines: whatever balances their expanded lines. */
function counterLine(bases: BaseLineInput[], accountNumber: string, documentId: string | null): BaseLineInput {
  return { accountNumber, amountCents: -lineDifference(expandTaxLines(bases)), documentId };
}

/** The base lines the editor describes; amounts that do not parse count as zero, so the issues
 * below can name what is missing. Empty expert rows are left out. */
export function buildBaseLines(state: EditorLinesState): BaseLineInput[] {
  switch (state.mode) {
    case "expense":
    case "income": {
      const base = simpleBase(state.simple, state.mode === "expense" ? 1 : -1);
      return [base, counterLine([base], state.simple.paymentAccountNumber, state.simple.counterDocumentId)];
    }
    case "transfer": {
      const amount = cents(state.transfer.amount);
      return [
        { accountNumber: state.transfer.toAccountNumber, amountCents: amount, documentId: state.transfer.toDocumentId },
        { accountNumber: state.transfer.fromAccountNumber, amountCents: -amount, documentId: state.transfer.fromDocumentId },
      ];
    }
    case "split": {
      const sign = state.split.direction === "expense" ? 1 : -1;
      const bases = state.split.rows.map(
        (row): BaseLineInput => ({ accountNumber: row.accountNumber, amountCents: sign * cents(row.amount), taxCode: code(row.taxCode), amountMode: "gross", taxCents: signed(row.taxCents, sign), documentId: row.documentId }),
      );
      return [...bases, counterLine(bases, state.split.paymentAccountNumber, state.split.counterDocumentId)];
    }
    case "expert":
      return state.rows
        .filter((row) => row.accountNumber !== "" || row.debit.trim() !== "" || row.credit.trim() !== "")
        .map((row): BaseLineInput => {
          const amount = cents(row.debit) - cents(row.credit);
          const sign = amount < 0 ? -1 : 1;
          return { accountNumber: row.accountNumber, amountCents: amount, taxCode: code(row.taxCode), amountMode: "net", taxCents: signed(row.taxCents, sign), documentId: row.documentId, text: row.text.trim() || null };
        });
  }
}

/** The entry's full lines ("So wird gebucht"), tax lines included. */
export function expandedLines(state: EditorLinesState): ExpandedLine[] {
  return expandTaxLines(buildBaseLines(state));
}

/** "Noch zu verteilen" in Aufteilen: the total minus every row's amount. */
export function splitRemaining(split: SplitFields): number {
  return cents(split.total) - split.rows.reduce((sum, row) => sum + cents(row.amount), 0);
}

/**
 * Why the editor may not save (`save`: a proposal may stay unbalanced, but every line needs an
 * account and an amount) or book (`book`: also balanced, at least two lines, and in Aufteilen
 * nothing left to distribute). Empty means allowed.
 */
export function editorIssues(state: EditorLinesState, purpose: "save" | "book"): EditorIssue[] {
  const issues = new Set<EditorIssue>();
  const bases = buildBaseLines(state);
  if (bases.some((line) => line.accountNumber === "")) issues.add("account_missing");
  if (bases.length === 0 || bases.some((line) => line.amountCents === 0)) issues.add("amount_missing");
  if (state.mode === "split" && splitRemaining(state.split) !== 0) issues.add("remaining");
  if (purpose === "book") {
    const lines = expandTaxLines(bases);
    if (bases.length < 2) issues.add("too_few_lines");
    else if (lineDifference(lines) !== 0) issues.add("unbalanced");
  }
  return EDITOR_ISSUES.filter((issue) => issues.has(issue));
}

/** The action payload's lines (`lineInputSchema`). */
export function toLineInputs(state: EditorLinesState) {
  return buildBaseLines(state).map((line) => ({
    accountNumber: line.accountNumber,
    amountCents: line.amountCents,
    taxCode: line.taxCode ?? null,
    amountMode: line.amountMode,
    taxCents: line.taxCents ?? null,
    documentId: line.documentId ?? null,
    text: line.text ?? null,
  }));
}

// -------------------------------------------------------------------------------------------
// Recognizing a template in existing lines
// -------------------------------------------------------------------------------------------

type BaseItem = { accountNumber: string; net: number; gross: number; taxCode: TaxCode | null; printedTax: number | null; documentId: string | null; text: string | null };

/** Base lines with their generated input or output tax folded back in (gross), the tax kept
 * as printed tax. A § 13b pair cancels itself out and is simply dropped. */
function baseItems(lines: readonly ModelLine[]): BaseItem[] {
  return lines
    .filter((line) => line.taxRole !== "tax")
    .map((line) => {
      const def = line.taxCode ? TAX_CODE_DEFINITIONS[line.taxCode] : null;
      const folds = def !== null && (def.kind === "input" || def.kind === "output");
      const tax = folds ? lines.filter((other) => other.taxRole === "tax" && other.generatedFromLinePosition === line.position).reduce((sum, other) => sum + other.amountCents, 0) : 0;
      return { accountNumber: line.accountNumber, net: line.amountCents, gross: line.amountCents + tax, taxCode: line.taxCode, printedTax: folds ? Math.abs(tax) : null, documentId: line.documentId, text: line.text };
    });
}

const kindOf = (code: TaxCode | null) => (code ? TAX_CODE_DEFINITIONS[code].kind : null);

function sides(items: BaseItem[]): { debit: BaseItem; credit: BaseItem } | null {
  if (items.length !== 2) return null;
  const debit = items.find((item) => item.gross > 0);
  const credit = items.find((item) => item.gross < 0);
  if (!debit || !credit || debit.gross !== -credit.gross) return null;
  return { debit, credit };
}

function simpleFrom(item: BaseItem, counter: BaseItem): SimpleFields {
  return {
    accountNumber: item.accountNumber,
    amount: formatAmountInput(item.gross),
    amountMode: "gross",
    taxCode: item.taxCode ?? "",
    taxCents: item.printedTax,
    paymentAccountNumber: counter.accountNumber,
    baseDocumentId: item.documentId,
    counterDocumentId: counter.documentId,
  };
}

function fitExpense(items: BaseItem[]): EditorLinesState | null {
  const pair = sides(items);
  if (!pair || pair.credit.taxCode !== null || kindOf(pair.debit.taxCode) === "output") return null;
  return { mode: "expense", simple: simpleFrom(pair.debit, pair.credit) };
}

function fitIncome(items: BaseItem[]): EditorLinesState | null {
  const pair = sides(items);
  if (!pair || pair.debit.taxCode !== null) return null;
  const kind = kindOf(pair.credit.taxCode);
  if (kind === "input" || kind === "reverse_charge") return null;
  return { mode: "income", simple: simpleFrom(pair.credit, pair.debit) };
}

function fitTransfer(items: BaseItem[]): EditorLinesState | null {
  const pair = sides(items);
  if (!pair || pair.debit.taxCode !== null || pair.credit.taxCode !== null) return null;
  return {
    mode: "transfer",
    transfer: {
      fromAccountNumber: pair.credit.accountNumber,
      toAccountNumber: pair.debit.accountNumber,
      amount: formatAmountInput(pair.debit.gross),
      fromDocumentId: pair.credit.documentId,
      toDocumentId: pair.debit.documentId,
    },
  };
}

function fitSplit(items: BaseItem[]): EditorLinesState | null {
  if (items.length < 2 || items.some((item) => item.gross === 0)) return null;
  // The counter is the one line without a tax code whose sign no other line shares; a credit
  // counter (an expense paid) is preferred when two lines would qualify.
  const candidates = items.filter((item) => item.taxCode === null && items.filter((other) => Math.sign(other.gross) === Math.sign(item.gross)).length === 1);
  const counter = candidates.find((item) => item.gross < 0) ?? candidates[0];
  if (!counter) return null;
  const rows = items.filter((item) => item !== counter);
  if (rows.reduce((sum, item) => sum + item.gross, 0) !== -counter.gross) return null;
  const direction: SimpleDirection = counter.gross < 0 ? "expense" : "income";
  const wrongTax = rows.some((row) => {
    const kind = kindOf(row.taxCode);
    return direction === "expense" ? kind === "output" : kind === "input" || kind === "reverse_charge";
  });
  if (wrongTax) return null;
  return {
    mode: "split",
    split: {
      direction,
      total: formatAmountInput(counter.gross),
      paymentAccountNumber: counter.accountNumber,
      counterDocumentId: counter.documentId,
      rows: rows.map((row) => ({ key: rowKey(), accountNumber: row.accountNumber, amount: formatAmountInput(row.gross), taxCode: row.taxCode ?? "", taxCents: row.printedTax, documentId: row.documentId })),
    },
  };
}

function expertFrom(lines: readonly ModelLine[]): EditorLinesState {
  const rows = baseItems(lines).map(
    (item): ExpertRow => ({
      key: rowKey(),
      accountNumber: item.accountNumber,
      debit: item.net > 0 ? formatAmountInput(item.net) : "",
      credit: item.net < 0 ? formatAmountInput(item.net) : "",
      taxCode: item.taxCode ?? "",
      taxCents: item.printedTax,
      text: item.text ?? "",
      documentId: item.documentId,
    }),
  );
  while (rows.length < 2) rows.push(emptyExpertRow());
  return { mode: "expert", rows };
}

function balanced(lines: readonly ModelLine[]): boolean {
  return lines.length >= 2 && lineDifference(lines) === 0 && lines.every((line) => line.accountNumber !== "" && line.amountCents !== 0);
}

/** The lines in exactly this mode, or `null` when they do not fit it. Expert always fits. */
export function fitMode(lines: readonly ModelLine[], mode: EditorMode): EditorLinesState | null {
  if (mode === "expert") return expertFrom(lines);
  if (!balanced(lines)) return null;
  const items = baseItems(lines);
  if (mode === "expense") return fitExpense(items);
  if (mode === "income") return fitIncome(items);
  if (mode === "transfer") return fitTransfer(items);
  return fitSplit(items);
}

/** The mode that describes existing lines best: Ausgabe or Einnahme by the accounts and tax
 * codes, Umbuchung without any tax, Aufteilen for several lines on one side, else Experte. */
export function detectMode(lines: readonly ModelLine[], accounts: ReadonlyMap<string, AccountFacts>): EditorLinesState {
  if (lines.length === 0) return emptyState("expense");
  if (!balanced(lines)) return expertFrom(lines);
  const items = baseItems(lines);
  if (items.length === 2) {
    const pair = sides(items);
    if (pair) {
      const debitKind = accounts.get(pair.debit.accountNumber)?.kind;
      const creditKind = accounts.get(pair.credit.accountNumber)?.kind;
      const order: EditorMode[] = [];
      if (debitKind === "expense" || kindOf(pair.debit.taxCode) === "input" || kindOf(pair.debit.taxCode) === "reverse_charge") order.push("expense");
      if (creditKind === "revenue" || kindOf(pair.credit.taxCode) === "output") order.push("income");
      order.push("transfer");
      for (const mode of order) {
        const fitted = fitMode(lines, mode);
        if (fitted) return fitted;
      }
    }
  }
  if (items.length >= 3) {
    const split = fitMode(lines, "split");
    if (split) return split;
  }
  return expertFrom(lines);
}

/** What a mode carries over when the lines do not fit the target mode exactly. */
type Carry = { direction: SimpleDirection; accountNumber: string; taxCode: TaxCodeField; amount: string; paymentAccountNumber: string };

function carryOf(state: EditorLinesState): Carry | null {
  switch (state.mode) {
    case "expense":
    case "income":
      return { direction: state.mode, accountNumber: state.simple.accountNumber, taxCode: state.simple.taxCode, amount: state.simple.amount, paymentAccountNumber: state.simple.paymentAccountNumber };
    case "transfer":
      return { direction: "expense", accountNumber: state.transfer.toAccountNumber, taxCode: "", amount: state.transfer.amount, paymentAccountNumber: state.transfer.fromAccountNumber };
    case "split": {
      const filled = state.split.rows.filter((row) => row.accountNumber !== "" || row.amount.trim() !== "");
      if (filled.length > 1) return null;
      const row = filled[0];
      return { direction: state.split.direction, accountNumber: row?.accountNumber ?? "", taxCode: row?.taxCode ?? "", amount: state.split.total || row?.amount || "", paymentAccountNumber: state.split.paymentAccountNumber };
    }
    case "expert": {
      const filled = state.rows.some((row) => row.accountNumber !== "" || row.debit.trim() !== "" || row.credit.trim() !== "");
      return filled ? null : { direction: "expense", accountNumber: "", taxCode: "", amount: "", paymentAccountNumber: "" };
    }
  }
}

/**
 * Switches modes keeping the lines: exactly when they fit the target mode, else carrying over
 * what still makes sense (the amount, the payment account; the account and tax code only within
 * the same direction). `blocked` when that would drop lines: several split rows or a filled
 * expert grid that fits no template ("Diese Buchung passt in keine Vorlage").
 */
export function switchMode(state: EditorLinesState, target: EditorMode): { state: EditorLinesState } | { blocked: true } {
  if (state.mode === target) return { state };
  const lines = expandedLines(state);
  if (target === "expert") return { state: expertFrom(lines.filter((line) => line.accountNumber !== "" || line.amountCents !== 0)) };
  const fitted = fitMode(lines, target);
  if (fitted) return { state: fitted };
  const carry = carryOf(state);
  if (!carry) return { blocked: true };

  const direction: SimpleDirection = target === "income" || target === "expense" ? target : carry.direction;
  const sameDirection = direction === carry.direction;
  const payment = !sameDirection && carry.paymentAccountNumber === openAccountFor(carry.direction) ? openAccountFor(direction) : carry.paymentAccountNumber;
  const account = sameDirection ? carry.accountNumber : "";
  const taxCode = sameDirection ? carry.taxCode : "";

  switch (target) {
    case "expense":
    case "income":
      return { state: { mode: target, simple: { ...emptySimple(payment), accountNumber: account, taxCode, amount: carry.amount } } };
    case "transfer":
      return { state: { mode: "transfer", transfer: { fromAccountNumber: carry.paymentAccountNumber, toAccountNumber: carry.accountNumber, amount: carry.amount, fromDocumentId: null, toDocumentId: null } } };
    case "split":
      return {
        state: {
          mode: "split",
          split: {
            direction,
            total: carry.amount,
            paymentAccountNumber: payment,
            counterDocumentId: null,
            rows: [{ ...emptySplitRow(), accountNumber: account, taxCode, amount: carry.amount }, emptySplitRow()],
          },
        },
      };
  }
}

/** Reversing lines for "Korrektur buchen": every base line with its sign flipped and its tax
 * code kept, so the generated tax lines reverse as well. */
export function reversedLines(lines: readonly ModelLine[]): EditorLinesState {
  const expert = expertFrom(lines);
  if (expert.mode !== "expert") return expert;
  return { mode: "expert", rows: expert.rows.map((row) => ({ ...row, key: rowKey(), debit: row.credit, credit: row.debit })) };
}
