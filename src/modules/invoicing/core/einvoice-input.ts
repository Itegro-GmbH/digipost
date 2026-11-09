// Turns a draft (plus the workspace's own company profile) into `@itegro/einvoice`'s
// `InvoiceInput`, and an issued invoice's stored input into its full cancellation
// (decisions/0079-outgoing-invoices.md). Pure functions: the library itself is only ever
// called through the `InvoiceRenderer` port (`./ports.ts`), so this file imports its TYPES
// only. The library computes every amount itself; nothing here adds anything up.
import type { InvoiceInput, LineInput, VatInput } from "@itegro/einvoice";

import { addDays } from "./numbering";
import type { InvoiceDraftContent, InvoiceDraftLine, InvoiceViolation, SellerMissingField, TaxExemption } from "./types";

/** The workspace's own company profile, as far as an invoice needs it. */
export type SellerProfile = {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  vatId: string | null;
  taxNumber: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
  ibans: string[];
};

/** The profile every issued invoice uses: ZUGFeRD / Factur-X EN 16931 (user decision,
 * decisions/0079). XRechnung is not offered. */
export const INVOICE_PROFILE = "en16931" as const;
export const INVOICE_CURRENCY = "EUR" as const;

const blank = (value: string | null | undefined): boolean => !value || value.trim().length === 0;
const orUndefined = (value: string | null | undefined): string | undefined => (blank(value) ? undefined : value!.trim());

/** What is still missing from the company profile before anything can be issued: an address
 * and either a VAT id or a tax number (section 14 (4) no. 2 UStG). */
export function missingSellerFields(seller: SellerProfile): SellerMissingField[] {
  const missing: SellerMissingField[] = [];
  if (blank(seller.addressLine1)) missing.push("address");
  if (blank(seller.postalCode)) missing.push("postal_code");
  if (blank(seller.city)) missing.push("city");
  if (blank(seller.vatId) && blank(seller.taxNumber)) missing.push("tax_id");
  return missing;
}

/** Our own checks, ahead of the library's: things the library cannot know are wrong because
 * they are only wrong in the draft's terms. Reported with `DP-*` rule ids and draft paths. */
export function checkDraft(content: InvoiceDraftContent): InvoiceViolation[] {
  const violations: InvoiceViolation[] = [];
  if (content.lines.length === 0) violations.push({ rule: "DP-INV-001", path: "lines", message: "An invoice needs at least one line." });
  content.lines.forEach((line, index) => {
    if (blank(line.name)) violations.push({ rule: "DP-INV-002", path: `lines[${index}].name`, message: "A line needs a description." });
    if (blank(line.quantity) || Number(line.quantity) <= 0) violations.push({ rule: "DP-INV-003", path: `lines[${index}].quantity`, message: "A line needs a positive quantity." });
    if (blank(line.unitPrice)) violations.push({ rule: "DP-INV-004", path: `lines[${index}].unitPrice`, message: "A line needs a unit price." });
  });
  const hasZeroRate = content.lines.some((line) => line.vatRate === "0");
  if (hasZeroRate && content.taxExemption === null) {
    violations.push({ rule: "DP-INV-005", path: "taxExemption", message: "A line without VAT needs a reason for the exemption." });
  }
  if (content.taxExemption === "exempt" && blank(content.exemptionReason)) {
    violations.push({ rule: "DP-INV-006", path: "exemptionReason", message: "An exemption needs its legal reason." });
  }
  if ((content.periodStart === "") !== (content.periodEnd === "")) {
    violations.push({ rule: "DP-INV-007", path: "periodEnd", message: "A service period needs both a start and an end date." });
  }
  if (content.periodStart !== "" && content.periodEnd !== "" && content.periodStart > content.periodEnd) {
    violations.push({ rule: "DP-INV-008", path: "periodEnd", message: "The service period ends before it starts." });
  }
  return violations;
}

const EXEMPTION_TEXT: Record<Exclude<TaxExemption, "exempt">, string> = {
  small_business: "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.",
  reverse_charge: "Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge).",
};

function vatFor(line: InvoiceDraftLine, content: InvoiceDraftContent): VatInput {
  if (line.vatRate !== "0") return { category: "S", rate: line.vatRate };
  switch (content.taxExemption) {
    case "small_business":
      return { category: "E", rate: 0, exemptionReason: EXEMPTION_TEXT.small_business };
    case "reverse_charge":
      return { category: "AE", rate: 0, exemptionReason: EXEMPTION_TEXT.reverse_charge };
    case "exempt":
      return { category: "E", rate: 0, exemptionReason: content.exemptionReason.trim() };
    default:
      // `checkDraft` reports this case before anything is rendered; category Z ("zero rated")
      // is only the safe placeholder that keeps the input well-formed for the preview.
      return { category: "Z", rate: 0 };
  }
}

function formatGermanDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

export function paymentTermsText(issueDate: string, termDays: number): string {
  if (termDays === 0) return "Zahlbar sofort ohne Abzug.";
  return `Zahlbar ohne Abzug bis zum ${formatGermanDate(addDays(issueDate, termDays))}.`;
}

export function buildInvoiceInput(input: { number: string; issueDate: string; seller: SellerProfile; content: InvoiceDraftContent }): InvoiceInput {
  const { number, issueDate, seller, content } = input;
  const buyerEmail = orUndefined(content.buyer.email);
  const sellerRegistration = [seller.registerCourt, seller.registerNumber].filter((part) => !blank(part)).join(" ");
  const notes = content.notes
    .split(/\r?\n/)
    .map((note) => note.trim())
    .filter((note) => note.length > 0);
  const iban = orUndefined(content.paymentIban);

  return {
    profile: INVOICE_PROFILE,
    type: "invoice",
    number,
    issueDate,
    dueDate: addDays(issueDate, content.paymentTermDays),
    currency: INVOICE_CURRENCY,
    ...(content.deliveryDate ? { deliveryDate: content.deliveryDate } : {}),
    ...(content.periodStart && content.periodEnd ? { periodStart: content.periodStart, periodEnd: content.periodEnd } : {}),
    ...(orUndefined(content.buyer.buyerReference) ? { buyerReference: content.buyer.buyerReference.trim() } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    seller: {
      name: seller.name.trim(),
      address: {
        street: seller.addressLine1?.trim() ?? "",
        ...(orUndefined(seller.addressLine2) ? { street2: seller.addressLine2!.trim() } : {}),
        city: seller.city?.trim() ?? "",
        postalCode: seller.postalCode?.trim() ?? "",
        country: orUndefined(seller.country)?.toUpperCase() ?? "DE",
      },
      ...(orUndefined(seller.vatId) ? { vatId: seller.vatId!.trim() } : {}),
      ...(orUndefined(seller.taxNumber) ? { taxNumber: seller.taxNumber!.trim() } : {}),
      ...(sellerRegistration ? { legalRegistration: { id: sellerRegistration } } : {}),
    },
    buyer: {
      name: content.buyer.name.trim(),
      address: {
        street: content.buyer.addressLine1.trim(),
        ...(orUndefined(content.buyer.addressLine2) ? { street2: content.buyer.addressLine2.trim() } : {}),
        city: content.buyer.city.trim(),
        postalCode: content.buyer.postalCode.trim(),
        country: content.buyer.country.trim().toUpperCase() || "DE",
      },
      ...(orUndefined(content.buyer.vatId) ? { vatId: content.buyer.vatId.trim() } : {}),
      ...(orUndefined(content.buyer.orderReference) ? { orderReference: content.buyer.orderReference.trim() } : {}),
      ...(buyerEmail ? { contact: { email: buyerEmail }, electronicAddress: { scheme: "EM", value: buyerEmail } } : {}),
    },
    payment: {
      ...(iban ? { means: "transfer", iban: iban.replace(/\s+/g, "").toUpperCase(), accountHolder: seller.name.trim() } : { means: "ZZZ" }),
      terms: paymentTermsText(issueDate, content.paymentTermDays),
      reference: number,
    },
    lines: content.lines.map(
      (line): LineInput => ({
        name: line.name.trim(),
        ...(orUndefined(line.description) ? { description: line.description.trim() } : {}),
        quantity: line.quantity || "0",
        unit: line.unit,
        unitPrice: line.unitPrice || "0",
        vat: vatFor(line, content),
      }),
    ),
  };
}

function negate(value: LineInput["quantity"]): LineInput["quantity"] {
  if (typeof value === "number") return -value;
  const trimmed = value.trim();
  return trimmed.startsWith("-") ? trimmed.slice(1) : `-${trimmed}`;
}

/**
 * The full cancellation of an issued invoice: a correction invoice (type code 384,
 * "Rechnungskorrektur") with every line's quantity negated, referencing the original as its
 * preceding invoice (BT-25/BT-26). Everything else (seller, buyer, prices, VAT treatment)
 * is the original's own stored input, so the amounts cancel out to the cent. Type 381
 * ("Gutschrift") is deliberately not used: in German VAT law a "Gutschrift" is a self-billed
 * invoice (section 14 (2) UStG), and the PDF would be titled that way.
 */
export function buildCancellationInput(input: { original: InvoiceInput; number: string; issueDate: string }): InvoiceInput {
  const { original, number, issueDate } = input;
  const note = `Stornorechnung zur Rechnung ${original.number} vom ${formatGermanDate(original.issueDate)}. Die Rechnung wird hiermit vollständig storniert.`;
  const { dueDate: _dueDate, notes: _notes, ...rest } = original;
  void _dueDate;
  void _notes;
  return {
    ...rest,
    type: "correction",
    number,
    issueDate,
    precedingInvoices: [{ number: original.number, issueDate: original.issueDate }],
    notes: [note],
    ...(original.payment
      ? {
          payment: {
            ...original.payment,
            terms: `Diese Stornorechnung hebt die Rechnung ${original.number} vollständig auf. Bereits gezahlte Beträge werden erstattet.`,
            reference: number,
          },
        }
      : {}),
    lines: original.lines.map((line) => ({ ...line, quantity: negate(line.quantity) })),
  };
}
