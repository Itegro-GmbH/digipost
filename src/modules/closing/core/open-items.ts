// Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md, "Offene Posten").
// The period's documents read against the period's LAST day (the Stichtag): a document belongs
// to the month of its own date, while the money for it may move later (a city invoice paid
// three weeks after, an app store paying out two months after). Three answers come out of
// the same reading, so they cannot disagree:
//   - the "Erledigung" of a document whose payment came after the Stichtag (`settlementTiming`),
//   - the "Zahlung(en)" cell naming each payment with its amount and timing (`paymentsCell`),
//   - the "Offene Posten" sheet: what was still owed, either way, on the Stichtag
//     (`buildClosingOpenItems`).
//
// Pure and synchronous: no I/O, no locale. Every German word arrives as a label from the
// caller, exactly like the rest of this module's core.
import type { ClosingPeriodBounds } from "./cross-references";

/** One confirmed payment of a document: the subset of `ClosingLinkedTransaction` read here. */
export type ClosingLinkedPayment = {
  id: string;
  /** ISO `YYYY-MM-DD`. */
  bookingDate: string;
  /** The booking's own signed amount: negative is money out. */
  amountCents: number;
  currency: string;
  /** The positive portion of the booking this document claims. */
  allocatedAmountCents: number;
};

/** The subset of `ClosingDocumentRow` this file reads. */
export type OpenItemsDocument = {
  id: string;
  /** `"unknown"` and `null` both say nothing about which way the money goes. */
  direction: "incoming" | "outgoing" | "unknown" | null;
  totalAmountCents: number | null;
  currency: string | null;
  /** The effective payment status (`Payments.statusValues`). */
  paymentStatus: string;
  confirmedTransactions: ClosingLinkedPayment[];
};

export const CLOSING_SETTLEMENT_TIMINGS = {
  /** Every payment was booked after the Stichtag. */
  afterPeriod: "after_period",
  /** Some within (or before) the period, the rest after the Stichtag. */
  partlyAfterPeriod: "partly_after_period",
} as const;
export type ClosingSettlementTiming = (typeof CLOSING_SETTLEMENT_TIMINGS)[keyof typeof CLOSING_SETTLEMENT_TIMINGS];

/** `null` when nothing was paid after the Stichtag; the document's own payment status then
 * says everything already. */
export function settlementTiming(document: OpenItemsDocument, period: ClosingPeriodBounds): ClosingSettlementTiming | null {
  const after = document.confirmedTransactions.filter((payment) => payment.bookingDate > period.to);
  if (after.length === 0) return null;
  return after.length === document.confirmedTransactions.length ? CLOSING_SETTLEMENT_TIMINGS.afterPeriod : CLOSING_SETTLEMENT_TIMINGS.partlyAfterPeriod;
}

export type ClosingPaymentAmount = { amountCents: number; currency: string };
export type ClosingDatedPayment = ClosingPaymentAmount & { isoDate: string };

/** How one payment is named in the "Zahlung(en)" cell. Always with the amount this document
 * claims of it, because one booking can settle several documents and one document can be
 * settled by several bookings. */
export type ClosingPaymentLabels = {
  /** A booking that is a row of the "Buchungen" sheet: `B-003: 10,00 EUR`. */
  listed: (reference: string, amount: ClosingPaymentAmount) => string;
  /** Booked before the period started (paid in advance). */
  beforePeriod: (payment: ClosingDatedPayment) => string;
  /** Booked after the Stichtag. */
  afterPeriod: (payment: ClosingDatedPayment) => string;
  /** Inside the period, but not a row of "Buchungen" (today only a clearing account's). */
  notListed: (payment: ClosingDatedPayment) => string;
};

/** How several payments share one cell. */
const PAYMENT_SEPARATOR = ", ";

/** The allocation is stored in the document's currency where it has one (decisions/0066's
 * note on `allocated_amount_cents`), so it is shown in that currency too. */
function paymentAmount(document: OpenItemsDocument, payment: ClosingLinkedPayment): ClosingPaymentAmount {
  return { amountCents: payment.allocatedAmountCents, currency: document.currency ?? payment.currency };
}

/** The "Zahlung(en)" cell: every confirmed payment, oldest first, or `""` when there is none. */
export function paymentsCell(
  document: OpenItemsDocument,
  period: ClosingPeriodBounds,
  transactionReferences: ReadonlyMap<string, string>,
  labels: ClosingPaymentLabels,
): string {
  return document.confirmedTransactions
    .map((payment) => {
      const amount = paymentAmount(document, payment);
      const reference = transactionReferences.get(payment.id);
      if (reference) return labels.listed(reference, amount);
      const dated = { isoDate: payment.bookingDate, ...amount };
      if (payment.bookingDate > period.to) return labels.afterPeriod(dated);
      if (payment.bookingDate < period.from) return labels.beforePeriod(dated);
      return labels.notListed(dated);
    })
    .join(PAYMENT_SEPARATOR);
}

export const OPEN_ITEM_TYPES = {
  /** Verbindlichkeit: the workspace still had to pay. */
  payable: "payable",
  /** Forderung: the workspace was still owed money. */
  receivable: "receivable",
} as const;
export type OpenItemType = (typeof OPEN_ITEM_TYPES)[keyof typeof OPEN_ITEM_TYPES];

export type ClosingOpenItem = {
  documentId: string;
  type: OpenItemType;
  /** What was open on the Stichtag: the part paid after it plus the part still open today. */
  openAtPeriodEndCents: number;
  currency: string;
  /** The payments booked after the Stichtag, each with the portion this document claims. */
  paidAfterPeriod: ClosingDatedPayment[];
  /** Still unpaid today; `0` when the payments after the Stichtag covered everything. */
  stillOpenCents: number;
};

/** Finished without any payment: over a clearing account, or marked by a human. Nothing was
 * owed to or by anyone on the Stichtag. */
const CLOSED_WITHOUT_PAYMENT = new Set(["settled", "no_document_needed"]);
/** The statuses under which the remainder of a document is still unpaid today. */
const STILL_UNPAID = new Set(["open", "overdue", "partially_paid"]);

/** Which way the money goes. A payment that actually happened is the strongest evidence; a
 * document without one decides by its direction and the sign of its total (a credit note on
 * an incoming invoice brings money back). `null` when neither says anything. */
function hasDirection(document: OpenItemsDocument): document is OpenItemsDocument & { direction: "incoming" | "outgoing" } {
  return document.direction === "incoming" || document.direction === "outgoing";
}

function openItemType(document: OpenItemsDocument, paidAfter: ClosingLinkedPayment[]): OpenItemType | null {
  const first = paidAfter[0];
  if (first) return first.amountCents < 0 ? OPEN_ITEM_TYPES.payable : OPEN_ITEM_TYPES.receivable;
  if (!hasDirection(document) || document.totalAmountCents === null) return null;
  const moneyGoesOut = (document.direction === "incoming") === document.totalAmountCents >= 0;
  return moneyGoesOut ? OPEN_ITEM_TYPES.payable : OPEN_ITEM_TYPES.receivable;
}

/**
 * The period's open items on the Stichtag, payables first, each group in the documents' own
 * order. Only the period's own documents are read: an older invoice still unpaid on this
 * Stichtag belongs to the period it is dated in and shows there.
 */
export function buildClosingOpenItems(documents: OpenItemsDocument[], period: ClosingPeriodBounds): ClosingOpenItem[] {
  const items: ClosingOpenItem[] = [];

  for (const document of documents) {
    if (CLOSED_WITHOUT_PAYMENT.has(document.paymentStatus)) continue;

    const after = document.confirmedTransactions.filter((payment) => payment.bookingDate > period.to);
    const paidAfterPeriod = after.map((payment) => ({ isoDate: payment.bookingDate, ...paymentAmount(document, payment) }));
    const allocatedCents = document.confirmedTransactions.reduce((sum, payment) => sum + payment.allocatedAmountCents, 0);
    const stillOpenCents =
      STILL_UNPAID.has(document.paymentStatus) && hasDirection(document) && document.totalAmountCents !== null
        ? Math.max(0, Math.abs(document.totalAmountCents) - allocatedCents)
        : 0;
    const openAtPeriodEndCents = paidAfterPeriod.reduce((sum, payment) => sum + payment.amountCents, 0) + stillOpenCents;
    if (openAtPeriodEndCents <= 0) continue;

    const type = openItemType(document, after);
    if (!type) continue;

    items.push({
      documentId: document.id,
      type,
      openAtPeriodEndCents,
      currency: document.currency ?? after[0]?.currency ?? "EUR",
      paidAfterPeriod,
      stillOpenCents,
    });
  }

  const payables = items.filter((item) => item.type === OPEN_ITEM_TYPES.payable);
  const receivables = items.filter((item) => item.type === OPEN_ITEM_TYPES.receivable);
  return [...payables, ...receivables];
}
