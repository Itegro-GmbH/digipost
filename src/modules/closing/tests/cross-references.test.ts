import { describe, expect, it } from "vitest";

import {
  buildClosingCrossReferences,
  closingReference,
  DOCUMENT_REFERENCE_PREFIX,
  TRANSACTION_REFERENCE_PREFIX,
  type ClosingReferenceLabels,
  type CrossReferenceTransaction,
} from "../core/cross-references";

const PERIOD = { from: "2026-01-01", to: "2026-01-31" } as const;

/** Deliberately not German here: the point is that the caller owns every word, so the test
 * can tell the two cases apart at a glance. */
const labels: ClosingReferenceLabels = {
  outsidePeriod: ({ isoDate, amountCents, currency }) => `outside(${isoDate}, ${amountCents ?? "-"} ${currency ?? "-"})`,
  notListed: ({ isoDate, amountCents, currency }) => `notlisted(${isoDate}, ${amountCents ?? "-"} ${currency ?? "-"})`,
};

function transaction(id: string, bookingDate: string, overrides: Partial<CrossReferenceTransaction> = {}): CrossReferenceTransaction {
  return { id, bookingDate, amountCents: -11900, currency: "EUR", confirmedDocuments: [], ...overrides };
}

describe("closingReference", () => {
  it("numbers a sheet's rows from one, zero-padded, and never truncates a big year", () => {
    expect(closingReference(DOCUMENT_REFERENCE_PREFIX, 0)).toBe("D-001");
    expect(closingReference(TRANSACTION_REFERENCE_PREFIX, 11)).toBe("B-012");
    expect(closingReference(DOCUMENT_REFERENCE_PREFIX, 999)).toBe("D-1000");
  });
});

describe("buildClosingCrossReferences", () => {
  it("numbers both sheets in their own row order and points each booking at its documents", () => {
    const result = buildClosingCrossReferences({
      period: PERIOD,
      documents: [{ id: "doc-1" }, { id: "doc-2" }],
      transactions: [
        transaction("tx-1", "2026-01-10", {
          confirmedDocuments: [
            { id: "doc-1", effectiveDate: "2026-01-05", amountCents: 11900, currency: "EUR", allocatedAmountCents: 9600 },
            { id: "doc-2", effectiveDate: "2026-01-06", amountCents: 2300, currency: "EUR", allocatedAmountCents: 2300 },
          ],
        }),
        transaction("tx-2", "2026-01-20"),
      ],
      labels,
    });

    expect(result.documentReferences.get("doc-1")).toBe("D-001");
    expect(result.documentReferences.get("doc-2")).toBe("D-002");
    expect(result.transactionReferences.get("tx-2")).toBe("B-002");
    expect(result.documentsOfTransaction.get("tx-1")).toBe("D-001, D-002");
    // No confirmed link at all is an empty cell, never a placeholder.
    expect(result.documentsOfTransaction.get("tx-2")).toBe("");
  });

  it("names a document outside the period instead of leaving the cell empty", () => {
    const result = buildClosingCrossReferences({
      period: PERIOD,
      documents: [],
      // A January booking settling a December invoice: the invoice is not in a January
      // export at all, the booking still has to say which invoice it paid.
      transactions: [
        transaction("tx-1", "2026-01-12", {
          confirmedDocuments: [{ id: "doc-old", effectiveDate: "2025-12-14", amountCents: 2300, currency: "EUR", allocatedAmountCents: 2300 }],
        }),
      ],
      labels,
    });

    expect(result.documentsOfTransaction.get("tx-1")).toBe("outside(2025-12-14, 2300 EUR)");
  });

  it("says 'not listed' rather than 'outside the period' for a document dated inside it", () => {
    const result = buildClosingCrossReferences({
      period: PERIOD,
      documents: [],
      transactions: [
        transaction("tx-1", "2026-01-12", {
          confirmedDocuments: [{ id: "doc-unlisted", effectiveDate: "2026-01-16", amountCents: 79, currency: "EUR", allocatedAmountCents: 79 }],
        }),
      ],
      labels,
    });

    expect(result.documentsOfTransaction.get("tx-1")).toBe("notlisted(2026-01-16, 79 EUR)");
  });

  it("carries a document with no amount of its own", () => {
    const result = buildClosingCrossReferences({
      period: PERIOD,
      documents: [],
      transactions: [
        transaction("tx-1", "2026-01-12", {
          confirmedDocuments: [{ id: "doc-old", effectiveDate: "2025-11-30", amountCents: null, currency: null, allocatedAmountCents: 500 }],
        }),
      ],
      labels,
    });

    expect(result.documentsOfTransaction.get("tx-1")).toBe("outside(2025-11-30, - -)");
  });
});
