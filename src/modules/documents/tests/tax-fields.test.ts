// decisions/0080-ledger-double-entry-bookkeeping.md, phase 2: parsing the printed tax figures,
// detecting a reverse-charge note, checking the figures against each other, and merging the
// ZUGFeRD XML's figures with the model's.
import { describe, expect, it } from "vitest";

import {
  checkTaxConsistency,
  detectReverseChargeNote,
  EMPTY_TAX_FIELDS,
  MAX_TAX_BREAKDOWN_ENTRIES,
  parseTaxRatePercent,
  resolveDocumentTaxFields,
  TAX_CHECK_ISSUES,
  toExtractedTaxFields,
  toServiceDates,
  toTaxBreakdown,
} from "../core/tax-fields";

describe("parseTaxRatePercent", () => {
  it.each([
    ["19 %", 19],
    ["19%", 19],
    ["MwSt. 7,0 %", 7],
    ["0 %", 0],
    ["5,5 %", 5.5],
    [19, 19],
  ])("parses %j as %d", (raw, expected) => {
    expect(parseTaxRatePercent(raw)).toBe(expected);
  });

  it.each([["abc"], [""], [null], [undefined], ["150 %"], [-1], [Number.NaN]])("rejects %j", (raw) => {
    expect(parseTaxRatePercent(raw)).toBeNull();
  });
});

describe("toTaxBreakdown", () => {
  it("parses German printed amounts for several rates", () => {
    expect(
      toTaxBreakdown([
        { rate: "19 %", netAmount: "1.107,88 EUR", taxAmount: "210,50 EUR" },
        { rate: "7 %", netAmount: "50,00 €", taxAmount: "3,50 €" },
      ]),
    ).toEqual([
      { ratePercent: 19, netCents: 110788, taxCents: 21050 },
      { ratePercent: 7, netCents: 5000, taxCents: 350 },
    ]);
  });

  it("keeps an entry with only one printed amount, never computing the other", () => {
    expect(toTaxBreakdown([{ rate: "19 %", netAmount: null, taxAmount: "7,98 EUR" }])).toEqual([{ ratePercent: 19, netCents: null, taxCents: 798 }]);
  });

  it("ignores a model-computed number instead of a printed amount", () => {
    expect(toTaxBreakdown([{ rate: "19 %", netAmount: 42.01, taxAmount: 7.98 }])).toBeNull();
  });

  it("drops entries without a rate or without any amount, and is null when nothing is left", () => {
    expect(toTaxBreakdown([{ rate: "kein Satz", netAmount: "10,00" }, { rate: "19 %" }, "Unsinn", null])).toBeNull();
    expect(toTaxBreakdown([])).toBeNull();
    expect(toTaxBreakdown("19 %")).toBeNull();
  });

  it("caps the number of entries", () => {
    const many = Array.from({ length: 20 }, () => ({ rate: "19 %", netAmount: "1,00", taxAmount: "0,19" }));
    expect(toTaxBreakdown(many)).toHaveLength(MAX_TAX_BREAKDOWN_ENTRIES);
  });

  it("keeps a credit note's negative amounts", () => {
    expect(toTaxBreakdown([{ rate: "19 %", netAmount: "-100,00 EUR", taxAmount: "-19,00 EUR" }])).toEqual([
      { ratePercent: 19, netCents: -10000, taxCents: -1900 },
    ]);
  });
});

describe("toServiceDates", () => {
  it("keeps plausible ISO dates", () => {
    expect(toServiceDates({ serviceDate: "2026-06-30", servicePeriodFrom: "2026-06-01", servicePeriodTo: "2026-06-30" })).toEqual({
      serviceDate: "2026-06-30",
      servicePeriodFrom: "2026-06-01",
      servicePeriodTo: "2026-06-30",
    });
  });

  it("drops implausible dates and a period that ends before it starts", () => {
    expect(toServiceDates({ serviceDate: "30.06.2026", servicePeriodFrom: "2026-07-01", servicePeriodTo: "2026-06-01" })).toEqual({
      serviceDate: null,
      servicePeriodFrom: null,
      servicePeriodTo: null,
    });
  });
});

describe("toExtractedTaxFields", () => {
  it("parses the notary case: fees with VAT plus pass-through costs without", () => {
    const fields = toExtractedTaxFields({
      netTotalAmount: "677,98 EUR",
      taxTotalAmount: "128,85 EUR",
      taxBreakdown: [{ rate: "19 %", netAmount: "677,98 EUR", taxAmount: "128,82 EUR" }],
      passThroughAmount: "9,00 EUR",
      reverseCharge: false,
    });
    expect(fields).toMatchObject({ netTotalCents: 67798, taxTotalCents: 12885, passThroughCents: 900, reverseCharge: false });
  });

  it("reads reverseCharge only from an explicit boolean", () => {
    expect(toExtractedTaxFields({ reverseCharge: true }).reverseCharge).toBe(true);
    expect(toExtractedTaxFields({ reverseCharge: "true" }).reverseCharge).toBe(true);
    expect(toExtractedTaxFields({ reverseCharge: "ja" }).reverseCharge).toBeNull();
    expect(toExtractedTaxFields({}).reverseCharge).toBeNull();
  });
});

describe("detectReverseChargeNote", () => {
  it.each([
    "Steuerschuldnerschaft des Leistungsempfängers",
    "Steuerschuldnerschaft des Leistungsempfaengers",
    "Reverse Charge - VAT to be accounted for by the recipient",
    "reverse-charge",
    "Gemäß § 13b UStG schuldet der Leistungsempfänger die Steuer",
    "Article 196 Council Directive 2006/112/EC",
    "Autoliquidation",
  ])("finds %j", (text) => {
    expect(detectReverseChargeNote(text)).toBe(true);
  });

  it.each([
    "Es liegt keine Steuerschuldnerschaft des Leistungsempfängers vor.",
    "Kein Reverse Charge, USt 19 %: 7,98 EUR",
    "Die Steuer schuldet nicht der Leistungsempfänger (nicht § 13b UStG).",
    "No reverse charge applies to this invoice.",
    "This supply is not subject to reverse charge.",
  ])("ignores the negated %j", (text) => {
    expect(detectReverseChargeNote(text)).toBe(false);
  });

  it("still finds a note after a negated one elsewhere on the page", () => {
    expect(detectReverseChargeNote("Kein Skonto.\nSteuerschuldnerschaft des Leistungsempfängers")).toBe(true);
    expect(detectReverseChargeNote("Keine Lieferung ins Ausland. Reverse Charge gemäß § 13b UStG.")).toBe(true);
  });

  it("finds nothing in an ordinary invoice", () => {
    expect(detectReverseChargeNote("Rechnung\nNetto 19 %: 42,01 EUR\nUSt 19 %: 7,98 EUR")).toBe(false);
    expect(detectReverseChargeNote(null)).toBe(false);
  });
});

describe("checkTaxConsistency", () => {
  const consistentTwoRates = {
    taxBreakdown: [
      { ratePercent: 19, netCents: 10788, taxCents: 2050 },
      { ratePercent: 7, netCents: 5000, taxCents: 350 },
    ],
    netTotalCents: 15788,
    taxTotalCents: 2400,
    passThroughCents: null,
    reverseCharge: null,
    totalAmountCents: 18188,
  };

  it("is consistent when every figure adds up", () => {
    expect(checkTaxConsistency(consistentTwoRates)).toEqual({ result: "consistent", issues: [] });
  });

  it("tolerates a cent or two of rounding", () => {
    expect(checkTaxConsistency({ ...consistentTwoRates, totalAmountCents: 18190 }).result).toBe("consistent");
  });

  it("flags a total that does not match, without changing any figure", () => {
    const input = { ...consistentTwoRates, totalAmountCents: 19000 };
    expect(checkTaxConsistency(input)).toEqual({ result: "inconsistent", issues: [TAX_CHECK_ISSUES.grossTotalMismatch] });
    expect(input.totalAmountCents).toBe(19000);
  });

  it("flags a rate whose tax is not net times rate", () => {
    const input = { ...consistentTwoRates, taxBreakdown: [{ ratePercent: 19, netCents: 10788, taxCents: 755 }] };
    expect(checkTaxConsistency(input).issues).toContain(TAX_CHECK_ISSUES.rateMismatch);
  });

  it("flags breakdown sums that disagree with the printed totals", () => {
    const result = checkTaxConsistency({ ...consistentTwoRates, netTotalCents: 15000, taxTotalCents: 2000, totalAmountCents: null });
    expect(result.issues).toEqual([TAX_CHECK_ISSUES.netTotalMismatch, TAX_CHECK_ISSUES.taxTotalMismatch]);
  });

  it("counts pass-through costs into the total (notary case)", () => {
    const notary = {
      taxBreakdown: [{ ratePercent: 19, netCents: 67798, taxCents: 12882 }],
      netTotalCents: 67798,
      taxTotalCents: 12882,
      passThroughCents: 900,
      reverseCharge: null,
      totalAmountCents: 81580,
    };
    expect(checkTaxConsistency(notary).result).toBe("consistent");
    expect(checkTaxConsistency({ ...notary, passThroughCents: null }).result).toBe("inconsistent");
  });

  it("compares a reverse-charge invoice that prints no tax as tax 0", () => {
    expect(
      checkTaxConsistency({ taxBreakdown: null, netTotalCents: 1300, taxTotalCents: null, passThroughCents: null, reverseCharge: true, totalAmountCents: 1300 })
        .result,
    ).toBe("consistent");
  });

  it("is null when there is nothing to compare", () => {
    expect(checkTaxConsistency({ ...EMPTY_TAX_FIELDS, totalAmountCents: 4999 })).toEqual({ result: null, issues: [] });
  });
});

describe("resolveDocumentTaxFields", () => {
  const model = {
    ...EMPTY_TAX_FIELDS,
    taxBreakdown: [{ ratePercent: 19, netCents: 4201, taxCents: 798 }],
    netTotalCents: 4201,
    reverseCharge: false,
    servicePeriodFrom: "2026-03-01",
    servicePeriodTo: "2026-03-31",
  };

  it("is all null for a document with neither model nor ZUGFeRD tax fields", () => {
    expect(resolveDocumentTaxFields({ preferred: null, fallback: null, ocrText: "Reverse Charge", totalAmountCents: null })).toEqual({
      ...EMPTY_TAX_FIELDS,
      taxCheck: null,
    });
  });

  it("takes the model's fields and checks them against the total", () => {
    const result = resolveDocumentTaxFields({ preferred: null, fallback: model, ocrText: "", totalAmountCents: 4999 });
    expect(result).toMatchObject({ netTotalCents: 4201, servicePeriodFrom: "2026-03-01", reverseCharge: false, taxCheck: "consistent" });
  });

  it("lets the ZUGFeRD figures win field by field", () => {
    const zugferd = { ...EMPTY_TAX_FIELDS, taxBreakdown: [{ ratePercent: 19, netCents: 4200, taxCents: 798 }], taxTotalCents: 798 };
    const result = resolveDocumentTaxFields({ preferred: zugferd, fallback: model, ocrText: "", totalAmountCents: 4998 });
    expect(result.taxBreakdown).toEqual([{ ratePercent: 19, netCents: 4200, taxCents: 798 }]);
    expect(result.taxTotalCents).toBe(798);
    // Not in the XML, so the model's value stays.
    expect(result.servicePeriodTo).toBe("2026-03-31");
  });

  it("sets reverse charge from a note in the OCR text even when the model said no", () => {
    const result = resolveDocumentTaxFields({ preferred: null, fallback: model, ocrText: "Steuerschuldnerschaft des Leistungsempfängers", totalAmountCents: null });
    expect(result.reverseCharge).toBe(true);
  });

  it("keeps the XML's explicit reverse-charge answer over the OCR text", () => {
    const zugferd = { ...EMPTY_TAX_FIELDS, reverseCharge: false };
    const result = resolveDocumentTaxFields({ preferred: zugferd, fallback: model, ocrText: "Reverse Charge", totalAmountCents: null });
    expect(result.reverseCharge).toBe(false);
  });

  it("flags merged figures that do not add up", () => {
    const result = resolveDocumentTaxFields({ preferred: null, fallback: model, ocrText: "", totalAmountCents: 6000 });
    expect(result.taxCheck).toBe("inconsistent");
  });
});
