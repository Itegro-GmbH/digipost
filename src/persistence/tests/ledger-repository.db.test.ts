// Real Postgres (decisions/0080-ledger-double-entry-bookkeeping.md): the two rules the database
// enforces on its own, whatever code writes the rows. A booked entry balances (deferred
// constraint trigger, checked at commit), and a booked entry inside a submitted filing period is
// locked (no update, no delete, no booked insert), except for the workspace-deletion cascade and
// entries tied to a draft correcting filing. Plus workspace isolation of the composite keys.
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { SKR04_SEED_ACCOUNTS } from "@/modules/ledger";
import { getDb } from "@/persistence/foundation/client";
import { dbErrorOf, isDbError } from "@/persistence/foundation/db-errors";
import type { CreateJournalEntryRow, CreateJournalLineRow, LedgerAccountRow } from "@/persistence/repositories/contracts";
import { createDrizzleLedgerRepository } from "@/persistence/repositories/drizzle/ledger-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { journalEntries, journalLines, ledgerFilings } from "@/persistence/schema/ledger";

const db = getDb();
const repo = createDrizzleLedgerRepository(db);
const workspaces = createDrizzleWorkspaceRepository(db);

async function workspaceWithChart() {
  const workspace = await workspaces.create({ name: `Ledger GmbH ${randomUUID()}` });
  await repo.insertAccountsIfMissing(
    SKR04_SEED_ACCOUNTS.map((seed) => ({
      workspaceId: workspace.id,
      number: seed.number,
      name: seed.name,
      kind: seed.kind,
      group: seed.group,
      openItems: seed.openItems,
      ownerType: null,
      ownerBankAccountId: null,
      ownerContactId: null,
      ownerPlatform: null,
      ownerPersonName: null,
      description: seed.description,
    })),
  );
  const accounts = new Map((await repo.listAccounts(workspace.id)).map((account) => [account.number, account]));
  return { workspace, account: (number: string): LedgerAccountRow => accounts.get(number)! };
}

function entryRow(workspaceId: string, overrides: Partial<CreateJournalEntryRow> = {}): CreateJournalEntryRow {
  return {
    workspaceId,
    bookingDate: "2026-08-15",
    documentDate: null,
    serviceDate: null,
    text: "IONOS",
    status: "booked",
    origin: "manual",
    originReason: null,
    sourceKey: null,
    documentId: null,
    transactionId: null,
    correctionOfEntryId: null,
    filingId: null,
    warnings: [],
    userEditedAt: null,
    bookedAt: new Date(),
    bookedByUserId: null,
    ...overrides,
  };
}

function lines(debit: LedgerAccountRow, credit: LedgerAccountRow, cents = 150): CreateJournalLineRow[] {
  return [
    { position: 1, accountId: debit.id, amountCents: cents, taxCode: null, taxRole: null, generatedFromLinePosition: null, documentId: null, text: null },
    { position: 2, accountId: credit.id, amountCents: -cents, taxCode: null, taxRole: null, generatedFromLinePosition: null, documentId: null, text: null },
  ];
}

/** Inserts an entry with its lines in one transaction (the balance check runs at commit). */
async function insertEntry(workspaceId: string, entryLines: CreateJournalLineRow[], overrides: Partial<CreateJournalEntryRow> = {}) {
  return db.transaction(async (tx) => {
    const txRepo = createDrizzleLedgerRepository(tx);
    const entry = await txRepo.insertEntry(entryRow(workspaceId, overrides));
    await txRepo.replaceLines(workspaceId, entry.id, entryLines);
    return entry;
  });
}

async function submittedVatReturn(workspaceId: string, from = "2026-07-01", to = "2026-09-30") {
  return repo.insertFiling({ workspaceId, kind: "vat_return", status: "submitted", periodFrom: from, periodTo: to, submittedOn: "2026-10-10", amountCents: 1876, correctsFilingId: null, note: null, createdByUserId: null });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

function expectRaised(err: unknown, message: string) {
  expect(err).not.toBeNull();
  expect(isDbError(err, "raised")).toBe(true);
  expect(dbErrorOf(err).message).toBe(message);
}

describe("ledger: a booked entry balances (deferred constraint trigger)", () => {
  it("accepts a balanced booked entry", async () => {
    const { workspace, account } = await workspaceWithChart();
    const entry = await insertEntry(workspace.id, lines(account("6810"), account("1800")));
    expect(await repo.listLines(workspace.id, [entry.id])).toHaveLength(2);
  });

  it("refuses an unbalanced booked entry at commit", async () => {
    const { workspace, account } = await workspaceWithChart();
    const bad = lines(account("6810"), account("1800"));
    bad[1]!.amountCents = -149;
    expectRaised(await caught(insertEntry(workspace.id, bad)), "ledger_unbalanced");
    expect(await db.select().from(journalEntries).where(eq(journalEntries.workspaceId, workspace.id))).toHaveLength(0);
  });

  it("refuses a booked entry with a single line, or none", async () => {
    const { workspace, account } = await workspaceWithChart();
    expectRaised(await caught(insertEntry(workspace.id, [])), "ledger_unbalanced");
    expectRaised(await caught(db.insert(journalEntries).values(entryRow(workspace.id))), "ledger_unbalanced");
    expectRaised(await caught(insertEntry(workspace.id, lines(account("6810"), account("1800")).slice(0, 1))), "ledger_unbalanced");
  });

  it("lets a proposal be unbalanced, but not be booked that way", async () => {
    const { workspace, account } = await workspaceWithChart();
    const bad = lines(account("6810"), account("1800"));
    bad[1]!.amountCents = -100;
    const entry = await insertEntry(workspace.id, bad, { status: "proposed", bookedAt: null });
    expectRaised(await caught(repo.updateEntry(workspace.id, entry.id, { status: "booked", bookedAt: new Date() })), "ledger_unbalanced");
    // Fixing the lines and booking in the same transaction passes.
    await db.transaction(async (tx) => {
      const txRepo = createDrizzleLedgerRepository(tx);
      await txRepo.updateEntry(workspace.id, entry.id, { status: "booked", bookedAt: new Date() });
      await txRepo.replaceLines(workspace.id, entry.id, lines(account("6810"), account("1800"), 100));
    });
    expect((await repo.findEntry(workspace.id, entry.id))?.status).toBe("booked");
  });

  it("refuses changing one line of a booked entry so it no longer balances", async () => {
    const { workspace, account } = await workspaceWithChart();
    const entry = await insertEntry(workspace.id, lines(account("6810"), account("1800")));
    const err = await caught(db.update(journalLines).set({ amountCents: 151 }).where(eq(journalLines.entryId, entry.id)).execute());
    expectRaised(err, "ledger_unbalanced");
  });
});

describe("ledger: a submitted filing locks its period (trigger)", () => {
  it("refuses update and delete of a booked entry inside a submitted USt-VA period, and of its lines", async () => {
    const { workspace, account } = await workspaceWithChart();
    const entry = await insertEntry(workspace.id, lines(account("6810"), account("1800")));
    await submittedVatReturn(workspace.id);

    expectRaised(await caught(repo.updateEntry(workspace.id, entry.id, { text: "geändert" })), "ledger_locked");
    expectRaised(await caught(repo.updateEntry(workspace.id, entry.id, { bookingDate: "2026-10-01" })), "ledger_locked");
    expectRaised(await caught(repo.updateEntry(workspace.id, entry.id, { status: "proposed", bookedAt: null })), "ledger_locked");
    expectRaised(await caught(repo.deleteEntry(workspace.id, entry.id)), "ledger_locked");
    expectRaised(await caught(db.delete(journalLines).where(eq(journalLines.entryId, entry.id)).execute()), "ledger_locked");
    expectRaised(await caught(db.update(journalLines).set({ text: "x" }).where(eq(journalLines.entryId, entry.id)).execute()), "ledger_locked");
    const extra = await caught(
      db.insert(journalLines).values({ workspaceId: workspace.id, entryId: entry.id, position: 3, accountId: account("6810").id, amountCents: 1 }).execute(),
    );
    expectRaised(extra, "ledger_locked");
    expect(await repo.findEntry(workspace.id, entry.id)).toMatchObject({ text: "IONOS", bookingDate: "2026-08-15" });
  });

  it("refuses booking into a locked period, and moving an entry into it", async () => {
    const { workspace, account } = await workspaceWithChart();
    await submittedVatReturn(workspace.id);
    expectRaised(await caught(insertEntry(workspace.id, lines(account("6810"), account("1800")))), "ledger_locked");

    const proposal = await insertEntry(workspace.id, lines(account("6810"), account("1800")), { status: "proposed", bookedAt: null });
    expectRaised(await caught(repo.updateEntry(workspace.id, proposal.id, { status: "booked", bookedAt: new Date() })), "ledger_locked");

    const october = await insertEntry(workspace.id, lines(account("6810"), account("1800")), { bookingDate: "2026-10-02" });
    expectRaised(await caught(repo.updateEntry(workspace.id, october.id, { bookingDate: "2026-09-30" })), "ledger_locked");
  });

  it("leaves proposals and entries outside the period editable", async () => {
    const { workspace, account } = await workspaceWithChart();
    await submittedVatReturn(workspace.id);
    const proposal = await insertEntry(workspace.id, lines(account("6810"), account("1800")), { status: "proposed", bookedAt: null });
    expect(await repo.updateEntry(workspace.id, proposal.id, { text: "neu" })).toMatchObject({ text: "neu" });
    expect(await repo.deleteEntry(workspace.id, proposal.id)).toBe(true);

    const october = await insertEntry(workspace.id, lines(account("6810"), account("1800")), { bookingDate: "2026-10-01" });
    expect(await repo.updateEntry(workspace.id, october.id, { text: "neu" })).toMatchObject({ text: "neu" });
    expect(await repo.deleteEntry(workspace.id, october.id)).toBe(true);
  });

  it("a draft filing locks nothing", async () => {
    const { workspace, account } = await workspaceWithChart();
    const entry = await insertEntry(workspace.id, lines(account("6810"), account("1800")));
    await repo.insertFiling({ workspaceId: workspace.id, kind: "vat_return", status: "draft", periodFrom: "2026-07-01", periodTo: "2026-09-30", submittedOn: null, amountCents: null, correctsFilingId: null, note: null, createdByUserId: null });
    expect(await repo.updateEntry(workspace.id, entry.id, { text: "neu" })).toMatchObject({ text: "neu" });
  });

  it("a submitted annual statement locks every day of its year", async () => {
    const { workspace, account } = await workspaceWithChart();
    const march = await insertEntry(workspace.id, lines(account("6810"), account("1800")), { bookingDate: "2026-03-01" });
    await repo.insertFiling({ workspaceId: workspace.id, kind: "annual_statement", status: "submitted", periodFrom: "2026-01-01", periodTo: "2026-12-31", submittedOn: "2027-05-01", amountCents: null, correctsFilingId: null, note: null, createdByUserId: null });
    expectRaised(await caught(repo.deleteEntry(workspace.id, march.id)), "ledger_locked");
    expect(await repo.findLockingFiling(workspace.id, "2026-12-31", null)).toMatchObject({ kind: "annual_statement" });
    expect(await repo.findLockingFiling(workspace.id, "2027-01-01", null)).toBeNull();
  });

  it("an entry tied to a draft correcting filing may change; once the correction is submitted it is locked again", async () => {
    const { workspace, account } = await workspaceWithChart();
    const entry = await insertEntry(workspace.id, lines(account("6810"), account("1800")));
    const original = await submittedVatReturn(workspace.id);
    const correction = await repo.insertFiling({
      workspaceId: workspace.id,
      kind: "vat_return",
      status: "draft",
      periodFrom: original.periodFrom,
      periodTo: original.periodTo,
      submittedOn: null,
      amountCents: null,
      correctsFilingId: original.id,
      note: null,
      createdByUserId: null,
    });

    expect(await repo.findLockingFiling(workspace.id, "2026-08-15", null)).toMatchObject({ id: original.id });
    expect(await repo.findLockingFiling(workspace.id, "2026-08-15", correction.id)).toBeNull();

    // Tying the entry to the draft correction is what opens it.
    await db.transaction(async (tx) => {
      const txRepo = createDrizzleLedgerRepository(tx);
      await txRepo.updateEntry(workspace.id, entry.id, { filingId: correction.id, text: "korrigiert" });
      await txRepo.replaceLines(workspace.id, entry.id, lines(account("6815"), account("1800")));
    });
    // A new booked entry inside the period, tied to the correction, is allowed too.
    const added = await insertEntry(workspace.id, lines(account("6300"), account("1800"), 500), { filingId: correction.id });

    await repo.updateFiling(workspace.id, correction.id, { status: "submitted", submittedOn: "2026-11-01" });
    expectRaised(await caught(repo.updateEntry(workspace.id, entry.id, { text: "nochmal" })), "ledger_locked");
    expectRaised(await caught(repo.deleteEntry(workspace.id, added.id)), "ledger_locked");
  });

  it("a correction of a USt-VA does not open a period an annual statement locks", async () => {
    const { workspace, account } = await workspaceWithChart();
    const entry = await insertEntry(workspace.id, lines(account("6810"), account("1800")));
    const original = await submittedVatReturn(workspace.id);
    await repo.insertFiling({ workspaceId: workspace.id, kind: "annual_statement", status: "submitted", periodFrom: "2026-01-01", periodTo: "2026-12-31", submittedOn: "2027-05-01", amountCents: null, correctsFilingId: null, note: null, createdByUserId: null });
    const correction = await repo.insertFiling({ workspaceId: workspace.id, kind: "vat_return", status: "draft", periodFrom: original.periodFrom, periodTo: original.periodTo, submittedOn: null, amountCents: null, correctsFilingId: original.id, note: null, createdByUserId: null });
    expectRaised(await caught(repo.updateEntry(workspace.id, entry.id, { filingId: correction.id })), "ledger_locked");
  });

  it("a submitted filing itself can be neither changed nor deleted", async () => {
    const { workspace } = await workspaceWithChart();
    const filing = await submittedVatReturn(workspace.id);
    expectRaised(await caught(repo.updateFiling(workspace.id, filing.id, { amountCents: 0 })), "ledger_locked");
    expectRaised(await caught(db.delete(ledgerFilings).where(eq(ledgerFilings.id, filing.id)).execute()), "ledger_locked");
  });

  it("deleting the workspace removes locked entries and submitted filings (the cascade exception)", async () => {
    const { workspace, account } = await workspaceWithChart();
    await insertEntry(workspace.id, lines(account("6810"), account("1800")));
    await submittedVatReturn(workspace.id);
    expect(await workspaces.delete(workspace.id)).toMatchObject({ id: workspace.id });
    expect(await db.select().from(journalEntries).where(eq(journalEntries.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(journalLines).where(eq(journalLines.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(ledgerFilings).where(eq(ledgerFilings.workspaceId, workspace.id))).toHaveLength(0);
  });
});

describe("ledger: workspace isolation", () => {
  it("a line cannot point at another workspace's account or entry (composite foreign keys)", async () => {
    const a = await workspaceWithChart();
    const b = await workspaceWithChart();
    const err = await caught(insertEntry(a.workspace.id, lines(b.account("6810"), a.account("1800"))));
    expect(isDbError(err, "foreign_key")).toBe(true);

    const entry = await insertEntry(a.workspace.id, lines(a.account("6810"), a.account("1800")), { status: "proposed", bookedAt: null });
    const crossEntry = await caught(
      db.insert(journalLines).values({ workspaceId: b.workspace.id, entryId: entry.id, position: 9, accountId: b.account("6810").id, amountCents: 1 }).execute(),
    );
    expect(isDbError(crossEntry, "foreign_key")).toBe(true);
  });

  it("reads and writes stay inside the workspace", async () => {
    const a = await workspaceWithChart();
    const b = await workspaceWithChart();
    const entry = await insertEntry(a.workspace.id, lines(a.account("6810"), a.account("1800")));
    expect(await repo.findEntry(b.workspace.id, entry.id)).toBeNull();
    expect(await repo.updateEntry(b.workspace.id, entry.id, { text: "fremd" })).toBeNull();
    expect(await repo.deleteEntry(b.workspace.id, entry.id)).toBe(false);
    expect(await repo.listLines(b.workspace.id, [entry.id])).toEqual([]);
    expect(await repo.listReportLines(b.workspace.id, {})).toEqual([]);
    expect(await repo.findAccountById(b.workspace.id, a.account("1800").id)).toBeNull();
    // A submitted filing of workspace B does not lock workspace A.
    await submittedVatReturn(b.workspace.id);
    expect(await repo.findLockingFiling(a.workspace.id, "2026-08-15", null)).toBeNull();
    expect(await repo.updateEntry(a.workspace.id, entry.id, { text: "eigen" })).toMatchObject({ text: "eigen" });
  });
});

describe("ledger: open-item matches", () => {
  it("dissolves a match when one of its lines is replaced, and refuses a line in two matches", async () => {
    const { workspace, account } = await workspaceWithChart();
    const invoice = await insertEntry(workspace.id, lines(account("6300"), account("3300"), 1000));
    const payment = await insertEntry(workspace.id, lines(account("3300"), account("1800"), 1000));
    const all = await repo.listLines(workspace.id, [invoice.id, payment.id]);
    const payables = all.filter((line) => line.accountNumber === "3300").map((line) => line.id);
    const match = await repo.insertMatch({ workspaceId: workspace.id, accountId: account("3300").id, kind: "match", note: null, createdByUserId: null }, payables);
    expect(await repo.findMatchedLineIds(workspace.id, payables)).toHaveLength(2);

    const second = await caught(repo.insertMatch({ workspaceId: workspace.id, accountId: account("3300").id, kind: "match", note: null, createdByUserId: null }, [payables[0]!]));
    expect(isDbError(second, "unique")).toBe(true);

    await db.transaction(async (tx) => createDrizzleLedgerRepository(tx).replaceLines(workspace.id, payment.id, lines(account("3300"), account("1800"), 1000)));
    expect(await repo.findMatch(workspace.id, match.id)).toBeNull();
    expect(await repo.findMatchedLineIds(workspace.id, payables)).toEqual([]);
  });
});

describe("ledger: source reads", () => {
  it("never reaches another workspace's documents or transactions", async () => {
    const a = await workspaceWithChart();
    const b = await workspaceWithChart();
    const [doc] = await db.execute<{ id: string }>(
      sql`insert into documents (workspace_id, original_file_name, mime_type, page_count, size_bytes, storage_key) values (${a.workspace.id}, 'r.pdf', 'application/pdf', 1, 1, ${`k-${randomUUID()}`}) returning id`,
    ).then((result) => result.rows);
    expect(await repo.documentExists(a.workspace.id, doc!.id)).toBe(true);
    expect(await repo.documentExists(b.workspace.id, doc!.id)).toBe(false);
  });
});
