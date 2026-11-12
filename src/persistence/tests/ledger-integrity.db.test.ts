// Real Postgres, the ledger's integrity under edits and concurrency
// (decisions/0080-ledger-double-entry-bookkeeping.md): matches follow the lines they settle
// (unbooking, deleting, editing), a correcting filing is picked up when booking into a locked
// period, two writers on one entry never both win (conditional updates, row locks, one revision
// per number), and a bulk booking or the automatic matching after a booking never turns a
// successful booking into an error.
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EntryInput } from "@/modules/ledger";
import { getDb } from "@/persistence/foundation/client";
import { dbErrorOf } from "@/persistence/foundation/db-errors";
import type { Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { accounts } from "@/persistence/schema/accounts";
import { documents } from "@/persistence/schema/documents";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { createLedgerUseCases } from "@/persistence/use-cases/ledger-use-cases";

const db = getDb();
const repos = createDrizzleRepositories(db);
const uow = createDrizzleUnitOfWork(db);
const ledger = createLedgerUseCases({ repos, uow });
const USER = randomUUID();

async function enabledWorkspace() {
  const workspace = await createDrizzleWorkspaceRepository(db).create({ name: `Itegro GmbH ${randomUUID()}` });
  await db.insert(accounts).values({ workspaceId: workspace.id, type: "bank", name: "Finom Main", iban: `DE${randomUUID().slice(0, 8)}` });
  await ledger.setSettings({ workspaceId: workspace.id, settings: { enabled: true, vatPeriod: "quarter", vatBasis: "soll", startDate: "2026-06-01" } });
  return workspace.id;
}

async function invoiceDocument(workspaceId: string) {
  const [row] = await db
    .insert(documents)
    .values({ workspaceId, originalFileName: "r.pdf", mimeType: "application/pdf", pageCount: 1, sizeBytes: 1, storageKey: `k-${randomUUID()}`, kind: "incoming_invoice", status: "done", documentDate: "2026-07-01", title: "IONOS" })
    .returning();
  return row!.id;
}

async function code(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (err: unknown) => {
      if (err instanceof UseCaseError) return err.code;
      throw err;
    },
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** IONOS 1,50 on payables 3300, carrying the document. */
const invoice = (documentId: string, overrides: Partial<EntryInput> = {}): EntryInput => ({
  bookingDate: "2026-07-01",
  text: "IONOS Rechnung",
  lines: [
    { accountNumber: "6810", amountCents: 150, taxCode: "vst19" },
    { accountNumber: "3300", amountCents: -150, documentId },
  ],
  documentId,
  ...overrides,
});

/** Its payment from the bank, carrying the same document. */
const payment = (documentId: string, overrides: Partial<EntryInput> = {}): EntryInput => ({
  bookingDate: "2026-07-05",
  text: "IONOS Zahlung",
  lines: [
    { accountNumber: "3300", amountCents: 150, documentId },
    { accountNumber: "1800", amountCents: -150 },
  ],
  ...overrides,
});

const ionos = (overrides: Partial<EntryInput> = {}): EntryInput => ({
  bookingDate: "2026-07-01",
  text: "IONOS",
  lines: [
    { accountNumber: "6810", amountCents: 150, taxCode: "vst19" },
    { accountNumber: "1800", amountCents: -150 },
  ],
  ...overrides,
});

/** An invoice and its payment, both booked and matched automatically on 3300. */
async function matchedPair(workspaceId: string) {
  const documentId = await invoiceDocument(workspaceId);
  const inv = await ledger.createEntry({ workspaceId, userId: USER, entry: invoice(documentId), book: true });
  const pay = await ledger.createEntry({ workspaceId, userId: USER, entry: payment(documentId), book: true });
  expect(await ledger.autoMatchOpenItems(workspaceId)).toBe(1);
  return { documentId, invoiceId: inv.entryId, paymentId: pay.entryId };
}

describe("matches follow the lines they settle", () => {
  it("unbooking an entry dissolves its matches; booking it again matches anew", async () => {
    const workspaceId = await enabledWorkspace();
    const { paymentId } = await matchedPair(workspaceId);
    await ledger.unbookEntry({ workspaceId, userId: USER, entryId: paymentId, reason: "falsches Datum" });
    expect(await repos.ledger.listMatches(workspaceId)).toEqual([]);
    await ledger.bookEntry({ workspaceId, userId: USER, entryId: paymentId });
    expect(await repos.ledger.listMatches(workspaceId)).toHaveLength(1);
  });

  it("deleting an entry dissolves its matches, so the invoice is open again", async () => {
    const workspaceId = await enabledWorkspace();
    const { paymentId } = await matchedPair(workspaceId);
    await ledger.deleteEntry({ workspaceId, userId: USER, entryId: paymentId, reason: "doppelt" });
    expect(await repos.ledger.listMatches(workspaceId)).toEqual([]);
    const items = await ledger.getOpenItems(workspaceId, { accountNumber: "3300", asOf: "2026-12-31" });
    expect(items).toMatchObject({ balanceCents: -150, status: "open" });
    expect(items!.unmatched).toHaveLength(1);
  });

  it("editing an entry keeps its matches when the matched lines stay the same", async () => {
    const workspaceId = await enabledWorkspace();
    const { documentId, invoiceId } = await matchedPair(workspaceId);
    const [match] = await repos.ledger.listMatches(workspaceId);

    // Only the text: the lines are identical, nothing is replaced.
    await ledger.updateEntry({ workspaceId, userId: USER, entryId: invoiceId, entry: invoice(documentId, { text: "IONOS Juli" }), reason: "Text" });
    expect((await repos.ledger.listMatches(workspaceId)).map((row) => [row.id, row.lineIds.sort()])).toEqual([[match!.id, match!.lineIds.sort()]]);

    // Another expense account: the 3300 line keeps its position, account, amount and document.
    await ledger.updateEntry({ workspaceId, userId: USER, entryId: invoiceId, entry: invoice(documentId, { lines: [{ accountNumber: "6837", amountCents: 150, taxCode: "vst19" }, { accountNumber: "3300", amountCents: -150, documentId }] }), reason: "Lizenz" });
    expect((await repos.ledger.listMatches(workspaceId)).map((row) => row.id)).toEqual([match!.id]);
    expect((await ledger.getEntry(workspaceId, invoiceId))!.lines[0]!.accountNumber).toBe("6837");

    // The matched line itself changes: the match is dissolved.
    await ledger.updateEntry({ workspaceId, userId: USER, entryId: invoiceId, entry: invoice(documentId, { lines: [{ accountNumber: "6837", amountCents: 150, taxCode: "vst19" }, { accountNumber: "3300", amountCents: -150, documentId: null }] }), reason: "ohne Beleg" });
    expect(await repos.ledger.listMatches(workspaceId)).toEqual([]);
  });
});

describe("booking into a period a filing locked, through its correcting filing", () => {
  it("the one draft correction is used automatically; its submission locks the entries again", async () => {
    const workspaceId = await enabledWorkspace();
    const old = await ledger.createEntry({ workspaceId, userId: USER, entry: ionos({ bookingDate: "2026-08-15" }), book: true });
    const filing = await ledger.createFiling({ workspaceId, userId: USER, filing: { kind: "vat_return", periodFrom: "2026-07-01", periodTo: "2026-09-30", status: "draft" } });
    await ledger.submitFiling({ workspaceId, filingId: filing.id, submittedOn: "2026-10-10" });
    expect(await code(ledger.createEntry({ workspaceId, userId: USER, entry: ionos({ bookingDate: "2026-08-20" }), book: true }))).toBe("locked");

    const correction = await ledger.createCorrectionFiling({ workspaceId, userId: USER, filingId: filing.id });
    // A new entry booked in the locked quarter, an edit of a locked entry, and a proposal booked there.
    const created = await ledger.createEntry({ workspaceId, userId: USER, entry: ionos({ bookingDate: "2026-08-20", text: "nachgebucht" }), book: true });
    expect((await ledger.getEntry(workspaceId, created.entryId))).toMatchObject({ status: "booked", filingId: correction.id, lockedBy: null });
    await ledger.updateEntry({ workspaceId, userId: USER, entryId: old.entryId, entry: ionos({ bookingDate: "2026-08-15", text: "berichtigt" }), reason: "Berichtigung Q3" });
    expect((await ledger.getEntry(workspaceId, old.entryId))).toMatchObject({ text: "berichtigt", filingId: correction.id });
    const proposal = await ledger.createEntry({ workspaceId, userId: USER, entry: ionos({ bookingDate: "2026-09-01" }), book: false });
    await ledger.bookEntry({ workspaceId, userId: USER, entryId: proposal.entryId });
    expect((await ledger.getEntry(workspaceId, proposal.entryId))).toMatchObject({ status: "booked", filingId: correction.id });

    await ledger.submitFiling({ workspaceId, filingId: correction.id, submittedOn: "2026-11-05" });
    for (const entryId of [created.entryId, old.entryId, proposal.entryId]) {
      expect((await ledger.getEntry(workspaceId, entryId))?.lockedBy).not.toBeNull();
      expect(await code(ledger.updateEntry({ workspaceId, userId: USER, entryId, entry: ionos({ bookingDate: "2026-08-20" }), reason: "x" }))).toBe("locked");
    }
  });

  it("with two draft corrections covering the date the caller has to choose", async () => {
    const workspaceId = await enabledWorkspace();
    const filing = await ledger.createFiling({ workspaceId, userId: USER, filing: { kind: "vat_return", periodFrom: "2026-07-01", periodTo: "2026-09-30", status: "draft" } });
    await ledger.submitFiling({ workspaceId, filingId: filing.id, submittedOn: "2026-10-10" });
    const first = await ledger.createCorrectionFiling({ workspaceId, userId: USER, filingId: filing.id });
    await ledger.submitFiling({ workspaceId, filingId: first.id, submittedOn: "2026-10-20" });
    const again = await ledger.createCorrectionFiling({ workspaceId, userId: USER, filingId: filing.id });
    await ledger.createCorrectionFiling({ workspaceId, userId: USER, filingId: first.id });

    expect(await code(ledger.createEntry({ workspaceId, userId: USER, entry: ionos({ bookingDate: "2026-08-20" }), book: true }))).toBe("filing_choice_required");
    const chosen = await ledger.createEntry({ workspaceId, userId: USER, entry: ionos({ bookingDate: "2026-08-20", filingId: again.id }), book: true });
    expect((await ledger.getEntry(workspaceId, chosen.entryId))?.filingId).toBe(again.id);
  });
});

describe("two writers on one entry", () => {
  it("two concurrent bookings: one books, the other is told it is already booked; one revision each", async () => {
    const workspaceId = await enabledWorkspace();
    const { entryId } = await ledger.createEntry({ workspaceId, userId: USER, entry: ionos(), book: false });
    const results = await Promise.all([code(ledger.bookEntry({ workspaceId, userId: USER, entryId })), code(ledger.bookEntry({ workspaceId, userId: USER, entryId }))]);
    expect(results.sort()).toEqual(["already_booked", null].sort());
    expect((await repos.ledger.listRevisions(workspaceId, entryId)).map((revision) => [revision.revision, revision.changeKind])).toEqual([
      [1, "created"],
      [2, "booked"],
    ]);
  });

  it("two concurrent edits of the same revision: the second is stale", async () => {
    const workspaceId = await enabledWorkspace();
    const { entryId } = await ledger.createEntry({ workspaceId, userId: USER, entry: ionos(), book: false });
    const results = await Promise.all(
      ["A", "B"].map((text) => code(ledger.updateEntry({ workspaceId, userId: USER, entryId, entry: ionos({ text }), expectedRevision: 1 }))),
    );
    expect(results.sort()).toEqual([null, "stale_revision"].sort());
    expect((await repos.ledger.listRevisions(workspaceId, entryId)).map((revision) => revision.revision)).toEqual([1, 2]);
  });

  it("an edit and an unbooking at once: the one that comes second sees the first", async () => {
    const workspaceId = await enabledWorkspace();
    const { entryId } = await ledger.createEntry({ workspaceId, userId: USER, entry: ionos(), book: true });
    const results = await Promise.all([
      code(ledger.unbookEntry({ workspaceId, userId: USER, entryId, reason: "zurück" })),
      code(ledger.updateEntry({ workspaceId, userId: USER, entryId, entry: ionos({ text: "neu" }), reason: "Text", expectedRevision: 1 })),
    ]);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(await repos.ledger.listRevisions(workspaceId, entryId)).toHaveLength(2);
  });

  it("the proposal engine never overwrites an entry a human edits while it runs", async () => {
    const workspaceId = await enabledWorkspace();
    const proposal = { sourceKey: `tx:${randomUUID()}`, entry: ionos(), origin: "template" as const, warnings: [] };
    const { entryId } = await ledger.upsertProposal({ workspaceId, proposal });

    // A human's edit holds the row in its own transaction while the engine writes.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const human = uow.transaction(async (tx) => {
      await tx.ledger.findEntry(workspaceId, entryId, { forUpdate: true });
      await tx.ledger.updateEntry(workspaceId, entryId, { text: "von Hand", userEditedAt: new Date(), revision: 2 });
      await gate;
    });
    await sleep(50);
    const engine = ledger.upsertProposal({ workspaceId, proposal: { ...proposal, entry: ionos({ text: "Maschine" }) } });
    await sleep(150);
    release();
    await human;
    expect((await engine).outcome).toBe("kept");
    expect((await ledger.getEntry(workspaceId, entryId))?.text).toBe("von Hand");
  });

  it("the database refuses a second revision with the same number", async () => {
    const workspaceId = await enabledWorkspace();
    const { entryId } = await ledger.createEntry({ workspaceId, userId: USER, entry: ionos(), book: false });
    const duplicate = repos.ledger.insertRevision({ workspaceId, entryId, entryRef: entryId, revision: 1, changeKind: "created", reason: null, bookingDate: "2026-07-01", snapshot: null, changedByUserId: USER });
    const error = await duplicate.then(
      () => null,
      (err: unknown) => dbErrorOf(err),
    );
    expect(error).toMatchObject({ kind: "unique", constraint: "journal_entry_revisions_entry_revision_key" });
  });
});

describe("bulk booking and the automatic matching after a booking", () => {
  /** The real repositories, except that `findEntry` fails for one entry like a dropped connection. */
  function failingUow(poisonedId: string): UnitOfWork {
    return {
      transaction: (work) =>
        uow.transaction((tx) => {
          const findEntry: Repositories["ledger"]["findEntry"] = async (workspaceId, id, options) => {
            if (id === poisonedId) throw new Error("connection reset");
            return tx.ledger.findEntry(workspaceId, id, options);
          };
          return work({ ...tx, ledger: { ...tx.ledger, findEntry } });
        }),
    };
  }

  it("an unexpected error on one entry is reported for that entry; the others are booked", async () => {
    const workspaceId = await enabledWorkspace();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => ledger.createEntry({ workspaceId, userId: USER, entry: ionos(), book: false })));
    const flaky = createLedgerUseCases({ repos, uow: failingUow(b!.entryId) });
    const result = await flaky.bulkBook({ workspaceId, userId: USER, entryIds: [a!.entryId, b!.entryId, c!.entryId] });
    expect(result.booked).toEqual([a!.entryId, c!.entryId]);
    expect(result.failed).toEqual([{ entryId: b!.entryId, errorCode: "unknown" }]);
  });

  it("a failing automatic matching after a successful booking does not fail the booking", async () => {
    const workspaceId = await enabledWorkspace();
    const { entryId } = await ledger.createEntry({ workspaceId, userId: USER, entry: ionos(), book: false });
    const second = await ledger.createEntry({ workspaceId, userId: USER, entry: ionos(), book: false });
    const broken = createLedgerUseCases({
      repos: { ...repos, ledger: { ...repos.ledger, listUnmatchedOpenItemLines: () => Promise.reject(new Error("timeout")) } },
      uow,
    });
    await broken.bookEntry({ workspaceId, userId: USER, entryId });
    expect((await ledger.getEntry(workspaceId, entryId))?.status).toBe("booked");
    expect(await broken.bulkBook({ workspaceId, userId: USER, entryIds: [second.entryId] })).toEqual({ booked: [second.entryId], failed: [] });
  });
});
