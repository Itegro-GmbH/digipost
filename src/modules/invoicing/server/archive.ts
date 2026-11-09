import "server-only";

import { createClosingArchiveStream } from "@/modules/closing/server";
import { getRequestServices } from "@/persistence/composition/request-services";

/** `rechnungen-<workspace>-<date>.zip` would leak the workspace name into a header; the date is
 * enough to tell two downloads apart. Pure ASCII by construction. */
export function invoiceArchiveFileName(at: Date): string {
  return `rechnungen-${at.toISOString().slice(0, 10)}.zip`;
}

/** Every issued invoice's PDF and XML as one streamed ZIP (decisions/0079-outgoing-invoices.md):
 * what an admin downloads before deleting the workspace, and the way to hand every invoice to a
 * tax advisor. One file in memory at a time (`createClosingArchiveStream`'s backpressure). */
export function createInvoiceArchive(workspaceId: string): ReadableStream<Uint8Array> {
  const invoices = getRequestServices().invoices;
  return createClosingArchiveStream(() => invoices.archiveEntries(workspaceId));
}
