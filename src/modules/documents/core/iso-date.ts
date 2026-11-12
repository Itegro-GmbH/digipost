// A plausible ISO `YYYY-MM-DD` calendar date (1900 to 2100, a real day of a real month): the
// one check every extracted date passes before it is stored (decisions/0016,
// decisions/0021). Shared by `./analysis-validation.ts` and `./tax-fields.ts`.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isPlausibleIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  if (year < 1900 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
