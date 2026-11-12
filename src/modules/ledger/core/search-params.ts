// The ledger pages' URL filters (decisions/0080 UI: filters live in the URL as a plain GET form,
// so they can be linked and shared). An empty or malformed value counts as absent
// (decisions/0062-an-empty-search-param-means-absent.md), never as an error.
import type { ListEntriesFilter } from "./schemas";
import { JOURNAL_ENTRY_ORIGINS, type JournalEntryOrigin } from "./types";

export type RawSearchParams = Record<string, string | string[] | undefined>;

function first(params: RawSearchParams, name: string): string {
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/** A real calendar date in `YYYY-MM-DD`, else `""`. */
export function isoDateParam(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}

function originParam(value: string): JournalEntryOrigin | "" {
  return (JOURNAL_ENTRY_ORIGINS as readonly string[]).includes(value) ? (value as JournalEntryOrigin) : "";
}

/** A `von`/`bis` pair in the wrong order is swapped rather than dropped. */
function ordered(from: string, to: string): [string, string] {
  return from && to && from > to ? [to, from] : [from, to];
}

// -- "Zu prüfen" ----------------------------------------------------------------------------

export type QueueFilterValues = { von: string; bis: string; herkunft: JournalEntryOrigin | ""; nurWarnungen: boolean };

/** `?von=&bis=&herkunft=&nur=warnungen` of `/dashboard/buchhaltung/zu-pruefen`. */
export function parseQueueSearchParams(params: RawSearchParams): QueueFilterValues {
  const [von, bis] = ordered(isoDateParam(first(params, "von")), isoDateParam(first(params, "bis")));
  return { von, bis, herkunft: originParam(first(params, "herkunft")), nurWarnungen: first(params, "nur") === "warnungen" };
}

export function isQueueFiltered(values: QueueFilterValues): boolean {
  return Boolean(values.von || values.bis || values.herkunft || values.nurWarnungen);
}

// -- Journal --------------------------------------------------------------------------------

export const JOURNAL_STATUS_FILTERS = ["proposed", "booked", "dismissed"] as const;
export type JournalStatusFilter = (typeof JOURNAL_STATUS_FILTERS)[number];

export const JOURNAL_PAGE_SIZE = 200;
/** `listEntriesFilterSchema` caps a page at 2000. */
export const JOURNAL_MAX_LIMIT = 2000;

export type JournalFilterValues = {
  von: string;
  bis: string;
  status: JournalStatusFilter | "";
  herkunft: JournalEntryOrigin | "";
  konto: string;
  /** A handover id: only entries changed since that handover ("geändert seit Übergabe"). */
  seit: string;
  limit: number;
};

/** `?von=&bis=&status=&herkunft=&konto=&seit=&anzahl=` of `/dashboard/buchhaltung/journal`. */
export function parseJournalSearchParams(params: RawSearchParams): JournalFilterValues {
  const [von, bis] = ordered(isoDateParam(first(params, "von")), isoDateParam(first(params, "bis")));
  const status = first(params, "status");
  const konto = first(params, "konto");
  const seit = first(params, "seit");
  const limit = Number.parseInt(first(params, "anzahl"), 10);
  return {
    von,
    bis,
    status: (JOURNAL_STATUS_FILTERS as readonly string[]).includes(status) ? (status as JournalStatusFilter) : "",
    herkunft: originParam(first(params, "herkunft")),
    konto: /^\d{4,8}$/.test(konto) ? konto : "",
    seit: /^[0-9a-f-]{36}$/i.test(seit) ? seit : "",
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.ceil(limit / JOURNAL_PAGE_SIZE) * JOURNAL_PAGE_SIZE, JOURNAL_MAX_LIMIT) : JOURNAL_PAGE_SIZE,
  };
}

/** The use case's filter for the values; `changedSince` is the chosen handover's timestamp
 * (the page resolves `seit` within the caller's own handovers). One extra row tells the page
 * whether "Mehr laden" has anything to load. */
export function journalFilterFor(values: JournalFilterValues, changedSince: string | null): ListEntriesFilter {
  return {
    ...(values.von ? { from: values.von } : {}),
    ...(values.bis ? { to: values.bis } : {}),
    ...(values.status === "proposed" || values.status === "booked" ? { status: values.status } : {}),
    ...(values.herkunft ? { origin: values.herkunft } : {}),
    ...(values.konto ? { accountNumber: values.konto } : {}),
    ...(changedSince ? { changedSince } : {}),
    dismissed: values.status === "dismissed" ? "only" : "exclude",
    limit: Math.min(values.limit + 1, JOURNAL_MAX_LIMIT),
  };
}

/** The search string for the journal with `values`, `""` values left out. */
export function journalSearch(values: JournalFilterValues, overrides: Partial<JournalFilterValues> = {}): string {
  const merged = { ...values, ...overrides };
  const query = new URLSearchParams();
  for (const name of ["von", "bis", "status", "herkunft", "konto", "seit"] as const) if (merged[name]) query.set(name, merged[name]);
  if (merged.limit !== JOURNAL_PAGE_SIZE) query.set("anzahl", String(merged.limit));
  const text = query.toString();
  return text ? `?${text}` : "";
}
