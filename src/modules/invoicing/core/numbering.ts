// Invoice numbers (decisions/0079-outgoing-invoices.md): `<year>-<sequence>`, the sequence
// zero-padded to four digits so numbers sort correctly as text, restarting at 1 every
// calendar year. The year is the issue date's year, and the issue date is always the day the
// invoice is finalized, in German local time.

const SEQUENCE_DIGITS = 4;

export function formatInvoiceNumber(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new RangeError(`invalid invoice year ${year}`);
  if (!Number.isInteger(sequence) || sequence < 1) throw new RangeError(`invalid invoice sequence ${sequence}`);
  return `${year}-${String(sequence).padStart(SEQUENCE_DIGITS, "0")}`;
}

/** `YYYY-MM-DD` of `at` in Europe/Berlin: an invoice finalized at 00:30 on 1 January German
 * time belongs to the new year, even though it is still 31 December in UTC. */
export function issueDateFor(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function yearOfIsoDate(isoDate: string): number {
  return Number(isoDate.slice(0, 4));
}

/** `isoDate` plus `days` calendar days, as `YYYY-MM-DD` (computed in UTC, so no DST shift). */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
