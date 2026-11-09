import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";
import { locateViolation, VIOLATION_FIELDS } from "@/modules/invoicing";

describe("locateViolation", () => {
  it.each([
    ["lines[2].unitPrice", "line_price", 2],
    ["lines[0].name", "line_name", 0],
    ["lines[1].vat.rate", "line_vat", 1],
    ["buyer.address.postalCode", "buyer_address", null],
    ["buyer.vatId", "buyer_vat_id", null],
    ["seller.address.street", "seller", null],
    ["payment.iban", "payment", null],
    ["deliveryDate", "delivery", null],
    ["taxExemption", "tax_exemption", null],
    ["somethingElse", "other", null],
  ] as const)("%s -> %s", (path, field, lineIndex) => {
    expect(locateViolation({ rule: "BR-X", path, message: "" })).toEqual({ field, lineIndex, rule: "BR-X" });
  });

  it.each(VIOLATION_FIELDS)("Invoicing.violations.%s has German copy", (field) => {
    expect(typeof (de.Invoicing.violations as Record<string, unknown>)[field]).toBe("string");
  });
});
