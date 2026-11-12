"use client";

import { Fragment, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";

import { Button, cn, Input, Label } from "@/shared/ui-primitives";

import { createBookingRuleAction, deleteBookingRuleAction, updateBookingRuleAction } from "../actions";
import type { LedgerActionErrorCode } from "../core/error-codes";
import { RULE_TAX_CODES_BY_DIRECTION, ruleTaxCodeFits, type RuleInput } from "../core/schemas";
import { BOOKING_RULE_DIRECTIONS, LEDGER_ACCOUNT_GROUPS, type BookingRuleDirection, type BookingRuleView, type LedgerAccountView, type TaxCode } from "../core/types";
import { AccountTag } from "./account-tag";
import { PILL_CLASSES, SELECT_CLASSES } from "./format";

export type RuleContactOption = { id: string; name: string };

type Outcome = { status: "success" } | { status: "error"; errorCode: LedgerActionErrorCode };

function useRun() {
  const router = useRouter();
  const [errorCode, setErrorCode] = useState<LedgerActionErrorCode | null>(null);
  const [pending, startTransition] = useTransition();
  return {
    errorCode,
    pending,
    run(work: () => Promise<Outcome>, onSuccess?: () => void) {
      setErrorCode(null);
      startTransition(async () => {
        const result = await work();
        if (result.status === "error") {
          setErrorCode(result.errorCode);
          return;
        }
        onSuccess?.();
        router.refresh();
      });
    },
  };
}

function ruleInputOf(rule: BookingRuleView): RuleInput {
  return {
    contactId: rule.contactId,
    counterpartyPattern: rule.counterpartyPattern,
    direction: rule.direction,
    accountNumber: rule.accountNumber,
    taxCode: rule.taxCode,
    paymentAccountNumber: rule.paymentAccountNumber,
    noDocument: rule.noDocument,
    active: rule.active,
    learnedFromEntryId: rule.learnedFromEntryId,
  };
}

/** An account select grouped like the accounts page ("6810 Internetkosten"). */
function AccountSelect({ id, value, onChange, accounts, emptyLabel, required }: { id: string; value: string; onChange: (value: string) => void; accounts: readonly LedgerAccountView[]; emptyLabel: string; required?: boolean }) {
  const t = useTranslations("Ledger");
  return (
    <select id={id} value={value} required={required} onChange={(event) => onChange(event.target.value)} className={SELECT_CLASSES}>
      <option value="">{emptyLabel}</option>
      {LEDGER_ACCOUNT_GROUPS.map((group) => {
        const options = accounts.filter((account) => account.group === group && (!account.archived || account.number === value));
        if (options.length === 0) return null;
        return (
          <optgroup key={group} label={t(`groups.${group}`)}>
            {options.map((account) => (
              <option key={account.number} value={account.number}>
                {account.number} {account.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

/**
 * The create and edit form of a booking rule: who it applies to (a contact, or a text the
 * counterparty contains), the direction, the account and tax code it proposes, the account it
 * books the payment against (else the usual payables or receivables), and whether it covers bank
 * transactions without a document (the share capital).
 */
export function RuleForm({ rule, accounts, contacts, onDone }: { rule: BookingRuleView | null; accounts: readonly LedgerAccountView[]; contacts: readonly RuleContactOption[]; onDone: () => void }) {
  const t = useTranslations("Ledger");
  const { errorCode, pending, run } = useRun();
  const initial = rule ? ruleInputOf(rule) : null;
  const [contactId, setContactId] = useState(initial?.contactId ?? "");
  const [pattern, setPattern] = useState(initial?.counterpartyPattern ?? "");
  const [direction, setDirection] = useState<BookingRuleDirection>(initial?.direction ?? "outgoing");
  const [accountNumber, setAccountNumber] = useState(initial?.accountNumber ?? "");
  const [taxCode, setTaxCode] = useState<TaxCode | "">(initial?.taxCode ?? "");
  const [paymentAccountNumber, setPaymentAccountNumber] = useState(initial?.paymentAccountNumber ?? "");
  const [noDocument, setNoDocument] = useState(initial?.noDocument ?? false);
  const [active, setActive] = useState(initial?.active ?? true);
  const id = rule ? `rule-${rule.id}` : "rule-new";

  const missingWho = contactId === "" && pattern.trim() === "";
  const valid = !missingWho && accountNumber !== "" && ruleTaxCodeFits(direction, taxCode || null);

  /** Input tax only on the expense side, output tax only on the revenue side: a code the new
   * direction does not allow is dropped. */
  function changeDirection(next: BookingRuleDirection) {
    setDirection(next);
    if (taxCode && !ruleTaxCodeFits(next, taxCode)) setTaxCode("");
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    const input: RuleInput = {
      contactId: contactId || null,
      counterpartyPattern: pattern.trim() || null,
      direction,
      accountNumber,
      taxCode: taxCode || null,
      paymentAccountNumber: paymentAccountNumber || null,
      noDocument,
      active,
      learnedFromEntryId: initial?.learnedFromEntryId ?? null,
    };
    run(() => (rule ? updateBookingRuleAction({ ruleId: rule.id, rule: input }) : createBookingRuleAction(input)), onDone);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border border-border p-4" aria-label={rule ? t("rules.editHeading") : t("rules.createHeading")}>
      <p className="font-medium text-foreground">{rule ? t("rules.editHeading") : t("rules.createHeading")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-contact`}>{t("rules.contact")}</Label>
          <select id={`${id}-contact`} value={contactId} onChange={(event) => setContactId(event.target.value)} className={SELECT_CLASSES}>
            <option value="">{t("rules.noContact")}</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-pattern`}>{t("rules.pattern")}</Label>
          <Input id={`${id}-pattern`} maxLength={200} value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder={t("rules.patternPlaceholder")} aria-describedby={`${id}-who-hint`} />
        </div>
      </div>
      <p id={`${id}-who-hint`} className={cn("text-xs", missingWho ? "text-destructive" : "text-muted-foreground")}>
        {t("rules.whoHint")}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-direction`}>{t("rules.direction")}</Label>
          <select id={`${id}-direction`} value={direction} onChange={(event) => changeDirection(event.target.value as BookingRuleDirection)} className={SELECT_CLASSES}>
            {BOOKING_RULE_DIRECTIONS.map((value) => (
              <option key={value} value={value}>
                {t(`ruleDirections.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-account`}>{t("rules.account")}</Label>
          <AccountSelect id={`${id}-account`} value={accountNumber} onChange={setAccountNumber} accounts={accounts} emptyLabel={t("rules.chooseAccount")} required />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-tax`}>{t("rules.taxCode")}</Label>
          <select id={`${id}-tax`} value={taxCode} onChange={(event) => setTaxCode(event.target.value as TaxCode | "")} className={SELECT_CLASSES}>
            <option value="">{t("rules.noTax")}</option>
            {RULE_TAX_CODES_BY_DIRECTION[direction].map((code) => (
              <option key={code} value={code}>
                {t(`taxCodes.${code}.label`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-payment`}>{t("rules.paymentAccount")}</Label>
          <AccountSelect id={`${id}-payment`} value={paymentAccountNumber} onChange={setPaymentAccountNumber} accounts={accounts.filter((account) => account.openItems || account.group === "bank")} emptyLabel={t("rules.defaultPaymentAccount")} />
          <p className="text-xs text-muted-foreground">{t("rules.paymentAccountHint")}</p>
        </div>
        <div className="flex flex-col gap-2 pt-1">
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="checkbox" checked={noDocument} onChange={(event) => setNoDocument(event.target.checked)} className="mt-0.5" />
            <span className="flex flex-col">
              {t("rules.noDocument")}
              <span className="text-xs text-muted-foreground">{t("rules.noDocumentHint")}</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
            {t("rules.active")}
          </label>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!valid || pending}>
          {rule ? t("rules.save") : t("rules.create")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
    </form>
  );
}

function RuleActions({ rule, onEdit }: { rule: BookingRuleView; onEdit: () => void }) {
  const t = useTranslations("Ledger");
  const { errorCode, pending, run } = useRun();
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (confirmDelete) {
    return (
      <div role="alertdialog" aria-label={t("rules.deleteConfirm")} className="flex flex-col items-end gap-1">
        <p className="text-xs text-foreground">{t("rules.deleteConfirm")}</p>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => run(() => deleteBookingRuleAction({ ruleId: rule.id }))}>
            {t("rules.deleteSubmit")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
          <Pencil aria-hidden />
          {t("rules.edit")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => updateBookingRuleAction({ ruleId: rule.id, rule: { ...ruleInputOf(rule), active: !rule.active } }))}>
          {rule.active ? t("rules.deactivate") : t("rules.activate")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label={t("rules.delete")}>
          <Trash2 aria-hidden />
        </Button>
      </div>
      {errorCode ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Einstellungen > Regeln" (decisions/0080 UI concept B, screen I): every booking rule with whom
 * it applies to, direction, account, tax code, payment account, "ohne Beleg", hits and whether
 * it is active; create, edit, deactivate and delete (behind an inline confirmation).
 */
export function RulesSettings({ rules, accounts, contacts, canManage }: { rules: readonly BookingRuleView[]; accounts: readonly LedgerAccountView[]; contacts: readonly RuleContactOption[]; canManage: boolean }) {
  const t = useTranslations("Ledger");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const names = new Map(accounts.map((account) => [account.number, account.name]));
  const contactNames = new Map(contacts.map((contact) => [contact.id, contact.name]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-muted-foreground">{t("rules.intro")}</p>
        {canManage && editing === null ? (
          <Button type="button" variant="outline" onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            {t("rules.new")}
          </Button>
        ) : null}
      </div>
      {editing === "new" ? <RuleForm rule={null} accounts={accounts} contacts={contacts} onDone={() => setEditing(null)} /> : null}
      {rules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{t("rules.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t("rules.caption")}</caption>
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("rules.columns.who")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("rules.columns.direction")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("rules.columns.account")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("rules.columns.tax")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("rules.columns.payment")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("rules.columns.noDocument")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("rules.columns.hits")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("rules.columns.active")}
                </th>
                {canManage ? (
                  <th scope="col" className="px-3 py-2 font-medium">
                    <span className="sr-only">{t("rules.columns.actions")}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <Fragment key={rule.id}>
                  <tr className={cn("border-t border-border align-top", !rule.active && "text-muted-foreground")} data-rule={rule.id}>
                    <td className="px-3 py-2">
                      <span className="flex flex-col gap-0.5">
                        {rule.contactId ? (
                          <Link href={`/dashboard/contacts/${rule.contactId}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                            {contactNames.get(rule.contactId) ?? t("rules.unknownContact")}
                          </Link>
                        ) : null}
                        {rule.counterpartyPattern ? <span className="text-xs">{t("rules.patternValue", { pattern: rule.counterpartyPattern })}</span> : null}
                        {rule.learnedFromEntryId ? (
                          <Link href={`/dashboard/buchhaltung/buchung/${rule.learnedFromEntryId}`} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
                            {t("rules.learned")}
                          </Link>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-3 py-2">{t(`ruleDirections.${rule.direction}`)}</td>
                    <td className="px-3 py-2">
                      <AccountTag name={names.get(rule.accountNumber) ?? rule.accountNumber} number={rule.accountNumber} />
                    </td>
                    <td className="px-3 py-2">{rule.taxCode ? t(`taxCodes.${rule.taxCode}.label`) : ""}</td>
                    <td className="px-3 py-2">{rule.paymentAccountNumber ? <AccountTag name={names.get(rule.paymentAccountNumber) ?? rule.paymentAccountNumber} number={rule.paymentAccountNumber} /> : <span className="text-xs text-muted-foreground">{t("rules.defaultPaymentShort")}</span>}</td>
                    <td className="px-3 py-2">{rule.noDocument ? <Check aria-label={t("rules.yes")} className="size-4" /> : null}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{rule.hits}</td>
                    <td className="px-3 py-2">
                      <span className={cn(PILL_CLASSES, rule.active ? "bg-brand-positive/10 text-brand-positive" : "bg-muted text-muted-foreground")}>{rule.active ? t("rules.isActive") : t("rules.isInactive")}</span>
                    </td>
                    {canManage ? (
                      <td className="px-3 py-2">
                        <RuleActions rule={rule} onEdit={() => setEditing(rule.id)} />
                      </td>
                    ) : null}
                  </tr>
                  {editing === rule.id ? (
                    <tr>
                      <td colSpan={canManage ? 9 : 8} className="px-3 pb-3">
                        <RuleForm rule={rule} accounts={accounts} contacts={contacts} onDone={() => setEditing(null)} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
