"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/shared/ui-primitives";

import type { LedgerAccountView } from "../core/types";
import { GRID_INPUT_CLASSES } from "./format";

const MAX_OPTIONS = 60;

export type ComboboxAccount = Pick<LedgerAccountView, "number" | "name" | "group">;

/** Number prefix first, then name matches; the typed text matches number, name or group. */
export function filterAccounts<T extends ComboboxAccount>(accounts: readonly T[], query: string, groupLabel: (group: T["group"]) => string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return accounts.slice(0, MAX_OPTIONS);
  const byNumber = accounts.filter((account) => account.number.startsWith(needle));
  const byText = accounts.filter(
    (account) => !account.number.startsWith(needle) && (account.name.toLowerCase().includes(needle) || groupLabel(account.group).toLowerCase().includes(needle)),
  );
  return [...byNumber, ...byText].slice(0, MAX_OPTIONS);
}

/**
 * "Wofür?" and every other account field: a searchable combobox over the chart (ARIA 1.2
 * combobox with a listbox popup). Type a number or part of a name; Arrow keys move, Enter or
 * Tab takes the highlighted account, Escape closes. Each option shows the plain name, the
 * muted number and its group. While closed, the field shows the chosen account's two names.
 */
export function AccountCombobox({
  id,
  accounts,
  value,
  onChange,
  label,
  labelledBy,
  placeholder,
  invalid,
  disabled,
  className,
}: {
  id?: string;
  accounts: readonly ComboboxAccount[];
  /** The chosen account's number, `""` for none. */
  value: string;
  onChange: (accountNumber: string) => void;
  /** Accessible name when no visible `<label htmlFor>` points at `id`. */
  label?: string;
  labelledBy?: string;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations("Ledger");
  const generatedId = useId();
  const inputId = id ?? `${generatedId}-input`;
  const listId = `${generatedId}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const groupLabel = (group: ComboboxAccount["group"]) => t(`groups.${group}`);
  const options = filterAccounts(accounts, query, groupLabel);
  const selected = accounts.find((account) => account.number === value);
  const closedText = selected ? `${selected.name} (${selected.number})` : value;
  const display = open ? query : closedText;

  function choose(account: ComboboxAccount | undefined) {
    if (account) onChange(account.number);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive((index) => Math.min(index + 1, options.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const exact = accounts.find((account) => account.number === query.trim());
      choose(exact ?? options[active]);
      return;
    }
    if (event.key === "Tab") {
      // Taking the highlighted account on Tab keeps typing "6810 Tab" fast, as in DATEV; the
      // focus still moves on.
      if (open && query.trim() !== "") choose(accounts.find((account) => account.number === query.trim()) ?? options[active]);
      else setOpen(false);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div className={cn("relative", className)}>
      <input
        id={inputId}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && options[active] ? `${listId}-${options[active].number}` : undefined}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        placeholder={placeholder ?? t("editor.accountPlaceholder")}
        value={display}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActive(Math.max(0, accounts.findIndex((account) => account.number === value)));
        }}
        onChange={(event) => {
          setOpen(true);
          setQuery(event.target.value);
          setActive(0);
        }}
        onBlur={() => {
          setOpen(false);
          setQuery("");
        }}
        onKeyDown={onKeyDown}
        className={GRID_INPUT_CLASSES}
      />
      {open ? (
        <ul id={listId} role="listbox" aria-label={label ?? t("editor.accountList")} className="absolute z-20 mt-1 max-h-72 w-full min-w-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm shadow-md">
          {options.length === 0 ? (
            <li role="presentation" className="px-2 py-1.5 text-muted-foreground">
              {t("editor.noAccountFound")}
            </li>
          ) : (
            options.map((account, index) => (
              <li
                key={account.number}
                id={`${listId}-${account.number}`}
                role="option"
                aria-selected={index === active}
                // `mousedown` would blur the input first and close the list before the click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(account)}
                onMouseEnter={() => setActive(index)}
                className={cn("flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-2 py-1.5", index === active && "bg-muted")}
              >
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate text-foreground">{account.name}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{account.number}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{groupLabel(account.group)}</span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
