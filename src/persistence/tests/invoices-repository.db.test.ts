// Real Postgres (decisions/0079-outgoing-invoices.md): the gapless number range, and the GoBD
// guarantee that an issued invoice and its audit trail can never be changed or removed, by the
// application's own role (`app_runtime`, no UPDATE/DELETE grant) nor by the table owner (the
// trigger), with the one exception of the cascade a workspace deletion performs.
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InvoiceInput } from "@itegro/einvoice";

import { getDb } from "@/persistence/foundation/client";
import { isDbError } from "@/persistence/foundation/db-errors";
import type { CreateInvoiceRow } from "@/persistence/repositories/contracts";
import { createDrizzleInvoiceRepository } from "@/persistence/repositories/drizzle/invoices-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";

const db = getDb();
const repo = createDrizzleInvoiceRepository(db);
const workspaces = createDrizzleWorkspaceRepository(db);

async function workspace() {
  return workspaces.create({ name: `Rechnung GmbH ${randomUUID()}` });
}

function invoiceRow(workspaceId: string, sequence: number, overrides: Partial<CreateInvoiceRow> = {}): CreateInvoiceRow {
  return {
    id: randomUUID(),
    workspaceId,
    number: `2026-${String(sequence).padStart(4, "0")}`,
    year: 2026,
    sequence,
    type: "invoice",
    cancelsInvoiceId: null,
    issueDate: "2026-11-05",
    dueDate: "2026-11-19",
    currency: "EUR",
    netCents: 19000,
    vatCents: 3610,
    grossCents: 22610,
    buyerName: "Kunde KG",
    contactId: null,
    einvoiceInput: { number: `2026-${sequence}` } as unknown as InvoiceInput,
    pdfStorageKey: `workspaces/${workspaceId}/invoices/x/invoice.pdf`,
    xmlStorageKey: `workspaces/${workspaceId}/invoices/x/factur-x.xml`,
    pdfSha256: "a".repeat(64),
    xmlSha256: "b".repeat(64),
    documentId: null,
    createdByUserId: null,
    createdByEmail: "anna@muster.de",
    ...overrides,
  };
}

describe("createDrizzleInvoiceRepository: the number range", () => {
  it("counts per workspace and per year, starting at 1", async () => {
    const a = await workspace();
    const b = await workspace();
    expect(await repo.allocateSequence(a.id, 2026)).toBe(1);
    expect(await repo.allocateSequence(a.id, 2026)).toBe(2);
    expect(await repo.allocateSequence(a.id, 2027)).toBe(1);
    expect(await repo.allocateSequence(b.id, 2026)).toBe(1);
  });

  it("hands a number back when its transaction rolls back, so the range stays gapless", async () => {
    const ws = await workspace();
    await db
      .transaction(async (tx) => {
        expect(await createDrizzleInvoiceRepository(tx).allocateSequence(ws.id, 2026)).toBe(1);
        throw new Error("render failed");
      })
      .catch(() => undefined);
    expect(await repo.allocateSequence(ws.id, 2026)).toBe(1);
  });

  it("never hands out the same number twice to concurrent transactions", async () => {
    const ws = await workspace();
    const allocate = () =>
      db.transaction(async (tx) => {
        const value = await createDrizzleInvoiceRepository(tx).allocateSequence(ws.id, 2026);
        // Hold the row lock a moment, like a finalization rendering its PDF.
        await tx.execute(sql`select pg_sleep(0.1)`);
        return value;
      });
    const values = await Promise.all([allocate(), allocate(), allocate()]);
    expect([...values].sort()).toEqual([1, 2, 3]);
  });
});

describe("createDrizzleInvoiceRepository: issued rows", () => {
  it("keeps numbers unique per workspace", async () => {
    const ws = await workspace();
    await repo.insertInvoice(invoiceRow(ws.id, 1));
    const err = await repo.insertInvoice(invoiceRow(ws.id, 1)).catch((e: unknown) => e);
    expect(isDbError(err, "unique")).toBe(true);
  });

  it("allows at most one cancellation per invoice, and only with a reference", async () => {
    const ws = await workspace();
    const original = await repo.insertInvoice(invoiceRow(ws.id, 1));
    await repo.insertInvoice(invoiceRow(ws.id, 2, { type: "cancellation", cancelsInvoiceId: original.id }));
    const second = await repo.insertInvoice(invoiceRow(ws.id, 3, { type: "cancellation", cancelsInvoiceId: original.id })).catch((e: unknown) => e);
    expect(isDbError(second, "unique")).toBe(true);
    const unreferenced = await repo.insertInvoice(invoiceRow(ws.id, 4, { type: "cancellation" })).catch((e: unknown) => e);
    expect(isDbError(unreferenced, "check")).toBe(true);
  });

  it("joins each row with its counterpart, within the workspace only", async () => {
    const ws = await workspace();
    const other = await workspace();
    const original = await repo.insertInvoice(invoiceRow(ws.id, 1));
    const cancellation = await repo.insertInvoice(invoiceRow(ws.id, 2, { type: "cancellation", cancelsInvoiceId: original.id }));

    expect(await repo.findInvoice(ws.id, original.id)).toMatchObject({ cancelledById: cancellation.id, cancelledByNumber: "2026-0002", cancelsNumber: null });
    expect(await repo.findInvoice(ws.id, cancellation.id)).toMatchObject({ cancelledById: null, cancelsNumber: "2026-0001" });
    expect(await repo.findInvoice(other.id, original.id)).toBeNull();
    expect((await repo.listInvoices(ws.id, 10)).map((row) => row.number)).toEqual(["2026-0002", "2026-0001"]);
    expect((await repo.listForArchive(ws.id)).map((row) => row.number)).toEqual(["2026-0001", "2026-0002"]);
    expect(await repo.countInvoices(other.id)).toBe(0);
  });
});

describe("append-only (GoBD)", () => {
  let owner: Client;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL_MIGRATE;
    if (!url) throw new Error("DATABASE_URL_MIGRATE is not set (the db test project's env should provide it)");
    owner = new Client({ connectionString: url });
    await owner.connect();
  });

  afterAll(async () => {
    await owner.end();
  });

  async function issued() {
    const ws = await workspace();
    const invoice = await repo.insertInvoice(invoiceRow(ws.id, 1));
    await repo.insertEvent({ workspaceId: ws.id, invoiceId: invoice.id, kind: "issued", relatedInvoiceId: null, actorUserId: null, actorEmail: "anna@muster.de" });
    return { ws, invoice };
  }

  it("the application's own role may neither update nor delete an invoice or an event", async () => {
    const { invoice } = await issued();
    for (const statement of [
      sql`update invoices set gross_cents = 1 where id = ${invoice.id}`,
      sql`delete from invoices where id = ${invoice.id}`,
      sql`update invoice_events set actor_email = 'x' where invoice_id = ${invoice.id}`,
      sql`delete from invoice_events where invoice_id = ${invoice.id}`,
    ]) {
      const err = await db.execute(statement).catch((e: unknown) => e);
      expect(isDbError(err, "forbidden")).toBe(true);
    }
  });

  it("not even the table owner may update, delete or truncate them", async () => {
    const { invoice } = await issued();
    await expect(owner.query("update invoices set gross_cents = 1 where id = $1", [invoice.id])).rejects.toThrow(/append-only/);
    await expect(owner.query("delete from invoices where id = $1", [invoice.id])).rejects.toThrow(/append-only/);
    await expect(owner.query("update invoice_events set actor_email = 'x' where invoice_id = $1", [invoice.id])).rejects.toThrow(/append-only/);
    await expect(owner.query("delete from invoice_events where invoice_id = $1", [invoice.id])).rejects.toThrow(/append-only/);
    await expect(owner.query("truncate invoice_events")).rejects.toThrow(/append-only/);
    await expect(owner.query("truncate invoices cascade")).rejects.toThrow(/append-only/);
    expect(await repo.findInvoice(invoice.workspaceId, invoice.id)).toMatchObject({ grossCents: 22610 });
  });

  it("goes with its workspace: the deletion's cascade is the one DELETE allowed", async () => {
    const { ws, invoice } = await issued();
    await repo.insertInvoice(invoiceRow(ws.id, 2, { type: "cancellation", cancelsInvoiceId: invoice.id }));
    await repo.allocateSequence(ws.id, 2026);
    await repo.createDraft({ workspaceId: ws.id, createdByUserId: null, contactId: null, content: {} });

    // Through the application's own role, exactly like `WorkspaceUseCases.deleteWorkspace`.
    expect(await workspaces.delete(ws.id)).not.toBeNull();

    const counts = await owner.query(
      `select (select count(*) from invoices where workspace_id = $1) as invoices,
              (select count(*) from invoice_events where workspace_id = $1) as events,
              (select count(*) from invoice_number_sequences where workspace_id = $1) as sequences,
              (select count(*) from invoice_drafts where workspace_id = $1) as drafts`,
      [ws.id],
    );
    expect(counts.rows[0]).toEqual({ invoices: "0", events: "0", sequences: "0", drafts: "0" });
  });
});
