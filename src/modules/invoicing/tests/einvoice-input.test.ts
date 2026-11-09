import { describe, expect, it } from "vitest";

import { buildCancellationInput, buildInvoiceInput, checkDraft, emptyDraftContent, missingSellerFields, type InvoiceDraftContent, type SellerProfile } from "@/modules/invoicing";

const SELLER: SellerProfile = {
  name: "Muster GmbH",
  addressLine1: "Hauptstraße 1",
  addressLine2: null,
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
  vatId: "DE123456789",
  taxNumber: null,
  registerCourt: "Amtsgericht Berlin",
  registerNumber: "HRB 12345",
  ibans: ["DE89370400440532013000"],
};

function draft(overrides: Partial<InvoiceDraftContent> = {}): InvoiceDraftContent {
  return {
    ...emptyDraftContent(),
    buyer: { name: "Kunde KG", addressLine1: "Weg 2", addressLine2: "", postalCode: "50667", city: "Köln", country: "DE", vatId: "", email: "rechnung@kunde.de", orderReference: "", buyerReference: "" },
    deliveryDate: "2026-11-01",
    paymentIban: "DE89 3704 0044 0532 0130 00",
    lines: [{ name: "Beratung", description: "", quantity: "2", unit: "HUR", unitPrice: "95.00", vatRate: "19" }],
    ...overrides,
  };
}

describe("missingSellerFields", () => {
  it("is empty for a complete profile", () => {
    expect(missingSellerFields(SELLER)).toEqual([]);
  });

  it("names the address parts and the tax id that are missing", () => {
    expect(missingSellerFields({ ...SELLER, addressLine1: " ", postalCode: null, city: "", vatId: null, taxNumber: null })).toEqual(["address", "postal_code", "city", "tax_id"]);
  });

  it("accepts a tax number instead of a VAT id", () => {
    expect(missingSellerFields({ ...SELLER, vatId: null, taxNumber: "30/123/45678" })).toEqual([]);
  });
});

describe("checkDraft", () => {
  it("accepts a complete draft", () => {
    expect(checkDraft(draft())).toEqual([]);
  });

  it("reports lines without a name, quantity or price", () => {
    const rules = checkDraft(draft({ lines: [{ name: "", description: "", quantity: "0", unit: "C62", unitPrice: "", vatRate: "19" }] })).map((v) => v.rule);
    expect(rules).toEqual(["DP-INV-002", "DP-INV-003", "DP-INV-004"]);
  });

  it("requires an exemption reason for a 0 % line", () => {
    const zero = draft({ lines: [{ name: "Buch", description: "", quantity: "1", unit: "C62", unitPrice: "10", vatRate: "0" }] });
    expect(checkDraft(zero).map((v) => v.path)).toEqual(["taxExemption"]);
    expect(checkDraft({ ...zero, taxExemption: "exempt" }).map((v) => v.path)).toEqual(["exemptionReason"]);
    expect(checkDraft({ ...zero, taxExemption: "small_business" })).toEqual([]);
  });

  it("requires a complete, ordered service period", () => {
    expect(checkDraft(draft({ periodStart: "2026-10-01" })).map((v) => v.rule)).toEqual(["DP-INV-007"]);
    expect(checkDraft(draft({ periodStart: "2026-10-31", periodEnd: "2026-10-01" })).map((v) => v.rule)).toEqual(["DP-INV-008"]);
  });
});

describe("buildInvoiceInput", () => {
  it("maps the draft and the company profile onto the library's input", () => {
    const input = buildInvoiceInput({ number: "2026-0001", issueDate: "2026-11-05", seller: SELLER, content: draft() });

    expect(input).toMatchObject({
      profile: "en16931",
      type: "invoice",
      number: "2026-0001",
      issueDate: "2026-11-05",
      dueDate: "2026-11-19",
      deliveryDate: "2026-11-01",
      currency: "EUR",
      seller: {
        name: "Muster GmbH",
        address: { street: "Hauptstraße 1", city: "Berlin", postalCode: "10115", country: "DE" },
        vatId: "DE123456789",
        legalRegistration: { id: "Amtsgericht Berlin HRB 12345" },
      },
      buyer: { name: "Kunde KG", contact: { email: "rechnung@kunde.de" }, electronicAddress: { scheme: "EM", value: "rechnung@kunde.de" } },
      payment: { means: "transfer", iban: "DE89370400440532013000", terms: "Zahlbar ohne Abzug bis zum 19.11.2026.", reference: "2026-0001" },
      lines: [{ name: "Beratung", quantity: "2", unit: "HUR", unitPrice: "95.00", vat: { category: "S", rate: "19" } }],
    });
    expect(input.buyer.vatId).toBeUndefined();
  });

  it("maps the exemption onto the VAT category and its legal reason", () => {
    const line = { name: "Leistung", description: "", quantity: "1", unit: "C62" as const, unitPrice: "100", vatRate: "0" as const };
    const reverse = buildInvoiceInput({ number: "x", issueDate: "2026-11-05", seller: SELLER, content: draft({ lines: [line], taxExemption: "reverse_charge" }) });
    expect(reverse.lines[0]!.vat).toMatchObject({ category: "AE", rate: 0 });
    const small = buildInvoiceInput({ number: "x", issueDate: "2026-11-05", seller: SELLER, content: draft({ lines: [line], taxExemption: "small_business" }) });
    expect(small.lines[0]!.vat).toMatchObject({ category: "E", exemptionReason: expect.stringContaining("§ 19 UStG") });
  });

  it("offers no bank transfer without an IBAN", () => {
    const input = buildInvoiceInput({ number: "x", issueDate: "2026-11-05", seller: SELLER, content: draft({ paymentIban: "" }) });
    expect(input.payment).toMatchObject({ means: "ZZZ" });
    expect(input.payment?.iban).toBeUndefined();
  });
});

describe("buildCancellationInput", () => {
  it("negates every quantity, references the original and keeps everything else", () => {
    const original = buildInvoiceInput({
      number: "2026-0001",
      issueDate: "2026-11-05",
      seller: SELLER,
      content: draft({ lines: [{ name: "A", description: "", quantity: "2", unit: "HUR", unitPrice: "95.00", vatRate: "19" }, { name: "B", description: "", quantity: "1.5", unit: "C62", unitPrice: "10", vatRate: "7" }] }),
    });

    const cancellation = buildCancellationInput({ original, number: "2026-0002", issueDate: "2026-11-20" });

    expect(cancellation).toMatchObject({
      type: "correction",
      number: "2026-0002",
      issueDate: "2026-11-20",
      precedingInvoices: [{ number: "2026-0001", issueDate: "2026-11-05" }],
      seller: original.seller,
      buyer: original.buyer,
      notes: [expect.stringContaining("Stornorechnung zur Rechnung 2026-0001 vom 05.11.2026")],
    });
    expect(cancellation.lines.map((line) => line.quantity)).toEqual(["-2", "-1.5"]);
    expect(cancellation.lines.map((line) => line.unitPrice)).toEqual(["95.00", "10"]);
    expect(cancellation.dueDate).toBeUndefined();
    expect(cancellation.payment?.reference).toBe("2026-0002");
  });
});
