// Display formatting and form classes shared by the ledger UI (German locale,
// decisions/0013-german-ui-language.md). The select and textarea classes are copied from
// `src/modules/invoicing/ui/format.ts` (module-local there; a `src/shared` owner would need its
// own README for two consumers).

export function formatCents(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("de", { style: "currency", currency }).format(cents / 100);
}

/** A DATEV-style balance: the amount without sign plus "S" (Soll, debit) or "H" (Haben,
 * credit); zero has neither. */
export function formatSaldo(cents: number): string {
  if (cents === 0) return formatCents(0);
  return `${formatCents(Math.abs(cents))} ${cents > 0 ? "S" : "H"}`;
}

/** A bare ISO date (`YYYY-MM-DD`) as a German date. The `T00:00:00` suffix keeps it a local
 * date: a bare ISO date would be parsed as UTC midnight and could show the day before. */
export function formatIsoDate(isoDate: string): string {
  return new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(`${isoDate.slice(0, 10)}T00:00:00`));
}

/** A short German date ("03.09.2026") for dense tables. */
export function formatShortDate(isoDate: string): string {
  return new Intl.DateTimeFormat("de", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${isoDate.slice(0, 10)}T00:00:00`));
}

export function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat("de", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/** "Juli 2026", "3. Quartal 2026" style labels are built by the caller from these parts. */
export function formatMonth(isoDate: string): string {
  return new Intl.DateTimeFormat("de", { month: "long", year: "numeric" }).format(new Date(`${isoDate.slice(0, 10)}T00:00:00`));
}

/** Cents as an editable amount: no thousands separator, comma decimals, never negative. */
export function formatAmountInput(cents: number): string {
  const abs = Math.abs(cents);
  return `${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/**
 * A typed amount to cents, or `null` when it is not a non-negative amount with at most two
 * decimals. Accepts German input ("1.234,56", "1234,5") and a plain dot decimal ("1234.56");
 * with a comma present every dot is a thousands separator, without one a single dot followed
 * by one or two digits is the decimal point ("1.500" is fifteen hundred).
 */
export function parseAmountInput(raw: string): number | null {
  const text = raw.replace(/\s|€|EUR/gi, "");
  if (text === "") return null;
  let normalized: string;
  if (text.includes(",")) {
    if (!/^\d{1,3}(\.\d{3})*(,\d{0,2})?$|^\d+(,\d{0,2})?$/.test(text)) return null;
    normalized = text.replace(/\./g, "").replace(",", ".");
  } else if (/^\d+\.\d{1,2}$/.test(text)) {
    normalized = text;
  } else {
    if (!/^\d{1,3}(\.\d{3})+$|^\d+$/.test(text)) return null;
    normalized = text.replace(/\./g, "");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

export const SELECT_CLASSES =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export const TEXTAREA_CLASSES =
  "min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/** A native `<input>` matching the `Input` primitive, for dense grids (the expert editor). */
export const GRID_INPUT_CLASSES =
  "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30";

/** Small rounded chips (pills) used for statuses, origins and warnings. */
export const PILL_CLASSES = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium";
