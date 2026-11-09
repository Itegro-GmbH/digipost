// Closed value sets and view shapes of the invoicing module (decisions/0079-outgoing-invoices.md).
// Neutral: no React, no server code, no `@itegro/einvoice` runtime import.

/** What an issued row is: an ordinary invoice, or the full cancellation ("Stornorechnung") of
 * one. A cancellation is its own invoice with its own number from the same number range; the
 * original row is never touched (GoBD, decisions/0079). */
export const INVOICE_TYPES = ["invoice", "cancellation"] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

/** The append-only audit log's event kinds. `issued` is written for every issued row (an
 * invoice and a cancellation alike), `cancelled` on the ORIGINAL invoice when its
 * cancellation was issued. */
export const INVOICE_EVENT_KINDS = ["issued", "cancelled"] as const;
export type InvoiceEventKind = (typeof INVOICE_EVENT_KINDS)[number];

/** The VAT rate a line can carry. `0` needs an invoice-level `taxExemption` that says why. */
export const LINE_VAT_RATES = ["19", "7", "0"] as const;
export type LineVatRate = (typeof LINE_VAT_RATES)[number];

/** Why a `0` % line carries no VAT. One reason per invoice: EN 16931 allows exactly one
 * exemption reason per VAT category, so mixing two reasons on one invoice is not offered.
 * - `small_business`: Kleinunternehmer, section 19 UStG (category E)
 * - `reverse_charge`: Steuerschuldnerschaft des Leistungsempfaengers (category AE, needs the
 *   buyer's VAT id)
 * - `exempt`: another exemption, with a free-text reason (category E) */
export const TAX_EXEMPTIONS = ["small_business", "reverse_charge", "exempt"] as const;
export type TaxExemption = (typeof TAX_EXEMPTIONS)[number];

/** UN/ECE Rec. 20 unit codes offered in the editor (C62 piece, HUR hour, DAY day, MON month,
 * LS lump sum, KGM kilogram, MTR metre). */
export const LINE_UNITS = ["C62", "HUR", "DAY", "MON", "LS", "KGM", "MTR"] as const;
export type LineUnit = (typeof LINE_UNITS)[number];

export type InvoiceDraftBuyer = {
  name: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  country: string;
  vatId: string;
  email: string;
  /** The buyer's own order reference (BT-13), optional. */
  orderReference: string;
  /** The buyer reference (BT-10), e.g. a cost centre; optional. */
  buyerReference: string;
};

export type InvoiceDraftLine = {
  name: string;
  description: string;
  /** Decimal string with a dot (`"1.5"`), positive. */
  quantity: string;
  unit: LineUnit;
  /** Net unit price as a decimal string with a dot, up to 4 decimals (`"95.00"`). */
  unitPrice: string;
  vatRate: LineVatRate;
};

/** A draft's whole editable content, stored as one jsonb document. Drafts are not GoBD
 * records (no number, never sent), so they may change and be deleted freely. The issue date
 * is deliberately NOT part of a draft: it is always the day the draft is finalized, which
 * also decides the number's year. */
export type InvoiceDraftContent = {
  /** The contact the buyer was picked from, if any (only used to link the issued document). */
  contactId: string | null;
  buyer: InvoiceDraftBuyer;
  /** Leistungsdatum (section 14 UStG), `YYYY-MM-DD`, or empty when a period is given. */
  deliveryDate: string;
  /** Leistungszeitraum, both `YYYY-MM-DD` or both empty. */
  periodStart: string;
  periodEnd: string;
  /** Days from the issue date to the due date. */
  paymentTermDays: number;
  /** One of the workspace's own IBANs (company profile), or empty for no bank transfer. */
  paymentIban: string;
  taxExemption: TaxExemption | null;
  /** Free text, required for `taxExemption: "exempt"`. */
  exemptionReason: string;
  /** Free text printed on the invoice (one note per line break). */
  notes: string;
  lines: InvoiceDraftLine[];
};

/** A rule violation reported by the e-invoice library, in the terms of its own input (the
 * path is mapped back to the draft's fields by `draftPathForViolation`). */
export type InvoiceViolation = {
  rule: string;
  /** The library's input path, e.g. `lines[0].unitPrice`. */
  path: string;
  message: string;
};

export type InvoiceTotalsCents = {
  netCents: number;
  vatCents: number;
  grossCents: number;
};

export type InvoiceDraftListItem = {
  id: string;
  buyerName: string;
  grossCents: number | null;
  lineCount: number;
  updatedAt: string;
};

export type InvoiceDraftView = {
  id: string;
  content: InvoiceDraftContent;
  updatedAt: string;
};

export type IssuedInvoiceListItem = {
  id: string;
  number: string;
  type: InvoiceType;
  issueDate: string;
  buyerName: string;
  grossCents: number;
  currency: string;
  /** For an invoice: the number of the cancellation that cancels it, if any. */
  cancelledByNumber: string | null;
  /** For a cancellation: the number of the invoice it cancels. */
  cancelsNumber: string | null;
};

export type InvoiceEventView = {
  kind: InvoiceEventKind;
  actorEmail: string | null;
  at: string;
};

export type IssuedInvoiceView = IssuedInvoiceListItem & {
  dueDate: string | null;
  netCents: number;
  vatCents: number;
  cancelledById: string | null;
  cancelsId: string | null;
  /** The inbox document created alongside it, while it still exists. */
  documentId: string | null;
  pdfSha256: string;
  xmlSha256: string;
  createdAt: string;
  events: InvoiceEventView[];
};

/** A contact offered in the editor's "Kunde aus Kontakten" picker. */
export type InvoiceContactOption = {
  id: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  vatId: string | null;
  email: string | null;
};

/** What the editor needs from the workspace's own company profile. */
export type InvoiceSellerSummary = {
  name: string;
  ibans: string[];
  /** Company-profile fields still missing before any invoice can be issued. */
  missing: SellerMissingField[];
};

export const SELLER_MISSING_FIELDS = ["address", "postal_code", "city", "tax_id"] as const;
export type SellerMissingField = (typeof SELLER_MISSING_FIELDS)[number];
