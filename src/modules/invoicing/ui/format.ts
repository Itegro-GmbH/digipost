// Display formatting shared by the invoicing UI (German locale, decisions/0013-german-ui-language.md).
export function formatCents(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("de", { style: "currency", currency }).format(cents / 100);
}

export function formatIsoDate(isoDate: string): string {
  return new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(`${isoDate.slice(0, 10)}T00:00:00`));
}

export function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat("de", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export const SELECT_CLASSES =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export const TEXTAREA_CLASSES =
  "min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";
