// Owner: src/modules/invoicing (decisions/0079-outgoing-invoices.md). Contracts only: no Drizzle
// import besides type-only schema references.
//
// There is deliberately no update or delete method for `invoices`/`invoice_events`: both are
// append-only (GoBD), and the database refuses either anyway
// (`src/persistence/sql/invoices_append_only/invoices_append_only.sql`).
import type { InferSelectModel } from "drizzle-orm";
import type { InvoiceInput } from "@itegro/einvoice";

import type { InvoiceEventKind, InvoiceType } from "@/modules/invoicing";
import type { invoiceDrafts, invoiceEvents, invoices } from "@/persistence/schema/invoices";

export type InvoiceDraftRow = InferSelectModel<typeof invoiceDrafts>;
export type InvoiceRow = InferSelectModel<typeof invoices>;
export type InvoiceEventRow = InferSelectModel<typeof invoiceEvents>;

export type CreateInvoiceRow = {
  id: string;
  workspaceId: string;
  number: string;
  year: number;
  sequence: number;
  type: InvoiceType;
  cancelsInvoiceId: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  netCents: number;
  vatCents: number;
  grossCents: number;
  buyerName: string;
  contactId: string | null;
  einvoiceInput: InvoiceInput;
  pdfStorageKey: string;
  xmlStorageKey: string;
  pdfSha256: string;
  xmlSha256: string;
  documentId: string | null;
  createdByUserId: string | null;
  createdByEmail: string | null;
};

export type CreateInvoiceEventRow = {
  workspaceId: string;
  invoiceId: string;
  kind: InvoiceEventKind;
  relatedInvoiceId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
};

/** An issued row plus the number of its counterpart: the cancellation that cancels it, or
 * the invoice it cancels. */
export type InvoiceWithCounterpart = InvoiceRow & {
  cancelledById: string | null;
  cancelledByNumber: string | null;
  cancelsNumber: string | null;
};

export interface InvoiceRepository {
  createDraft(input: { workspaceId: string; createdByUserId: string | null; contactId: string | null; content: unknown }): Promise<InvoiceDraftRow>;
  findDraft(workspaceId: string, id: string): Promise<InvoiceDraftRow | null>;
  /** Newest edit first. */
  listDrafts(workspaceId: string): Promise<InvoiceDraftRow[]>;
  /** `null` when no such draft exists in this workspace. */
  updateDraft(workspaceId: string, id: string, patch: { contactId: string | null; content: unknown }): Promise<InvoiceDraftRow | null>;
  /** `false` when no such draft exists in this workspace. */
  deleteDraft(workspaceId: string, id: string): Promise<boolean>;

  /** The next number of `year` in this workspace's range, starting at 1. Must run inside the
   * transaction that inserts the invoice: the sequence row stays locked until it commits, and
   * a rollback returns the number (the range stays gapless). */
  allocateSequence(workspaceId: string, year: number): Promise<number>;

  insertInvoice(row: CreateInvoiceRow): Promise<InvoiceRow>;
  findInvoice(workspaceId: string, id: string): Promise<InvoiceWithCounterpart | null>;
  /** The cancellation of `invoiceId`, or `null`. */
  findCancellationOf(workspaceId: string, invoiceId: string): Promise<InvoiceRow | null>;
  /** Newest number first. */
  listInvoices(workspaceId: string, limit: number): Promise<InvoiceWithCounterpart[]>;
  countInvoices(workspaceId: string): Promise<number>;
  /** Every issued row, oldest number first (the archive download). */
  listForArchive(workspaceId: string): Promise<Pick<InvoiceRow, "id" | "number" | "type" | "pdfStorageKey" | "xmlStorageKey">[]>;

  insertEvent(row: CreateInvoiceEventRow): Promise<void>;
  /** Oldest first. */
  listEvents(workspaceId: string, invoiceId: string): Promise<InvoiceEventRow[]>;
}
