"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";

import { Button, cn, Input, Label } from "@/shared/ui-primitives";

import { archiveLedgerAccountAction, createLedgerAccountAction, restoreLedgerAccountAction, updateLedgerAccountAction } from "../actions";
import type { LedgerActionErrorCode } from "../core/error-codes";
import {
  LEDGER_ACCOUNT_GROUPS,
  LEDGER_ACCOUNT_KINDS,
  LEDGER_OWNER_TYPES,
  type LedgerAccountGroup,
  type LedgerAccountKind,
  type LedgerAccountView,
  type LedgerOwnerType,
} from "../core/types";
import { PILL_CLASSES, SELECT_CLASSES, TEXTAREA_CLASSES } from "./format";

export type OwnerOption = { id: string; name: string };

/** The settlement platforms an account can belong to (`documents.platform`). */
export const LEDGER_PLATFORMS = [
  { key: "apple", name: "Apple" },
  { key: "google", name: "Google Play" },
  { key: "stripe", name: "Stripe" },
  { key: "paypal", name: "PayPal" },
  { key: "amazon", name: "Amazon" },
] as const;

/** What an owner type usually means for the new account: its kind, group and open items. */
const OWNER_DEFAULTS: Record<LedgerOwnerType, { kind: LedgerAccountKind; group: LedgerAccountGroup; openItems: boolean }> = {
  bank_account: { kind: "asset", group: "bank", openItems: false },
  contact: { kind: "asset", group: "open_items", openItems: true },
  platform: { kind: "asset", group: "open_items", openItems: true },
  person: { kind: "liability", group: "open_items", openItems: true },
};

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

function ownerLabel(account: LedgerAccountView, bankAccounts: readonly OwnerOption[], contacts: readonly OwnerOption[]): string | null {
  switch (account.ownerType) {
    case "bank_account":
      return bankAccounts.find((option) => option.id === account.ownerBankAccountId)?.name ?? null;
    case "contact":
      return contacts.find((option) => option.id === account.ownerContactId)?.name ?? null;
    case "platform":
      return LEDGER_PLATFORMS.find((platform) => platform.key === account.ownerPlatform)?.name ?? account.ownerPlatform;
    case "person":
      return account.ownerPersonName;
    default:
      return null;
  }
}

function ownerOptions(ownerType: LedgerOwnerType, bankAccounts: readonly OwnerOption[], contacts: readonly OwnerOption[]): readonly OwnerOption[] {
  if (ownerType === "bank_account") return bankAccounts;
  if (ownerType === "contact") return contacts;
  return LEDGER_PLATFORMS.map((platform) => ({ id: platform.key, name: platform.name }));
}

function CreateAccountForm({ bankAccounts, contacts, onDone }: { bankAccounts: readonly OwnerOption[]; contacts: readonly OwnerOption[]; onDone: () => void }) {
  const t = useTranslations("Ledger");
  const { errorCode, pending, run } = useRun();
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LedgerAccountKind>("expense");
  const [group, setGroup] = useState<LedgerAccountGroup>("costs");
  const [openItems, setOpenItems] = useState(false);
  const [ownerType, setOwnerType] = useState<LedgerOwnerType | "">("");
  const [owner, setOwner] = useState("");
  const [description, setDescription] = useState("");

  function chooseOwnerType(value: LedgerOwnerType | "") {
    setOwnerType(value);
    setOwner("");
    if (!value) return;
    const defaults = OWNER_DEFAULTS[value];
    setKind(defaults.kind);
    setGroup(defaults.group);
    setOpenItems(defaults.openItems);
  }

  const valid = /^\d{4,8}$/.test(number.trim()) && name.trim() !== "" && (ownerType === "" || owner.trim() !== "");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    run(
      () =>
        createLedgerAccountAction({
          number: number.trim(),
          name: name.trim(),
          kind,
          group,
          openItems,
          ownerType: ownerType || null,
          ownerBankAccountId: ownerType === "bank_account" ? owner : null,
          ownerContactId: ownerType === "contact" ? owner : null,
          ownerPlatform: ownerType === "platform" ? owner : null,
          ownerPersonName: ownerType === "person" ? owner.trim() : null,
          description: description.trim() || null,
        }),
      onDone,
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border border-border p-4" aria-labelledby="chart-create-heading">
      <h2 id="chart-create-heading" className="font-medium text-foreground">
        {t("chart.createHeading")}
      </h2>
      <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-1">
          <Label htmlFor="chart-number">{t("chart.number")}</Label>
          <Input id="chart-number" inputMode="numeric" required value={number} onChange={(event) => setNumber(event.target.value)} aria-describedby="chart-number-hint" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="chart-name">{t("chart.name")}</Label>
          <Input id="chart-name" required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
      </div>
      <p id="chart-number-hint" className="text-xs text-muted-foreground">
        {t("chart.numberHint")}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="chart-owner-type">{t("chart.ownerType")}</Label>
          <select id="chart-owner-type" value={ownerType} onChange={(event) => chooseOwnerType(event.target.value as LedgerOwnerType | "")} className={SELECT_CLASSES}>
            <option value="">{t("chart.noOwner")}</option>
            {LEDGER_OWNER_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`ownerTypes.${type}`)}
              </option>
            ))}
          </select>
        </div>
        {ownerType ? (
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor="chart-owner">{t(`chart.owner.${ownerType}`)}</Label>
            {ownerType === "person" ? (
              <Input id="chart-owner" required maxLength={200} value={owner} onChange={(event) => setOwner(event.target.value)} placeholder={t("chart.personPlaceholder")} />
            ) : (
              <select id="chart-owner" required value={owner} onChange={(event) => setOwner(event.target.value)} className={SELECT_CLASSES}>
                <option value="">{t("chart.chooseOwner")}</option>
                {ownerOptions(ownerType, bankAccounts, contacts).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="chart-kind">{t("chart.kind")}</Label>
          <select id="chart-kind" value={kind} onChange={(event) => setKind(event.target.value as LedgerAccountKind)} className={SELECT_CLASSES}>
            {LEDGER_ACCOUNT_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`accountKinds.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="chart-group">{t("chart.group")}</Label>
          <select id="chart-group" value={group} onChange={(event) => setGroup(event.target.value as LedgerAccountGroup)} className={SELECT_CLASSES}>
            {LEDGER_ACCOUNT_GROUPS.map((value) => (
              <option key={value} value={value}>
                {t(`groups.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 self-end pb-1.5 text-sm text-foreground">
          <input type="checkbox" checked={openItems} onChange={(event) => setOpenItems(event.target.checked)} />
          {t("chart.openItems")}
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t("chart.openItemsHint")}</p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="chart-description">{t("chart.description")}</Label>
        <textarea id="chart-description" maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} className={TEXTAREA_CLASSES} placeholder={t("chart.descriptionPlaceholder")} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!valid || pending}>
          {t("chart.create")}
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

function EditAccountForm({ account, onDone }: { account: LedgerAccountView; onDone: () => void }) {
  const t = useTranslations("Ledger");
  const { errorCode, pending, run } = useRun();
  const [name, setName] = useState(account.name);
  const [description, setDescription] = useState(account.description ?? "");
  const [group, setGroup] = useState<LedgerAccountGroup>(account.group);
  const [openItems, setOpenItems] = useState(account.openItems);
  const id = `chart-edit-${account.number}`;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        run(() => updateLedgerAccountAction({ accountId: account.id, name: name.trim(), group, openItems, description: description.trim() || null }), onDone);
      }}
      className="flex flex-col gap-3 rounded-lg bg-muted/30 p-3"
      aria-label={t("chart.editLabel", { number: account.number })}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>{t("chart.name")}</Label>
          <Input id={`${id}-name`} required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-group`}>{t("chart.group")}</Label>
          <select id={`${id}-group`} value={group} onChange={(event) => setGroup(event.target.value as LedgerAccountGroup)} className={SELECT_CLASSES}>
            {LEDGER_ACCOUNT_GROUPS.map((value) => (
              <option key={value} value={value}>
                {t(`groups.${value}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-description`}>{t("chart.description")}</Label>
        <textarea id={`${id}-description`} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} className={TEXTAREA_CLASSES} />
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={openItems} onChange={(event) => setOpenItems(event.target.checked)} />
        {t("chart.openItems")}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending || name.trim() === ""}>
          {t("chart.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
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

function AccountRow({ account, owner, canManage }: { account: LedgerAccountView; owner: string | null; canManage: boolean }) {
  const t = useTranslations("Ledger");
  const { errorCode, pending, run } = useRun();
  const [editing, setEditing] = useState(false);
  return (
    <li className={cn("flex flex-col gap-2 border-b border-border px-3 py-2 last:border-0", account.archived && "text-muted-foreground")} data-account={account.number}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className={cn("font-medium", account.archived ? "text-muted-foreground line-through" : "text-foreground")}>{account.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{account.number}</span>
            <span className={cn(PILL_CLASSES, "bg-muted text-foreground")}>{t(`accountKinds.${account.kind}`)}</span>
            {account.openItems ? <span className={cn(PILL_CLASSES, "bg-muted text-foreground")}>{t("chart.openItemsBadge")}</span> : null}
            {account.ownerType ? <span className="text-xs text-muted-foreground">{t("chart.ownerLabel", { type: t(`ownerTypes.${account.ownerType}`), owner: owner ?? "" })}</span> : null}
            {account.archived ? <span className={cn(PILL_CLASSES, "bg-muted text-muted-foreground")}>{t("chart.archived")}</span> : null}
          </span>
          {account.description ? <span className="text-xs text-muted-foreground">{account.description}</span> : null}
        </div>
        {canManage && !editing ? (
          <div className="flex shrink-0 gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={t("chart.editLabel", { number: account.number })}>
              <Pencil aria-hidden />
              {t("chart.edit")}
            </Button>
            {account.archived ? (
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => restoreLedgerAccountAction({ accountId: account.id }))}>
                <ArchiveRestore aria-hidden />
                {t("chart.restore")}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => archiveLedgerAccountAction({ accountId: account.id }))}>
                <Archive aria-hidden />
                {t("chart.archive")}
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {editing ? <EditAccountForm account={account} onDone={() => setEditing(false)} /> : null}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
    </li>
  );
}

/**
 * "Einstellungen > Kontenplan" (decisions/0080 UI concept B, screen I): the chart grouped like the
 * accounts page, each account with both names, kind, open items and owner; a form for a new
 * account (with open items and an owner: bank account, contact, platform or person); editing
 * name, description, group and open items; archiving and restoring. Numbers never change once
 * created: entries refer to them.
 */
export function ChartSettings({ accounts, bankAccounts, contacts, canManage }: { accounts: readonly LedgerAccountView[]; bankAccounts: readonly OwnerOption[]; contacts: readonly OwnerOption[]; canManage: boolean }) {
  const t = useTranslations("Ledger");
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const visible = accounts.filter((account) => showArchived || !account.archived);
  const archivedCount = accounts.filter((account) => account.archived).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("chart.intro", { count: accounts.length - archivedCount })}</p>
        <div className="flex flex-wrap items-center gap-3">
          {archivedCount > 0 ? (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
              {t("chart.showArchived", { count: archivedCount })}
            </label>
          ) : null}
          {canManage && !creating ? (
            <Button type="button" variant="outline" onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t("chart.new")}
            </Button>
          ) : null}
        </div>
      </div>
      {creating ? <CreateAccountForm bankAccounts={bankAccounts} contacts={contacts} onDone={() => setCreating(false)} /> : null}
      {LEDGER_ACCOUNT_GROUPS.map((group) => {
        const rows = visible.filter((account) => account.group === group).sort((a, b) => a.number.localeCompare(b.number, "de", { numeric: true }));
        if (rows.length === 0) return null;
        return (
          <section key={group} aria-labelledby={`chart-group-${group}`} className="flex flex-col gap-2">
            <h2 id={`chart-group-${group}`} className="text-sm font-medium text-foreground">
              {t(`groups.${group}`)}
            </h2>
            <ul className="flex flex-col rounded-lg border border-border">
              {rows.map((account) => (
                <AccountRow key={account.id} account={account} owner={ownerLabel(account, bankAccounts, contacts)} canManage={canManage} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
