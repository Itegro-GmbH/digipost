// Owner: src/modules/invoicing (decisions/0079-outgoing-invoices.md). Encapsulates access only
// (WEBAPP_TEMPLATE_SPEC.md §5.3). Every method filters on `workspaceId` explicitly.
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { DbExecutor } from "@/persistence/foundation/db-types";
import type { InvoiceRepository } from "@/persistence/repositories/contracts/invoices-repository";
import { invoiceDrafts, invoiceEvents, invoiceNumberSequences, invoices } from "@/persistence/schema/invoices";

export function createDrizzleInvoiceRepository(db: DbExecutor): InvoiceRepository {
  const cancellation = alias(invoices, "cancellation");
  const original = alias(invoices, "original");

  /** `invoices` joined with its cancellation (for an invoice) and its original (for a
   * cancellation), both scoped to the same workspace. */
  function selectWithCounterpart() {
    return db
      .select({
        invoice: invoices,
        cancelledById: cancellation.id,
        cancelledByNumber: cancellation.number,
        cancelsNumber: original.number,
      })
      .from(invoices)
      .leftJoin(cancellation, and(eq(cancellation.cancelsInvoiceId, invoices.id), eq(cancellation.workspaceId, invoices.workspaceId)))
      .leftJoin(original, and(eq(original.id, invoices.cancelsInvoiceId), eq(original.workspaceId, invoices.workspaceId)));
  }

  type Joined = Awaited<ReturnType<ReturnType<typeof selectWithCounterpart>["execute"]>>[number];
  const flatten = (row: Joined) => ({
    ...row.invoice,
    cancelledById: row.cancelledById,
    cancelledByNumber: row.cancelledByNumber,
    cancelsNumber: row.cancelsNumber,
  });

  return {
    async createDraft(input) {
      const [row] = await db.insert(invoiceDrafts).values(input).returning();
      if (!row) throw new Error("insert into invoice_drafts returned no row");
      return row;
    },

    async findDraft(workspaceId, id) {
      const [row] = await db
        .select()
        .from(invoiceDrafts)
        .where(and(eq(invoiceDrafts.workspaceId, workspaceId), eq(invoiceDrafts.id, id)))
        .limit(1);
      return row ?? null;
    },

    listDrafts: (workspaceId) => db.select().from(invoiceDrafts).where(eq(invoiceDrafts.workspaceId, workspaceId)).orderBy(desc(invoiceDrafts.updatedAt)),

    async updateDraft(workspaceId, id, patch) {
      const [row] = await db
        .update(invoiceDrafts)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(invoiceDrafts.workspaceId, workspaceId), eq(invoiceDrafts.id, id)))
        .returning();
      return row ?? null;
    },

    async deleteDraft(workspaceId, id) {
      const rows = await db
        .delete(invoiceDrafts)
        .where(and(eq(invoiceDrafts.workspaceId, workspaceId), eq(invoiceDrafts.id, id)))
        .returning({ id: invoiceDrafts.id });
      return rows.length > 0;
    },

    async allocateSequence(workspaceId, year) {
      const [row] = await db
        .insert(invoiceNumberSequences)
        .values({ workspaceId, year, lastValue: 1 })
        .onConflictDoUpdate({
          target: [invoiceNumberSequences.workspaceId, invoiceNumberSequences.year],
          set: { lastValue: sql`${invoiceNumberSequences.lastValue} + 1` },
        })
        .returning({ lastValue: invoiceNumberSequences.lastValue });
      if (!row) throw new Error("invoice number allocation returned no row");
      return row.lastValue;
    },

    async insertInvoice(row) {
      const [inserted] = await db.insert(invoices).values(row).returning();
      if (!inserted) throw new Error("insert into invoices returned no row");
      return inserted;
    },

    async findInvoice(workspaceId, id) {
      const [row] = await selectWithCounterpart()
        .where(and(eq(invoices.workspaceId, workspaceId), eq(invoices.id, id)))
        .limit(1);
      return row ? flatten(row) : null;
    },

    async findCancellationOf(workspaceId, invoiceId) {
      const [row] = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.workspaceId, workspaceId), eq(invoices.cancelsInvoiceId, invoiceId)))
        .limit(1);
      return row ?? null;
    },

    async listInvoices(workspaceId, limit) {
      const rows = await selectWithCounterpart()
        .where(eq(invoices.workspaceId, workspaceId))
        .orderBy(desc(invoices.year), desc(invoices.sequence))
        .limit(limit);
      return rows.map(flatten);
    },

    async countInvoices(workspaceId) {
      const [row] = await db.select({ value: count() }).from(invoices).where(eq(invoices.workspaceId, workspaceId));
      return row?.value ?? 0;
    },

    listForArchive: (workspaceId) =>
      db
        .select({ id: invoices.id, number: invoices.number, type: invoices.type, pdfStorageKey: invoices.pdfStorageKey, xmlStorageKey: invoices.xmlStorageKey })
        .from(invoices)
        .where(eq(invoices.workspaceId, workspaceId))
        .orderBy(asc(invoices.year), asc(invoices.sequence)),

    async insertEvent(row) {
      await db.insert(invoiceEvents).values(row);
    },

    listEvents: (workspaceId, invoiceId) =>
      db
        .select()
        .from(invoiceEvents)
        .where(and(eq(invoiceEvents.workspaceId, workspaceId), eq(invoiceEvents.invoiceId, invoiceId)))
        .orderBy(asc(invoiceEvents.createdAt)),
  };
}
