// Zod schemas for the invoicing actions (decisions/0079-outgoing-invoices.md). A draft may be
// saved incomplete (an empty buyer, a line without a price): only its SHAPE is checked here.
// Whether it is a valid invoice is decided by the e-invoice library at "Prüfen" and again,
// authoritatively, at "Festschreiben".
import { z } from "zod";

import { LINE_UNITS, LINE_VAT_RATES, TAX_EXEMPTIONS, type InvoiceDraftContent } from "./types";

export const MAX_INVOICE_LINES = 200;
export const MAX_PAYMENT_TERM_DAYS = 365;

const text = (max: number) => z.string().trim().max(max);
/** Empty, or a plain decimal with a dot and at most `scale` decimals (a comma is normalized
 * to a dot first, the way people type amounts in German). */
const decimal = (scale: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(",", "."))
    .pipe(z.string().regex(new RegExp(`^$|^\\d{1,9}(\\.\\d{1,${scale}})?$`)));
const isoDateOrEmpty = z.union([z.literal(""), z.iso.date()]);

export const invoiceDraftLineSchema = z.object({
  name: text(200),
  description: text(1000),
  quantity: decimal(4),
  unit: z.enum(LINE_UNITS),
  unitPrice: decimal(4),
  vatRate: z.enum(LINE_VAT_RATES),
});

export const invoiceDraftContentSchema = z.object({
  contactId: z.uuid().nullable(),
  buyer: z.object({
    name: text(200),
    addressLine1: text(200),
    addressLine2: text(200),
    postalCode: text(20),
    city: text(100),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/),
    vatId: text(30),
    email: z.union([z.literal(""), z.email().max(320)]),
    orderReference: text(100),
    buyerReference: text(100),
  }),
  deliveryDate: isoDateOrEmpty,
  periodStart: isoDateOrEmpty,
  periodEnd: isoDateOrEmpty,
  paymentTermDays: z.number().int().min(0).max(MAX_PAYMENT_TERM_DAYS),
  paymentIban: text(34),
  taxExemption: z.enum(TAX_EXEMPTIONS).nullable(),
  exemptionReason: text(300),
  notes: text(2000),
  lines: z.array(invoiceDraftLineSchema).max(MAX_INVOICE_LINES),
}) satisfies z.ZodType<InvoiceDraftContent, unknown>;

export const draftIdInputSchema = z.object({ draftId: z.uuid() });
export const updateDraftInputSchema = z.object({ draftId: z.uuid(), content: invoiceDraftContentSchema });
export const invoiceIdInputSchema = z.object({ invoiceId: z.uuid() });

/** The empty draft "Neue Rechnung" starts from: one line, 19 % VAT, 14 days. */
export function emptyDraftContent(): InvoiceDraftContent {
  return {
    contactId: null,
    buyer: { name: "", addressLine1: "", addressLine2: "", postalCode: "", city: "", country: "DE", vatId: "", email: "", orderReference: "", buyerReference: "" },
    deliveryDate: "",
    periodStart: "",
    periodEnd: "",
    paymentTermDays: 14,
    paymentIban: "",
    taxExemption: null,
    exemptionReason: "",
    notes: "",
    lines: [{ name: "", description: "", quantity: "1", unit: "C62", unitPrice: "", vatRate: "19" }],
  };
}

/** Reads a stored draft's jsonb back. A row that no longer parses (a shape from an older
 * release) falls back to the empty draft rather than breaking the editor. */
export function parseStoredDraftContent(value: unknown): InvoiceDraftContent {
  const parsed = invoiceDraftContentSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyDraftContent();
}
