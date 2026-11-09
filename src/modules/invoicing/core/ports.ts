// The e-invoice port (decisions/0079-outgoing-invoices.md). Implemented by
// `server/einvoice-renderer.ts` on top of `@itegro/einvoice`; use cases only ever see this
// interface, so they stay free of the library's runtime (SaxonJS, react-pdf, pdf-lib).
import type { InvoiceInput } from "@itegro/einvoice";

import type { InvoiceTotalsCents, InvoiceViolation } from "./types";

export type InvoiceCheckResult = {
  /** Empty when the input is a valid EN 16931 invoice. */
  violations: InvoiceViolation[];
  /** `null` when the input is too broken to calculate at all. */
  totals: InvoiceTotalsCents | null;
};

export type RenderedInvoice = {
  /** PDF/A-3B with the CII XML embedded as `factur-x.xml` (ZUGFeRD). */
  pdf: Uint8Array;
  xml: string;
  pageCount: number;
  totals: InvoiceTotalsCents;
};

/** Thrown by `render` when the library rejects the input. */
export class InvoiceValidationError extends Error {
  override readonly name = "InvoiceValidationError";

  constructor(readonly violations: InvoiceViolation[]) {
    super(`invoice input rejected: ${violations.map((violation) => violation.rule).join(", ")}`);
  }
}

export interface InvoiceRenderer {
  /** Validates and calculates without rendering anything (the editor's "Prüfen"). */
  check(input: InvoiceInput): Promise<InvoiceCheckResult>;
  /** Validates, renders, and checks the XML against the official Schematron rules. Throws
   * `InvoiceValidationError` for an invalid input. `watermark` is for the draft preview only. */
  render(input: InvoiceInput, options?: { watermark?: string }): Promise<RenderedInvoice>;
}
