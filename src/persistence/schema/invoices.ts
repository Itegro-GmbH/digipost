// Owner: src/modules/invoicing (decisions/0079-outgoing-invoices.md). Only
// `repositories/drizzle/invoices-repository.ts` writes these tables (§5.7 "only the owner
// writes").
//
// GoBD: `invoices` and `invoice_events` are APPEND-ONLY. A row is inserted once and never
// updated or deleted; a cancellation is a NEW invoice row pointing at the original
// (`cancels_invoice_id`), never a status change on the original. The database enforces it,
// not only this code: `src/persistence/sql/invoices_append_only/invoices_append_only.sql`
// adds a trigger refusing every UPDATE and TRUNCATE, and every DELETE except the one a
// workspace deletion cascades (the user's decision: deleting a workspace stays possible, after
// the admin confirmed every invoice was downloaded), and revokes UPDATE/DELETE/TRUNCATE from
// `app_runtime` on both tables. That is also why neither table has a foreign key to `user`,
// `contacts` or `documents`: an `on delete set null` would be an UPDATE the trigger refuses,
// blocking the deletion of that user, contact or document. Those ids are kept as plain values
// next to a snapshot of what the invoice needs (the actor's e-mail, the buyer's data).
//
// `invoice_drafts` and `invoice_number_sequences` are ordinary mutable tables: a draft has no
// number and was never sent, and the sequence row is the counter itself. Every table here
// cascades from `workspaces.id` (decisions/0027-hardening-and-deletion.md's "Cascade
// verification").
import { sql } from "drizzle-orm";
import { check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { InvoiceInput } from "@itegro/einvoice";

import { INVOICE_EVENT_KINDS, INVOICE_TYPES } from "@/modules/invoicing";

import { user } from "./auth";
import { contacts } from "./contacts";
import { workspaces } from "./workspaces";

/** An editable draft ("Entwurf"). `content` is `InvoiceDraftContent` (`@/modules/invoicing`),
 * validated on every write by the use case. Deleted when it is finalized. */
export const invoiceDrafts = pgTable(
  "invoice_drafts",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    content: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invoice_drafts_workspace_updated_idx").on(t.workspaceId, t.updatedAt)],
);

/** The gapless number range: one row per workspace and year, `last_value` the last number
 * handed out. Incremented with `insert ... on conflict do update ... returning` inside the
 * same transaction that inserts the invoice, so the row stays locked until that transaction
 * commits (two finalizations wait for each other) and a rolled-back finalization hands its
 * number back (no gap). */
export const invoiceNumberSequences = pgTable(
  "invoice_number_sequences",
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    year: integer().notNull(),
    lastValue: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.year] }), check("invoice_number_sequences_last_value_check", sql`${t.lastValue} >= 1`)],
);

/** An issued invoice or cancellation. Append-only (see the header). `einvoice_input` is the
 * complete input the PDF and XML were rendered from: the library renders it byte-identically
 * again, so together with the two SHA-256 hashes it proves the stored files are unaltered. */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    number: text().notNull(),
    year: integer().notNull(),
    sequence: integer().notNull(),
    type: text({ enum: INVOICE_TYPES }).notNull(),
    /** Set exactly for a cancellation: the invoice it cancels. `no action`, not `restrict`:
     * a workspace deletion removes both rows in the same statement, and `no action` checks at
     * the end of that statement, `restrict` immediately. */
    cancelsInvoiceId: uuid().references((): AnyPgColumn => invoices.id),
    issueDate: date({ mode: "string" }).notNull(),
    dueDate: date({ mode: "string" }),
    currency: text().notNull(),
    netCents: integer().notNull(),
    vatCents: integer().notNull(),
    grossCents: integer().notNull(),
    buyerName: text().notNull(),
    /** Plain value, no foreign key (see the header). */
    contactId: uuid(),
    einvoiceInput: jsonb().$type<InvoiceInput>().notNull(),
    pdfStorageKey: text().notNull(),
    xmlStorageKey: text().notNull(),
    pdfSha256: text().notNull(),
    xmlSha256: text().notNull(),
    /** The inbox document created with it (`src/modules/documents`). Plain value, no foreign
     * key: the document may be deleted from the inbox, the invoice stays. */
    documentId: uuid(),
    /** Plain values, no foreign key (see the header): who issued it, as of that moment. */
    createdByUserId: uuid(),
    createdByEmail: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_workspace_number_key").on(t.workspaceId, t.number),
    uniqueIndex("invoices_workspace_year_sequence_key").on(t.workspaceId, t.year, t.sequence),
    // At most one cancellation per invoice: the backstop behind the use case's own check.
    uniqueIndex("invoices_cancels_invoice_key").on(t.cancelsInvoiceId).where(sql`${t.cancelsInvoiceId} is not null`),
    check(
      "invoices_cancellation_check",
      sql`(${t.type} = 'cancellation' and ${t.cancelsInvoiceId} is not null) or (${t.type} = 'invoice' and ${t.cancelsInvoiceId} is null)`,
    ),
    check("invoices_sequence_check", sql`${t.sequence} >= 1`),
  ],
);

/** The audit log: who issued or cancelled what, and when. Append-only like `invoices`. */
export const invoiceEvents = pgTable(
  "invoice_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id),
    kind: text({ enum: INVOICE_EVENT_KINDS }).notNull(),
    /** For `cancelled`: the cancellation that was issued. */
    relatedInvoiceId: uuid(),
    actorUserId: uuid(),
    actorEmail: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invoice_events_invoice_idx").on(t.workspaceId, t.invoiceId, t.createdAt)],
);
