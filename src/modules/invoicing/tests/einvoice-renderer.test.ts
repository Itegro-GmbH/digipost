// The real `@itegro/einvoice` adapter (decisions/0079-outgoing-invoices.md): no fake, the library
// runs in-process without network access. Also proves that Digipost's own inbox reader
// (`extractZugferdInvoiceFields`) understands what Digipost issues.
import { beforeAll, describe, expect, it, vi } from "vitest";

import { extractZugferdInvoiceFields } from "@/modules/documents";
import { decodeTextBytes, extractEmbeddedXml } from "@/modules/intake";
import { buildCancellationInput, buildInvoiceInput, emptyDraftContent, InvoiceValidationError, type SellerProfile } from "@/modules/invoicing";
import { createEinvoiceRenderer } from "@/modules/invoicing/server";

const SELLER: SellerProfile = {
  name: "Muster GmbH",
  addressLine1: "Hauptstraße 1",
  addressLine2: null,
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
  vatId: "DE123456789",
  taxNumber: null,
  registerCourt: null,
  registerNumber: null,
  ibans: ["DE89370400440532013000"],
};

const CONTENT = {
  ...emptyDraftContent(),
  buyer: { name: "Kunde KG", addressLine1: "Weg 2", addressLine2: "", postalCode: "50667", city: "Köln", country: "DE", vatId: "", email: "", orderReference: "", buyerReference: "" },
  deliveryDate: "2026-11-01",
  paymentIban: "DE89370400440532013000",
  lines: [
    { name: "Beratung", description: "", quantity: "2", unit: "HUR" as const, unitPrice: "95.00", vatRate: "19" as const },
    { name: "Fachbuch", description: "", quantity: "1", unit: "C62" as const, unitPrice: "20.00", vatRate: "7" as const },
  ],
};

const renderer = createEinvoiceRenderer();

// react-pdf's layout engine (yoga-layout) loads its WebAssembly through `fetch("data:...")`: an
// inline URL, not network access. The unit guard (`scripts/test/unit-guard.ts`) refuses every
// `fetch`; here exactly `data:` URLs are let through and everything else still throws.
beforeAll(() => {
  vi.unstubAllGlobals();
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("data:")) return realFetch(input, init);
    throw new Error("Network access in a unit test. Inject `fetch` as a dependency instead.");
  });
});

describe("createEinvoiceRenderer", () => {
  const input = buildInvoiceInput({ number: "2026-0001", issueDate: "2026-11-05", seller: SELLER, content: CONTENT });

  it("calculates the totals itself, to the cent", async () => {
    const result = await renderer.check(input);
    expect(result.violations).toEqual([]);
    // 190.00 + 20.00 net; 36.10 + 1.40 VAT.
    expect(result.totals).toEqual({ netCents: 21000, vatCents: 3750, grossCents: 24750 });
  });

  it("renders a ZUGFeRD PDF whose embedded XML the inbox reads back as this invoice", async () => {
    const rendered = await renderer.render(input);
    expect(rendered.pageCount).toBeGreaterThanOrEqual(1);
    expect(rendered.totals.grossCents).toBe(24750);
    expect(rendered.xml).toContain("<ram:ID>2026-0001</ram:ID>");

    const embedded = await extractEmbeddedXml(rendered.pdf);
    expect(embedded).not.toBeNull();
    const fields = extractZugferdInvoiceFields(decodeTextBytes(embedded!));
    expect(fields).toMatchObject({ invoiceNumber: "2026-0001", sellerName: "Muster GmbH", totalAmountCents: 24750, currency: "EUR" });
  }, 60_000);

  it("is deterministic: the same input renders the same bytes", async () => {
    const [a, b] = await Promise.all([renderer.render(input), renderer.render(input)]);
    expect(Buffer.from(a.pdf).equals(Buffer.from(b.pdf))).toBe(true);
  }, 60_000);

  it("renders the cancellation as a correction invoice whose totals are exactly the negated original", async () => {
    const cancellation = await renderer.render(buildCancellationInput({ original: input, number: "2026-0002", issueDate: "2026-11-20" }));
    expect(cancellation.totals).toEqual({ netCents: -21000, vatCents: -3750, grossCents: -24750 });
    expect(cancellation.xml).toContain("<ram:TypeCode>384</ram:TypeCode>");
    expect(cancellation.xml).toContain("2026-0001");
  }, 60_000);

  it("reports a broken input as violations, and refuses to render it", async () => {
    const broken = buildInvoiceInput({ number: "2026-0003", issueDate: "2026-11-05", seller: SELLER, content: { ...CONTENT, buyer: { ...CONTENT.buyer, name: "" } } });
    const result = await renderer.check(broken);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.some((violation) => violation.path.startsWith("buyer"))).toBe(true);
    await expect(renderer.render(broken)).rejects.toBeInstanceOf(InvoiceValidationError);
  }, 60_000);
});
