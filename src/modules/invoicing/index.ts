// Neutral entrypoint of src/modules/invoicing (decisions/0079-outgoing-invoices.md): the pure
// domain (types, numbering, the draft-to-e-invoice mapping, the renderer port) used by
// `src/persistence/use-cases/invoices-use-cases.ts` and `src/persistence/schema/invoices.ts`.
// No `@itegro/einvoice` runtime import is reachable from here, only its types.
export * from "./core/types";
export { addDays, formatInvoiceNumber, issueDateFor, yearOfIsoDate } from "./core/numbering";
export {
  draftIdInputSchema,
  emptyDraftContent,
  invoiceDraftContentSchema,
  invoiceIdInputSchema,
  MAX_INVOICE_LINES,
  MAX_PAYMENT_TERM_DAYS,
  parseStoredDraftContent,
  updateDraftInputSchema,
} from "./core/schemas";
export {
  buildCancellationInput,
  buildInvoiceInput,
  checkDraft,
  INVOICE_CURRENCY,
  INVOICE_PROFILE,
  missingSellerFields,
  paymentTermsText,
  type SellerProfile,
} from "./core/einvoice-input";
export { InvoiceValidationError, type InvoiceCheckResult, type InvoiceRenderer, type RenderedInvoice } from "./core/ports";
export { invoiceFileName } from "./core/file-names";
export { locateViolation, VIOLATION_FIELDS, type LocatedViolation, type ViolationField } from "./core/violation-fields";
export { INVOICE_ACTION_ERROR_CODES, type InvoiceActionErrorCode } from "./core/error-codes";
