// Download file names of an issued invoice (decisions/0079-outgoing-invoices.md):
// `Rechnung-2026-0001.pdf`, `Storno-2026-0002.xml`. Pure ASCII by construction (the number is
// `<year>-<digits>`), so no `filename*` encoding is ever needed for them.
import type { InvoiceType } from "./types";

export function invoiceFileName(input: { number: string; type: InvoiceType; format: "pdf" | "xml" }): string {
  return `${input.type === "invoice" ? "Rechnung" : "Storno"}-${input.number}.${input.format}`;
}
