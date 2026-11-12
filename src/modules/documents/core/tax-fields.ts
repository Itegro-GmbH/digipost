// The tax data a booking needs (decisions/0080-ledger-double-entry-bookkeeping.md, phase 2):
// net and tax per VAT rate, the printed net/tax totals, pass-through amounts ("durchlaufende
// Posten"), a reverse-charge note, and the service date or period. Pure, no I/O.
//
// The same rule as every other extracted amount (decisions/0021): the model reproduces the
// printed text and this file parses it, the model never does arithmetic. The code does not
// do any either, beyond one thing: `checkTaxConsistency` compares the printed figures with
// each other and with the printed total, and FLAGS a mismatch. It never fills in a missing
// figure or corrects a printed one.
import type { DocumentTaxBreakdownEntry, DocumentTaxCheck, DocumentTaxFields } from "@/persistence/repositories/contracts";

import { parseGermanAmountToCents } from "./amount-parsing";
import { isPlausibleIsoDate } from "./iso-date";

/** Every extracted tax field except the derived `taxCheck` (which the use case computes once,
 * after the model's and the ZUGFeRD XML's figures have been merged). */
export type ExtractedTaxFields = Omit<DocumentTaxFields, "taxCheck">;

export const EMPTY_TAX_FIELDS: ExtractedTaxFields = {
  taxBreakdown: null,
  netTotalCents: null,
  taxTotalCents: null,
  passThroughCents: null,
  reverseCharge: null,
  serviceDate: null,
  servicePeriodFrom: null,
  servicePeriodTo: null,
};

/** More rates than this on one invoice is not a real invoice (Germany has two plus zero). */
export const MAX_TAX_BREAKDOWN_ENTRIES = 6;

/** How far two printed figures may differ before `checkTaxConsistency` flags them: rounding per
 * line item legitimately moves a rate's tax by a cent or two. */
export const TAX_CHECK_TOLERANCE_CENTS = 2;

/** Stable codes (AGENTS.md "Code") for what `checkTaxConsistency` found. */
export const TAX_CHECK_ISSUES = {
  /** A rate's printed tax is not its printed net times the rate. */
  rateMismatch: "rate_mismatch",
  /** The rates' nets do not add up to the printed net total. */
  netTotalMismatch: "net_total_mismatch",
  /** The rates' taxes do not add up to the printed tax total. */
  taxTotalMismatch: "tax_total_mismatch",
  /** Net plus tax plus pass-through is not the printed total. */
  grossTotalMismatch: "gross_total_mismatch",
} as const;
export type TaxCheckIssue = (typeof TAX_CHECK_ISSUES)[keyof typeof TAX_CHECK_ISSUES];

/** Only a string is parsed as an amount: a number from the model would be its own arithmetic
 * (or its own reformatting), and the contract asks for the printed text. */
function toCents(value: unknown): number | null {
  return typeof value === "string" ? parseGermanAmountToCents(value) : null;
}

const RATE_NUMBER_RE = /(\d{1,3}(?:[.,]\d{1,2})?)/;

/** `"19 %"`, `"19%"`, `"MwSt. 7,0 %"`, `19` -> `19`/`7`; `null` for anything outside 0 to 100
 * or without a number. Rounded to two decimals (5,5 % exists elsewhere in the EU). */
export function parseTaxRatePercent(raw: unknown): number | null {
  let value: number | null = null;
  if (typeof raw === "number" && Number.isFinite(raw)) value = raw;
  if (typeof raw === "string") {
    const match = RATE_NUMBER_RE.exec(raw);
    if (match?.[1]) value = Number(match[1].replace(",", "."));
  }
  if (value === null || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value * 100) / 100;
}

/** The model's raw `taxBreakdown` array (`{ rate, netAmount, taxAmount }`, every value the
 * printed text) -> validated entries. An entry without a usable rate, or without any amount at
 * all, is dropped. `null` when nothing usable is left, so "no breakdown printed" is one value. */
export function toTaxBreakdown(raw: unknown): DocumentTaxBreakdownEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: DocumentTaxBreakdownEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const ratePercent = parseTaxRatePercent(record.rate);
    if (ratePercent === null) continue;
    const netCents = toCents(record.netAmount);
    const taxCents = toCents(record.taxAmount);
    if (netCents === null && taxCents === null) continue;
    entries.push({ ratePercent, netCents, taxCents });
    if (entries.length >= MAX_TAX_BREAKDOWN_ENTRIES) break;
  }
  return entries.length > 0 ? entries : null;
}

/** `true`/`false` only for an explicit boolean (or its string spelling); anything else is
 * `null`, "the model did not say". */
export function toReverseChargeAnswer(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/** The notes an invoice prints when the recipient owes the VAT: the German wording of § 13b
 * UStG, its English and French equivalents, and the EU VAT directive's article 196. Matched on
 * the OCR text in code, so a model that misses the note cannot lose it. */
const REVERSE_CHARGE_NOTE_RE =
  /reverse[\s-]*charge|steuerschuldnerschaft\s+des\s+leistungsempf(?:ä|ae)ngers|§\s*13\s?b\b|autoliquidation|\bart(?:icle|\.)?\s*196\b/i;

export function detectReverseChargeNote(text: string | null | undefined): boolean {
  return text ? REVERSE_CHARGE_NOTE_RE.test(text) : false;
}

function toIsoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isPlausibleIsoDate(trimmed) ? trimmed : null;
}

/** `serviceDate` and/or `servicePeriodFrom`/`servicePeriodTo`, each a plausible ISO date or
 * `null`. A period whose end lies before its start is dropped as a whole rather than swapped. */
export function toServiceDates(record: Record<string, unknown>): Pick<ExtractedTaxFields, "serviceDate" | "servicePeriodFrom" | "servicePeriodTo"> {
  const serviceDate = toIsoDateOrNull(record.serviceDate);
  let servicePeriodFrom = toIsoDateOrNull(record.servicePeriodFrom);
  let servicePeriodTo = toIsoDateOrNull(record.servicePeriodTo);
  if (servicePeriodFrom && servicePeriodTo && servicePeriodFrom > servicePeriodTo) {
    servicePeriodFrom = null;
    servicePeriodTo = null;
  }
  return { serviceDate, servicePeriodFrom, servicePeriodTo };
}

/** The model's raw invoice object -> every tax field (still without `taxCheck`). */
export function toExtractedTaxFields(record: Record<string, unknown>): ExtractedTaxFields {
  return {
    taxBreakdown: toTaxBreakdown(record.taxBreakdown),
    netTotalCents: toCents(record.netTotalAmount),
    taxTotalCents: toCents(record.taxTotalAmount),
    passThroughCents: toCents(record.passThroughAmount),
    reverseCharge: toReverseChargeAnswer(record.reverseCharge),
    ...toServiceDates(record),
  };
}

function sumOrNull(values: (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

function withinTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= TAX_CHECK_TOLERANCE_CENTS;
}

/**
 * Compares the printed tax figures with each other and with the printed total:
 * every rate's tax against its net times the rate, the rates' sums against the printed net and
 * tax totals, and net plus tax plus pass-through against the total. A figure that is not
 * printed is not compared (with one exception: a reverse-charge or all-zero-rate invoice that
 * prints no tax at all is compared as tax 0, since that is what it states).
 *
 * `result` is `null` when not a single comparison was possible, `"inconsistent"` when any one
 * failed, `"consistent"` otherwise.
 */
export function checkTaxConsistency(
  input: Pick<ExtractedTaxFields, "taxBreakdown" | "netTotalCents" | "taxTotalCents" | "passThroughCents" | "reverseCharge"> & {
    totalAmountCents: number | null;
  },
): { result: DocumentTaxCheck | null; issues: TaxCheckIssue[] } {
  const issues: TaxCheckIssue[] = [];
  let comparisons = 0;
  const entries = input.taxBreakdown ?? [];

  for (const entry of entries) {
    if (entry.netCents === null || entry.taxCents === null) continue;
    comparisons += 1;
    const expectedTax = Math.round((entry.netCents * entry.ratePercent) / 100);
    if (!withinTolerance(expectedTax, entry.taxCents)) {
      issues.push(TAX_CHECK_ISSUES.rateMismatch);
      break;
    }
  }

  const sumNet = sumOrNull(entries.map((entry) => entry.netCents));
  const sumTax = sumOrNull(entries.map((entry) => entry.taxCents));

  if (input.netTotalCents !== null && sumNet !== null) {
    comparisons += 1;
    if (!withinTolerance(sumNet, input.netTotalCents)) issues.push(TAX_CHECK_ISSUES.netTotalMismatch);
  }
  if (input.taxTotalCents !== null && sumTax !== null) {
    comparisons += 1;
    if (!withinTolerance(sumTax, input.taxTotalCents)) issues.push(TAX_CHECK_ISSUES.taxTotalMismatch);
  }

  const net = input.netTotalCents ?? sumNet;
  const statesNoTax = input.reverseCharge === true || (entries.length > 0 && entries.every((entry) => entry.ratePercent === 0));
  const tax = input.taxTotalCents ?? sumTax ?? (statesNoTax ? 0 : null);
  if (input.totalAmountCents !== null && net !== null && tax !== null) {
    comparisons += 1;
    if (!withinTolerance(net + tax + (input.passThroughCents ?? 0), input.totalAmountCents)) issues.push(TAX_CHECK_ISSUES.grossTotalMismatch);
  }

  if (comparisons === 0) return { result: null, issues };
  return { result: issues.length > 0 ? "inconsistent" : "consistent", issues };
}

/** The XML's explicit answer first; else a note on the page or the model's `true`; else
 * whatever the model said (`false` or nothing). */
function resolveReverseCharge(fromXml: boolean | null, fromModel: boolean | null, ocrText: string): boolean | null {
  if (fromXml !== null) return fromXml;
  if (fromModel === true || detectReverseChargeNote(ocrText)) return true;
  return fromModel;
}

/**
 * The tax fields `markDone` stores: `preferred` (the embedded ZUGFeRD XML, structured data)
 * wins field by field over `fallback` (the model), exactly like the other invoice fields
 * (decisions/0022). The reverse-charge flag also looks at the OCR text itself when the XML has
 * no say: a note printed on the invoice is a fact, whatever the model answered. Then the
 * consistency check runs once on the merged figures.
 */
export function resolveDocumentTaxFields(input: {
  preferred: ExtractedTaxFields | null;
  fallback: ExtractedTaxFields | null;
  ocrText: string;
  totalAmountCents: number | null;
}): DocumentTaxFields {
  const { preferred, fallback } = input;
  if (!preferred && !fallback) return { ...EMPTY_TAX_FIELDS, taxCheck: null };
  const pick = <K extends keyof ExtractedTaxFields>(key: K): ExtractedTaxFields[K] => preferred?.[key] ?? fallback?.[key] ?? EMPTY_TAX_FIELDS[key];

  const reverseCharge = resolveReverseCharge(preferred?.reverseCharge ?? null, fallback?.reverseCharge ?? null, input.ocrText);

  const merged: ExtractedTaxFields = {
    taxBreakdown: pick("taxBreakdown"),
    netTotalCents: pick("netTotalCents"),
    taxTotalCents: pick("taxTotalCents"),
    passThroughCents: pick("passThroughCents"),
    reverseCharge,
    serviceDate: pick("serviceDate"),
    servicePeriodFrom: pick("servicePeriodFrom"),
    servicePeriodTo: pick("servicePeriodTo"),
  };
  const { result } = checkTaxConsistency({ ...merged, totalAmountCents: input.totalAmountCents });
  return { ...merged, taxCheck: result };
}
