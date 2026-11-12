"use client";

import { useId, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Lock, Plus, Trash2 } from "lucide-react";

import { Button, buttonVariants, cn, Input, Label } from "@/shared/ui-primitives";

import {
  bookJournalEntryAction,
  createJournalEntryAction,
  deleteJournalEntryAction,
  dismissProposalAction,
  learnLedgerRuleFromEntryAction,
  restoreProposalAction,
  unbookJournalEntryAction,
  updateJournalEntryAction,
} from "../actions";
import type { LedgerActionErrorCode } from "../core/error-codes";
import { PAYABLES_ACCOUNT, RECEIVABLES_ACCOUNT } from "../core/proposals";
import { TAX_CODES, type FilingRef, type JournalEntryOrigin, type JournalEntryStatus, type LedgerAccountView, type LedgerSourceDocument, type LedgerSourceTransaction, type TaxCode } from "../core/types";
import { AccountCombobox } from "./account-combobox";
import { EntryLinesTable } from "./entry-lines-table";
import {
  EDITOR_MODES,
  editorIssues,
  emptyExpertRow,
  emptySimple,
  emptySplitRow,
  emptyState,
  expandedLines,
  detectMode,
  openAccountFor,
  reversedLines,
  splitRemaining,
  switchMode,
  toLineInputs,
  type EditorLinesState,
  type EditorMode,
  type ExpertRow,
  type ModelLine,
  type SimpleDirection,
  type SimpleFields,
  type SplitRow,
  type TaxCodeField,
} from "./editor-model";
import { formatAmountInput, formatCents, GRID_INPUT_CLASSES, SELECT_CLASSES } from "./format";
import { useFilingLabel } from "./period-name";

/** The entry the editor shows; `id: null` for a new one (`/buchung/neu`). */
export type EditorEntry = {
  id: string | null;
  status: JournalEntryStatus | null;
  dismissed: boolean;
  origin: JournalEntryOrigin;
  revision: number;
  bookingDate: string;
  documentDate: string | null;
  serviceDate: string | null;
  text: string;
  documentId: string | null;
  transactionId: string | null;
  correctionOfEntryId: string | null;
  filingId: string | null;
  lines: readonly ModelLine[];
};

/** Where the starting lines come from: the entry's own, a document or bank transaction to book
 * (`?beleg=`, `?umsatz=`), or the entry's lines reversed ("Korrektur buchen", `?korrektur=`). */
export type EditorSeed = "entry" | "document" | "transaction" | "reverse";

const EXPENSE_TAX_CODES: readonly TaxCode[] = ["vst19", "vst7", "rc13b", "pass_through", "not_taxable", "tax_free"];
const INCOME_TAX_CODES: readonly TaxCode[] = ["ust19", "ust7", "eu_not_taxable", "tax_free", "not_taxable"];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A tax code a document's printed figures suggest, for the direction booked. */
function documentTaxCode(document: LedgerSourceDocument, direction: SimpleDirection): { taxCode: TaxCodeField; taxCents: number | null } {
  if (direction === "expense" && document.reverseCharge) return { taxCode: "rc13b", taxCents: null };
  const rates = (document.taxBreakdown ?? []).filter((entry) => entry.ratePercent > 0);
  if (rates.length !== 1) return { taxCode: "", taxCents: null };
  const rate = rates[0]!.ratePercent;
  const codes: Record<number, Record<SimpleDirection, TaxCode>> = { 19: { expense: "vst19", income: "ust19" }, 7: { expense: "vst7", income: "ust7" } };
  const code: TaxCodeField = codes[rate]?.[direction] ?? "";
  const taxCents = code && document.taxTotalCents !== null ? Math.abs(document.taxTotalCents) : null;
  return { taxCode: code, taxCents };
}

function initialLines(entry: EditorEntry, seed: EditorSeed, accounts: readonly LedgerAccountView[], document: LedgerSourceDocument | null, transaction: LedgerSourceTransaction | null): EditorLinesState {
  const byNumber = new Map(accounts.map((account) => [account.number, account]));
  if (seed === "reverse") return reversedLines(entry.lines);
  if (seed === "document" && document) {
    const direction: SimpleDirection = document.direction === "outgoing" ? "income" : "expense";
    const contactAccount = document.contactId ? accounts.find((account) => account.ownerContactId === document.contactId && account.openItems && !account.archived) : undefined;
    const simple: SimpleFields = {
      ...emptySimple(contactAccount?.number ?? openAccountFor(direction)),
      ...documentTaxCode(document, direction),
      amount: document.totalAmountCents === null ? "" : formatAmountInput(document.totalAmountCents),
      baseDocumentId: document.id,
      counterDocumentId: document.id,
    };
    return { mode: direction, simple };
  }
  if (seed === "transaction" && transaction) {
    const bank = accounts.find((account) => account.ownerBankAccountId === transaction.accountId && !account.archived);
    const direction: SimpleDirection = transaction.amountCents < 0 ? "expense" : "income";
    return { mode: direction, simple: { ...emptySimple(bank?.number ?? ""), amount: formatAmountInput(transaction.amountCents) } };
  }
  if (entry.lines.length === 0) return emptyState("expense", PAYABLES_ACCOUNT);
  return detectMode(entry.lines, byNumber);
}

function initialText(entry: EditorEntry, seed: EditorSeed, document: LedgerSourceDocument | null, transaction: LedgerSourceTransaction | null): string {
  if (entry.text) return entry.text;
  if (seed === "document" && document) return [document.contactName ?? document.sender, document.title ?? document.invoiceNumber].filter(Boolean).join(", ");
  if (seed === "transaction" && transaction) return [transaction.counterpartyName, transaction.remittanceText].filter(Boolean).join(", ").slice(0, 500);
  return "";
}

/**
 * The booking editor (`/dashboard/buchhaltung/buchung/[id]` and `/buchung/neu`, decisions/0080
 * UI concepts A and B). Simple modes ask in plain words (Wofür? Wie viel? Welche Steuer?
 * Bezahlt über?), the expert grid shows the raw lines; both feed the live "So wird gebucht"
 * table computed with the same `expandTaxLines` the use case books with. Booking needs balanced
 * lines; changing a booked entry needs a reason; an entry a filing locks is read-only and is
 * corrected by a new entry ("Korrektur buchen").
 */
export function EntryEditor({
  entry,
  seed,
  accounts,
  sourceDocument,
  sourceTransaction,
  canManage,
  lockedBy,
  ruleSubject,
}: {
  entry: EditorEntry;
  seed: EditorSeed;
  accounts: readonly LedgerAccountView[];
  sourceDocument: LedgerSourceDocument | null;
  sourceTransaction: LedgerSourceTransaction | null;
  canManage: boolean;
  /** The submitted filing that locks the entry, if any. */
  lockedBy: FilingRef | null;
  /** The contact or counterparty "Für <Kontakt> künftig so vorschlagen" names; `null` hides it. */
  ruleSubject: string | null;
}) {
  const t = useTranslations("Ledger");
  const router = useRouter();
  const formId = useId();
  const filingLabel = useFilingLabel();
  const lockedLabel = lockedBy ? filingLabel(lockedBy) : null;
  const [pending, startTransition] = useTransition();

  const [lines, setLines] = useState<EditorLinesState>(() => initialLines(entry, seed, accounts, sourceDocument, sourceTransaction));
  const [bookingDate, setBookingDate] = useState(() => entry.bookingDate || sourceDocument?.documentDate || sourceTransaction?.bookingDate || today());
  const [documentDate, setDocumentDate] = useState(() => entry.documentDate ?? sourceDocument?.documentDate ?? "");
  const [serviceDate, setServiceDate] = useState(() => entry.serviceDate ?? sourceDocument?.serviceDate ?? "");
  const [text, setText] = useState(() => initialText(entry, seed, sourceDocument, sourceTransaction));
  const [reason, setReason] = useState("");
  const [learnRule, setLearnRule] = useState(entry.origin === "ai");
  const [errorCode, setErrorCode] = useState<LedgerActionErrorCode | null>(null);
  const [reasonMissing, setReasonMissing] = useState(false);
  const [switchBlocked, setSwitchBlocked] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isNew = entry.id === null;
  const booked = entry.status === "booked";
  const readOnly = !canManage || lockedLabel !== null || entry.dismissed;
  const activeAccounts = useMemo(() => accounts.filter((account) => !account.archived), [accounts]);
  const accountsByNumber = useMemo(() => new Map(accounts.map((account) => [account.number, account])), [accounts]);

  const payload = () => ({
    bookingDate,
    documentDate: documentDate || null,
    serviceDate: serviceDate || null,
    text: text.trim(),
    lines: toLineInputs(lines),
    documentId: entry.documentId,
    transactionId: entry.transactionId,
    correctionOfEntryId: entry.correctionOfEntryId,
    filingId: entry.filingId,
  });
  const [initialPayload] = useState(() => JSON.stringify(payload()));
  const dirty = JSON.stringify(payload()) !== initialPayload;

  const expanded = expandedLines(lines);
  const displayLines = expanded.map((line) => ({ ...line, accountName: accountsByNumber.get(line.accountNumber)?.name ?? "" }));
  const bookIssues = editorIssues(lines, "book");
  const saveIssues = editorIssues(lines, "save");
  const headerIncomplete = text.trim() === "" || bookingDate === "";

  // Accounts in the order a mode needs them: the likely ones first, the rest of the chart after.
  const sortedFor = (preferred: LedgerAccountView["kind"] | null) =>
    preferred ? [...activeAccounts.filter((account) => account.kind === preferred), ...activeAccounts.filter((account) => account.kind !== preferred)] : activeAccounts;

  function changeMode(target: EditorMode) {
    if (readOnly) return;
    const result = switchMode(lines, target);
    if ("blocked" in result) {
      setSwitchBlocked(true);
      return;
    }
    setSwitchBlocked(false);
    setLines(result.state);
  }

  // -- actions ---------------------------------------------------------------------------------

  async function maybeLearnRule(entryId: string): Promise<boolean> {
    if (!learnRule || !ruleSubject) return true;
    const result = await learnLedgerRuleFromEntryAction({ entryId });
    if (result.status === "error") {
      setErrorCode(result.errorCode);
      return false;
    }
    return true;
  }

  function run(work: () => Promise<void>) {
    setErrorCode(null);
    setNotice(null);
    startTransition(work);
  }

  function requireReason(): boolean {
    if (booked && reason.trim() === "") {
      setReasonMissing(true);
      return false;
    }
    setReasonMissing(false);
    return true;
  }

  function save() {
    if (!requireReason()) return;
    run(async () => {
      if (isNew) {
        const result = await createJournalEntryAction({ entry: payload(), book: false });
        if (result.status === "error") return setErrorCode(result.errorCode);
        router.push(`/dashboard/buchhaltung/buchung/${result.data.entryId}`);
        return;
      }
      const result = await updateJournalEntryAction({ entryId: entry.id, entry: payload(), reason: reason.trim() || null, expectedRevision: entry.revision });
      if (result.status === "error") return setErrorCode(result.errorCode);
      if (booked && !(await maybeLearnRule(entry.id!))) return;
      setNotice(t("editor.saved"));
      router.refresh();
    });
  }

  function book() {
    run(async () => {
      let entryId = entry.id;
      if (entryId === null) {
        const result = await createJournalEntryAction({ entry: payload(), book: true });
        if (result.status === "error") return setErrorCode(result.errorCode);
        entryId = result.data.entryId;
      } else {
        if (dirty) {
          const updated = await updateJournalEntryAction({ entryId, entry: payload(), reason: null, expectedRevision: entry.revision });
          if (updated.status === "error") return setErrorCode(updated.errorCode);
        }
        const result = await bookJournalEntryAction({ entryId });
        if (result.status === "error") return setErrorCode(result.errorCode);
      }
      if (!(await maybeLearnRule(entryId))) {
        router.push(`/dashboard/buchhaltung/buchung/${entryId}`);
        return;
      }
      // Back to the work list when the entry came from it (a proposal, or a source without one).
      const fromQueue = (!isNew && entry.origin !== "manual") || seed === "document" || seed === "transaction";
      router.push(fromQueue ? "/dashboard/buchhaltung/zu-pruefen" : `/dashboard/buchhaltung/buchung/${entryId}`);
      router.refresh();
    });
  }

  function unbook() {
    if (!requireReason()) return;
    run(async () => {
      const result = await unbookJournalEntryAction({ entryId: entry.id, reason: reason.trim() });
      if (result.status === "error") return setErrorCode(result.errorCode);
      router.refresh();
    });
  }

  function remove() {
    if (!requireReason()) {
      setConfirmingDelete(false);
      return;
    }
    run(async () => {
      const result = await deleteJournalEntryAction({ entryId: entry.id, reason: reason.trim() || null });
      if (result.status === "error") {
        setConfirmingDelete(false);
        return setErrorCode(result.errorCode);
      }
      router.push("/dashboard/buchhaltung/journal");
    });
  }

  function dismiss() {
    run(async () => {
      const result = await dismissProposalAction({ entryId: entry.id });
      if (result.status === "error") return setErrorCode(result.errorCode);
      router.push("/dashboard/buchhaltung/zu-pruefen");
    });
  }

  function restore() {
    run(async () => {
      const result = await restoreProposalAction({ entryId: entry.id });
      if (result.status === "error") return setErrorCode(result.errorCode);
      router.refresh();
    });
  }

  // -- field pieces ----------------------------------------------------------------------------

  const fieldId = (name: string) => `${formId}-${name}`;

  function taxSelect(id: string, value: TaxCodeField, codes: readonly TaxCode[], onChange: (code: TaxCodeField) => void, describedBy?: string) {
    return (
      <select id={id} className={SELECT_CLASSES} value={value} disabled={readOnly} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value as TaxCodeField)}>
        <option value="">{t("editor.taxNone")}</option>
        {codes.map((code) => (
          <option key={code} value={code}>
            {t(`taxCodes.${code}.label`)}
          </option>
        ))}
      </select>
    );
  }

  function paymentSelect(id: string, value: string, direction: SimpleDirection, onChange: (number: string) => void) {
    const banks = activeAccounts.filter((account) => account.group === "bank" || account.ownerType === "bank_account");
    const openItems = activeAccounts.filter(
      (account) => account.openItems && account.group !== "bank" && account.number !== PAYABLES_ACCOUNT && account.number !== RECEIVABLES_ACCOUNT && account.ownerType !== "bank_account",
    );
    const openAccount = accountsByNumber.get(openAccountFor(direction));
    const listed = new Set([...banks, ...openItems].map((account) => account.number).concat(openAccount ? [openAccount.number] : []));
    const other = value && !listed.has(value) ? accountsByNumber.get(value) : undefined;
    const option = (account: LedgerAccountView, label?: string) => (
      <option key={account.number} value={account.number}>
        {label ?? `${account.name} (${account.number})`}
      </option>
    );
    return (
      <select id={id} className={SELECT_CLASSES} value={value} disabled={readOnly} onChange={(event) => onChange(event.target.value)}>
        <option value="" disabled>
          {t("editor.choose")}
        </option>
        {banks.length > 0 ? <optgroup label={t("editor.groupBank")}>{banks.map((account) => option(account))}</optgroup> : null}
        {openItems.length > 0 ? <optgroup label={t("editor.groupOpenItems")}>{openItems.map((account) => option(account))}</optgroup> : null}
        {openAccount ? (
          <optgroup label={t("editor.groupOpen")}>{option(openAccount, t(direction === "expense" ? "editor.openPayable" : "editor.openReceivable", { number: openAccount.number }))}</optgroup>
        ) : null}
        {other ? <optgroup label={t("editor.groupOther")}>{option(other)}</optgroup> : null}
      </select>
    );
  }

  function amountModeToggle(value: SimpleFields["amountMode"], onChange: (mode: SimpleFields["amountMode"]) => void, disabled: boolean) {
    return (
      <div role="radiogroup" aria-label={t("editor.amountModeLabel")} className="inline-flex rounded-lg border border-border p-0.5">
        {(["gross", "net"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={value === mode}
            disabled={disabled || readOnly}
            onClick={() => onChange(mode)}
            className={cn("rounded-md px-2 py-0.5 text-xs font-medium", value === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
          >
            {t(`amountModes.${mode}`)}
          </button>
        ))}
      </div>
    );
  }

  function simpleForm(state: Extract<EditorLinesState, { mode: "expense" | "income" }>) {
    const direction = state.mode;
    const fields = state.simple;
    const set = (patch: Partial<SimpleFields>) => setLines({ mode: direction, simple: { ...fields, ...patch } });
    const codes = direction === "expense" ? EXPENSE_TAX_CODES : INCOME_TAX_CODES;
    const reverseCharge = fields.taxCode === "rc13b";
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={fieldId("account")}>{t("editor.whatFor")}</Label>
          <AccountCombobox id={fieldId("account")} accounts={sortedFor(direction === "expense" ? "expense" : "revenue")} value={fields.accountNumber} onChange={(accountNumber) => set({ accountNumber })} disabled={readOnly} />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={fieldId("amount")}>{t("editor.amount")}</Label>
            {amountModeToggle(reverseCharge ? "net" : fields.amountMode, (amountMode) => set({ amountMode, taxCents: null }), reverseCharge)}
          </div>
          <Input id={fieldId("amount")} inputMode="decimal" value={fields.amount} disabled={readOnly} onChange={(event) => set({ amount: event.target.value, taxCents: null })} className="text-right tabular-nums" />
          {reverseCharge ? <p className="text-xs text-muted-foreground">{t("editor.reverseChargeNet")}</p> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("tax")}>{t("editor.tax")}</Label>
          {taxSelect(fieldId("tax"), fields.taxCode, codes, (taxCode) => set({ taxCode, taxCents: null }), fieldId("tax-hint"))}
          <p id={fieldId("tax-hint")} className="text-xs text-muted-foreground">
            {fields.taxCode ? t(`taxCodes.${fields.taxCode}.hint`) : t("editor.taxNoneHint")}
          </p>
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={fieldId("payment")}>{t(direction === "expense" ? "editor.paidVia" : "editor.receivedOn")}</Label>
          {paymentSelect(fieldId("payment"), fields.paymentAccountNumber, direction, (paymentAccountNumber) => set({ paymentAccountNumber }))}
        </div>
      </div>
    );
  }

  function transferForm(state: Extract<EditorLinesState, { mode: "transfer" }>) {
    const fields = state.transfer;
    const set = (patch: Partial<typeof fields>) => setLines({ mode: "transfer", transfer: { ...fields, ...patch } });
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("from")}>{t("editor.from")}</Label>
          <AccountCombobox id={fieldId("from")} accounts={activeAccounts} value={fields.fromAccountNumber} onChange={(fromAccountNumber) => set({ fromAccountNumber })} disabled={readOnly} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("to")}>{t("editor.to")}</Label>
          <AccountCombobox id={fieldId("to")} accounts={activeAccounts} value={fields.toAccountNumber} onChange={(toAccountNumber) => set({ toAccountNumber })} disabled={readOnly} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("amount")}>{t("editor.amount")}</Label>
          <Input id={fieldId("amount")} inputMode="decimal" value={fields.amount} disabled={readOnly} onChange={(event) => set({ amount: event.target.value })} className="text-right tabular-nums" />
        </div>
        <p className="self-end text-xs text-muted-foreground sm:pb-2">{t("editor.transferHint")}</p>
      </div>
    );
  }

  function splitForm(state: Extract<EditorLinesState, { mode: "split" }>) {
    const fields = state.split;
    const set = (patch: Partial<typeof fields>) => setLines({ mode: "split", split: { ...fields, ...patch } });
    const setRow = (key: string, patch: Partial<SplitRow>) => set({ rows: fields.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) });
    const codes = fields.direction === "expense" ? EXPENSE_TAX_CODES : INCOME_TAX_CODES;
    const remaining = splitRemaining(fields);
    return (
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId("direction")}>{t("editor.direction")}</Label>
            <select
              id={fieldId("direction")}
              className={SELECT_CLASSES}
              value={fields.direction}
              disabled={readOnly}
              onChange={(event) => {
                const direction = event.target.value as SimpleDirection;
                const payment = fields.paymentAccountNumber === openAccountFor(fields.direction) ? openAccountFor(direction) : fields.paymentAccountNumber;
                set({ direction, paymentAccountNumber: payment, rows: fields.rows.map((row) => ({ ...row, taxCode: "", taxCents: null })) });
              }}
            >
              <option value="expense">{t("editor.modes.expense")}</option>
              <option value="income">{t("editor.modes.income")}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId("total")}>{t("editor.total")}</Label>
            <Input id={fieldId("total")} inputMode="decimal" value={fields.total} disabled={readOnly} onChange={(event) => set({ total: event.target.value })} className="text-right tabular-nums" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId("payment")}>{t(fields.direction === "expense" ? "editor.paidVia" : "editor.receivedOn")}</Label>
            {paymentSelect(fieldId("payment"), fields.paymentAccountNumber, fields.direction, (paymentAccountNumber) => set({ paymentAccountNumber }))}
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-foreground">{t("editor.splitRows")}</legend>
          {fields.rows.map((row, index) => (
            <div key={row.key} className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] items-start gap-2">
              <AccountCombobox accounts={sortedFor(fields.direction === "expense" ? "expense" : "revenue")} value={row.accountNumber} onChange={(accountNumber) => setRow(row.key, { accountNumber })} label={t("editor.rowAccount", { n: index + 1 })} disabled={readOnly} />
              <input
                aria-label={t("editor.rowAmount", { n: index + 1 })}
                inputMode="decimal"
                value={row.amount}
                disabled={readOnly}
                onChange={(event) => setRow(row.key, { amount: event.target.value, taxCents: null })}
                className={cn(GRID_INPUT_CLASSES, "text-right tabular-nums")}
              />
              <select aria-label={t("editor.rowTax", { n: index + 1 })} className={SELECT_CLASSES} value={row.taxCode} disabled={readOnly} onChange={(event) => setRow(row.key, { taxCode: event.target.value as TaxCodeField, taxCents: null })}>
                <option value="">{t("editor.taxNone")}</option>
                {codes.map((code) => (
                  <option key={code} value={code}>
                    {t(`taxCodes.${code}.label`)}
                  </option>
                ))}
              </select>
              <Button type="button" variant="ghost" size="icon" aria-label={t("editor.removeRow", { n: index + 1 })} disabled={readOnly || fields.rows.length <= 1} onClick={() => set({ rows: fields.rows.filter((other) => other.key !== row.key) })}>
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => set({ rows: [...fields.rows, emptySplitRow()] })}>
              <Plus aria-hidden />
              {t("editor.addRow")}
            </Button>
            <p className={cn("text-sm tabular-nums", remaining === 0 ? "text-muted-foreground" : "font-medium text-destructive")} aria-live="polite">
              {t("editor.remaining", { amount: formatCents(remaining) })}
            </p>
          </div>
        </fieldset>
      </div>
    );
  }

  function expertForm(state: Extract<EditorLinesState, { mode: "expert" }>) {
    const rows = state.rows;
    const setRows = (next: ExpertRow[]) => setLines({ mode: "expert", rows: next });
    const setRow = (key: string, patch: Partial<ExpertRow>) => setRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    // Enter in the last row's last field adds a row (DATEV habit); Tab follows the DOM order.
    const onEnter = (event: React.KeyboardEvent, index: number) => {
      if (event.key !== "Enter" || index !== rows.length - 1) return;
      event.preventDefault();
      setRows([...rows, emptyExpertRow()]);
    };
    return (
      <div className="flex flex-col gap-2">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="w-[30%] px-1 py-1 font-medium">
                  {t("editor.expert.account")}
                </th>
                <th scope="col" className="w-[13%] px-1 py-1 text-right font-medium">
                  {t("editor.expert.debit")}
                </th>
                <th scope="col" className="w-[13%] px-1 py-1 text-right font-medium">
                  {t("editor.expert.credit")}
                </th>
                <th scope="col" className="w-[20%] px-1 py-1 font-medium">
                  {t("editor.expert.taxCode")}
                </th>
                <th scope="col" className="px-1 py-1 font-medium">
                  {t("editor.expert.text")}
                </th>
                <th scope="col" className="w-8 px-1 py-1">
                  <span className="sr-only">{t("editor.expert.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.key}>
                  <td className="px-1 py-1">
                    <AccountCombobox accounts={activeAccounts} value={row.accountNumber} onChange={(accountNumber) => setRow(row.key, { accountNumber })} label={t("editor.expert.rowAccount", { n: index + 1 })} disabled={readOnly} />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      aria-label={t("editor.expert.rowDebit", { n: index + 1 })}
                      inputMode="decimal"
                      value={row.debit}
                      disabled={readOnly}
                      onChange={(event) => setRow(row.key, { debit: event.target.value, credit: event.target.value ? "" : row.credit, taxCents: null })}
                      className={cn(GRID_INPUT_CLASSES, "text-right tabular-nums")}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      aria-label={t("editor.expert.rowCredit", { n: index + 1 })}
                      inputMode="decimal"
                      value={row.credit}
                      disabled={readOnly}
                      onChange={(event) => setRow(row.key, { credit: event.target.value, debit: event.target.value ? "" : row.debit, taxCents: null })}
                      className={cn(GRID_INPUT_CLASSES, "text-right tabular-nums")}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <select aria-label={t("editor.expert.rowTax", { n: index + 1 })} className={SELECT_CLASSES} value={row.taxCode} disabled={readOnly} onChange={(event) => setRow(row.key, { taxCode: event.target.value as TaxCodeField, taxCents: null })}>
                      <option value="">{t("editor.taxNone")}</option>
                      {TAX_CODES.map((code) => (
                        <option key={code} value={code}>
                          {t(`taxCodes.${code}.label`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-1 py-1">
                    <input aria-label={t("editor.expert.rowText", { n: index + 1 })} value={row.text} disabled={readOnly} onChange={(event) => setRow(row.key, { text: event.target.value })} onKeyDown={(event) => onEnter(event, index)} className={GRID_INPUT_CLASSES} />
                  </td>
                  <td className="px-1 py-1">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={t("editor.expert.removeRow", { n: index + 1 })} disabled={readOnly || rows.length <= 1} onClick={() => setRows(rows.filter((other) => other.key !== row.key))}>
                      <Trash2 aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => setRows([...rows, emptyExpertRow()])}>
            <Plus aria-hidden />
            {t("editor.expert.addRow")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("editor.expert.netHint")}</p>
        </div>
      </div>
    );
  }

  // -- render ----------------------------------------------------------------------------------

  const canBook = !readOnly && bookIssues.length === 0 && !headerIncomplete;
  const canSave = !readOnly && saveIssues.length === 0 && !headerIncomplete;
  const issueText = (issue: (typeof bookIssues)[number]) =>
    issue === "remaining" && lines.mode === "split" ? t("editor.issues.remaining", { amount: formatCents(splitRemaining(lines.split)) }) : t(`editor.issues.${issue}`);

  function actions() {
    if (confirmingDelete) {
      return (
        <div role="alertdialog" aria-labelledby={fieldId("delete-confirm")} className="flex flex-col gap-3 rounded-lg border border-destructive/50 p-3">
          <p id={fieldId("delete-confirm")} className="text-sm text-foreground">
            {t("editor.deleteConfirm")}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" onClick={remove} disabled={pending} aria-busy={pending}>
              {t("editor.deleteYes")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirmingDelete(false)} disabled={pending}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-2">
        {booked ? (
          <>
            <Button type="button" onClick={save} disabled={pending || !canSave || !dirty || bookIssues.length > 0} aria-busy={pending}>
              {t("editor.saveChanges")}
            </Button>
            <Button type="button" variant="outline" onClick={unbook} disabled={pending}>
              {t("editor.unbook")}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" onClick={book} disabled={pending || !canBook} aria-busy={pending}>
              {pending ? t("editor.pending") : t("editor.book")}
            </Button>
            <Button type="button" variant="outline" onClick={save} disabled={pending || !canSave || (!isNew && !dirty)}>
              {t("editor.saveProposal")}
            </Button>
            {!isNew ? (
              <Button type="button" variant="ghost" onClick={dismiss} disabled={pending}>
                {t("editor.dismiss")}
              </Button>
            ) : null}
          </>
        )}
        {!isNew ? (
          <Button type="button" variant="destructive" className="ml-auto" onClick={() => setConfirmingDelete(true)} disabled={pending}>
            {t("editor.delete")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {lockedLabel ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-4">
          <p className="inline-flex w-fit items-center gap-1.5 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
            <Lock aria-hidden className="size-3" />
            {t("editor.lockedChip", { filing: lockedLabel })}
          </p>
          <p className="text-sm text-muted-foreground">{t("editor.lockedText")}</p>
          {canManage && entry.id ? (
            <div className="flex flex-wrap gap-2">
              <Link href={`/dashboard/buchhaltung/buchung/neu?korrektur=${entry.id}`} className={buttonVariants({ size: "sm" })}>
                {t("editor.correct")}
              </Link>
              <Link href="/dashboard/buchhaltung/auswertungen/zeitraeume" className={buttonVariants({ variant: "outline", size: "sm" })}>
                {t("editor.periods")}
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {entry.dismissed ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border p-3">
          <p className="text-sm text-muted-foreground">{t("editor.dismissedNote")}</p>
          {canManage ? (
            <Button type="button" variant="outline" size="sm" onClick={restore} disabled={pending}>
              {t("editor.restore")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div role="tablist" aria-label={t("editor.modesLabel")} className="flex flex-wrap gap-1 rounded-lg border border-border p-1">
        {EDITOR_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            id={fieldId(`tab-${mode}`)}
            aria-selected={lines.mode === mode}
            aria-controls={fieldId("panel")}
            tabIndex={lines.mode === mode ? 0 : -1}
            disabled={readOnly && lines.mode !== mode}
            onClick={() => changeMode(mode)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              const index = EDITOR_MODES.indexOf(mode);
              const next = EDITOR_MODES[(index + (event.key === "ArrowRight" ? 1 : EDITOR_MODES.length - 1)) % EDITOR_MODES.length]!;
              changeMode(next);
              document.getElementById(fieldId(`tab-${next}`))?.focus();
            }}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              lines.mode === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t(`editor.modes.${mode}`)}
          </button>
        ))}
      </div>
      {switchBlocked ? (
        <p role="alert" className="text-sm text-destructive">
          {t("editor.noTemplate")}
        </p>
      ) : null}

      <div id={fieldId("panel")} role="tabpanel" aria-labelledby={fieldId(`tab-${lines.mode}`)} className="flex flex-col gap-4">
        {lines.mode === "expense" || lines.mode === "income" ? simpleForm(lines) : null}
        {lines.mode === "transfer" ? transferForm(lines) : null}
        {lines.mode === "split" ? splitForm(lines) : null}
        {lines.mode === "expert" ? expertForm(lines) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("document-date")}>{t("editor.documentDate")}</Label>
          <Input id={fieldId("document-date")} type="date" value={documentDate} disabled={readOnly} onChange={(event) => setDocumentDate(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("booking-date")}>{t("editor.bookingDate")}</Label>
          <Input id={fieldId("booking-date")} type="date" required value={bookingDate} disabled={readOnly} onChange={(event) => setBookingDate(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("service-date")}>{t("editor.serviceDate")}</Label>
          <Input id={fieldId("service-date")} type="date" value={serviceDate} disabled={readOnly} onChange={(event) => setServiceDate(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-3">
          <Label htmlFor={fieldId("text")}>{t("editor.text")}</Label>
          <Input id={fieldId("text")} required maxLength={500} value={text} disabled={readOnly} onChange={(event) => setText(event.target.value)} />
        </div>
      </div>

      <section aria-labelledby={fieldId("preview")} className="flex flex-col gap-2">
        <h2 id={fieldId("preview")} className="text-sm font-semibold text-foreground">
          {t("editor.preview")}
        </h2>
        <EntryLinesTable lines={displayLines} caption={t("editor.preview")} />
        {!readOnly && bookIssues.length > 0 ? (
          <ul aria-live="polite" className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {bookIssues.map((issue) => (
              <li key={issue}>{issueText(issue)}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {!readOnly && ruleSubject ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={learnRule} onChange={(event) => setLearnRule(event.target.checked)} />
          <span className="flex flex-col">
            <span className="text-foreground">{t("editor.learnRule", { name: ruleSubject })}</span>
            <span className="text-xs text-muted-foreground">{t("editor.learnRuleHint")}</span>
          </span>
        </label>
      ) : null}

      {!readOnly && booked ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("reason")}>{t("editor.reason")}</Label>
          <Input
            id={fieldId("reason")}
            value={reason}
            maxLength={500}
            aria-invalid={reasonMissing || undefined}
            aria-describedby={fieldId("reason-hint")}
            onChange={(event) => {
              setReason(event.target.value);
              if (event.target.value.trim()) setReasonMissing(false);
            }}
          />
          <p id={fieldId("reason-hint")} className={cn("text-xs", reasonMissing ? "text-destructive" : "text-muted-foreground")} role={reasonMissing ? "alert" : undefined}>
            {reasonMissing ? t("editor.reasonMissing") : t("editor.reasonHint")}
          </p>
        </div>
      ) : null}

      {errorCode ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>{errorCode === "stale_revision" ? t("editor.stale") : t(`errors.${errorCode}`)}</span>
          {errorCode === "stale_revision" ? (
            <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
              {t("editor.reload")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-brand-positive">
          {notice}
        </p>
      ) : null}

      {readOnly ? null : actions()}
    </div>
  );
}
