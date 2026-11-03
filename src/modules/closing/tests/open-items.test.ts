import { describe, expect, it } from "vitest";

import {
  buildClosingOpenItems,
  CLOSING_SETTLEMENT_TIMINGS,
  OPEN_ITEM_TYPES,
  paymentsCell,
  settlementTiming,
  type ClosingLinkedPayment,
  type ClosingPaymentLabels,
  type OpenItemsDocument,
} from "../core/open-items";

const AUGUST = { from: "2026-08-01", to: "2026-08-31" } as const;

function payment(id: string, bookingDate: string, amountCents: number, allocatedAmountCents = Math.abs(amountCents)): ClosingLinkedPayment {
  return { id, bookingDate, amountCents, currency: "EUR", allocatedAmountCents };
}

function document(id: string, overrides: Partial<OpenItemsDocument> = {}): OpenItemsDocument {
  return { id, direction: "incoming", totalAmountCents: 5000, currency: "EUR", paymentStatus: "paid", confirmedTransactions: [], ...overrides };
}

/** Not German on purpose: the caller owns every word. */
const paymentLabels: ClosingPaymentLabels = {
  listed: (reference, { amountCents, currency }) => `${reference}=${amountCents} ${currency}`,
  beforePeriod: ({ isoDate, amountCents }) => `before(${isoDate}, ${amountCents})`,
  afterPeriod: ({ isoDate, amountCents }) => `after(${isoDate}, ${amountCents})`,
  notListed: ({ isoDate, amountCents }) => `notlisted(${isoDate}, ${amountCents})`,
};

describe("settlementTiming", () => {
  it("says nothing for a document paid within the period or not paid at all", () => {
    expect(settlementTiming(document("d", { confirmedTransactions: [payment("t", "2026-08-27", -5000)] }), AUGUST)).toBeNull();
    expect(settlementTiming(document("d", { paymentStatus: "open" }), AUGUST)).toBeNull();
  });

  it("tells a payment after the Stichtag apart from one that only partly came after it", () => {
    // Stadt Geretsried: an August invoice paid on 19 September.
    expect(settlementTiming(document("d", { confirmedTransactions: [payment("t", "2026-09-19", -5000)] }), AUGUST)).toBe(
      CLOSING_SETTLEMENT_TIMINGS.afterPeriod,
    );
    // Google Ads: two August debits and the rest on 2 September.
    const google = document("d", {
      totalAmountCents: 9657,
      confirmedTransactions: [payment("t1", "2026-08-07", -1000), payment("t2", "2026-08-08", -5000), payment("t3", "2026-09-02", -3657)],
    });
    expect(settlementTiming(google, AUGUST)).toBe(CLOSING_SETTLEMENT_TIMINGS.partlyAfterPeriod);
  });
});

describe("paymentsCell", () => {
  it("names each payment with the amount this document claims, by number or by date", () => {
    const doc = document("d", {
      totalAmountCents: 9657,
      confirmedTransactions: [
        payment("in-advance", "2026-07-30", -1000),
        payment("listed", "2026-08-08", -5000),
        payment("clearing", "2026-08-20", -10),
        // One collective booking, of which this document claims only part.
        payment("later", "2026-10-24", 3694, 1183),
      ],
    });

    expect(paymentsCell(doc, AUGUST, new Map([["listed", "B-004"]]), paymentLabels)).toBe(
      "before(2026-07-30, 1000), B-004=5000 EUR, notlisted(2026-08-20, 10), after(2026-10-24, 1183)",
    );
  });

  it("is empty when nothing is assigned, never a placeholder", () => {
    expect(paymentsCell(document("d", { paymentStatus: "open" }), AUGUST, new Map(), paymentLabels)).toBe("");
  });
});

describe("buildClosingOpenItems", () => {
  it("lists what was still owed on the Stichtag, payables first", () => {
    const items = buildClosingOpenItems(
      [
        // Apple: a payout report with no direction of its own, paid out on 1 October.
        document("apple", { direction: null, totalAmountCents: 2946, paymentStatus: "not_applicable", confirmedTransactions: [payment("a", "2026-10-01", 2946)] }),
        document("stadt", { confirmedTransactions: [payment("s", "2026-09-19", -5000)] }),
        document("google-ads", {
          totalAmountCents: 9657,
          confirmedTransactions: [payment("g1", "2026-08-07", -1000), payment("g2", "2026-08-08", -5000), payment("g3", "2026-09-02", -3657)],
        }),
        // Paid within August: nothing open on the Stichtag.
        document("ionos", { totalAmountCents: 150, confirmedTransactions: [payment("i", "2026-08-19", -150)] }),
      ],
      AUGUST,
    );

    expect(items.map((item) => [item.documentId, item.type, item.openAtPeriodEndCents])).toEqual([
      ["stadt", OPEN_ITEM_TYPES.payable, 5000],
      ["google-ads", OPEN_ITEM_TYPES.payable, 3657],
      ["apple", OPEN_ITEM_TYPES.receivable, 2946],
    ]);
    expect(items[0]).toMatchObject({ paidAfterPeriod: [{ isoDate: "2026-09-19", amountCents: 5000, currency: "EUR" }], stillOpenCents: 0 });
  });

  it("counts only this document's share of a collective payout", () => {
    // Google Play paid July to September out together (36,94 EUR); August claims 11,83.
    const [item] = buildClosingOpenItems(
      [document("play", { direction: null, totalAmountCents: 1183, paymentStatus: "not_applicable", confirmedTransactions: [payment("p", "2026-10-24", 3694, 1183)] })],
      AUGUST,
    );

    expect(item).toMatchObject({ type: OPEN_ITEM_TYPES.receivable, openAtPeriodEndCents: 1183 });
  });

  it("keeps a document still unpaid today, and decides its side by direction and sign", () => {
    const items = buildClosingOpenItems(
      [
        document("unpaid-invoice", { paymentStatus: "overdue" }),
        document("own-invoice", { direction: "outgoing", totalAmountCents: 20000, paymentStatus: "open" }),
        // A credit note on an incoming invoice brings money back.
        document("credit-note", { totalAmountCents: -1500, paymentStatus: "open" }),
        // Half paid after the Stichtag, the other half still open.
        document("half", { totalAmountCents: 4000, paymentStatus: "partially_paid", confirmedTransactions: [payment("h", "2026-09-10", -2000)] }),
      ],
      AUGUST,
    );

    expect(items.map((item) => [item.documentId, item.type, item.openAtPeriodEndCents, item.stillOpenCents])).toEqual([
      ["unpaid-invoice", OPEN_ITEM_TYPES.payable, 5000, 5000],
      ["half", OPEN_ITEM_TYPES.payable, 4000, 2000],
      ["own-invoice", OPEN_ITEM_TYPES.receivable, 20000, 20000],
      ["credit-note", OPEN_ITEM_TYPES.receivable, 1500, 1500],
    ]);
  });

  it("leaves out what was finished without a payment, or says nothing about direction", () => {
    const items = buildClosingOpenItems(
      [
        // The Meta ad invoices: settled over the clearing account, nobody owed anything.
        document("meta", { totalAmountCents: 500, paymentStatus: "settled" }),
        document("cash", { paymentStatus: "no_document_needed" }),
        document("statement", { direction: null, totalAmountCents: null, paymentStatus: "not_applicable" }),
        document("unknown", { direction: "unknown", paymentStatus: "open" }),
      ],
      AUGUST,
    );

    expect(items).toEqual([]);
  });
});
