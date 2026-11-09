import "server-only";

/**
 * Public server entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2) of src/modules/invoicing
 * (decisions/0079-outgoing-invoices.md): the read models for `/dashboard/invoices/**`, the
 * archive ZIP for `GET /api/invoices/export`, and the `@itegro/einvoice` adapter the
 * composition root binds.
 */
export {
  countIssuedInvoicesProjection,
  getInvoiceDraftCheckProjection,
  getInvoiceDraftProjection,
  getInvoiceEditorContextProjection,
  getInvoiceProjection,
  listInvoiceDraftsProjection,
  listInvoicesProjection,
} from "./server/read-models";
export { createInvoiceArchive, invoiceArchiveFileName } from "./server/archive";
export { createEinvoiceRenderer, getInvoiceRenderer } from "./server/einvoice-renderer";
