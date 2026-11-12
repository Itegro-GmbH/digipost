// `createLedgerUseCases` (decisions/0080-ledger-double-entry-bookkeeping.md) with a small typed
// fake: no database, no vi.mock. Covers what a fake can show better than Postgres: the checks
// that run before anything is written, and how the database's own refusals (raised by a trigger,
// possibly only at COMMIT) map to stable codes. The full flows run against real Postgres in
// `ledger-use-cases.db.test.ts`.
import { describe, expect, it } from "vitest";

import { SKR04_SEED_ACCOUNTS, type EntryInput } from "@/modules/ledger";
import type {
  CreateJournalEntryRow,
  JournalEntryRow,
  JournalLineWithAccount,
  LedgerAccountRow,
  LedgerRepository,
  LedgerSettingsRow,
  Repositories,
  UnitOfWork,
} from "@/persistence/repositories/contracts";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { createLedgerUseCases, LEDGER_ERROR } from "@/persistence/use-cases/ledger-use-cases";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-12T10:00:00Z");

type State = { settings: LedgerSettingsRow | null; accounts: LedgerAccountRow[]; entries: JournalEntryRow[]; lines: JournalLineWithAccount[]; writes: string[] };

function accountRows(): LedgerAccountRow[] {
  return SKR04_SEED_ACCOUNTS.map((seed) => ({
    id: `acc-${seed.number}`,
    workspaceId: WS,
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
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }));
}

/** Only the methods the tested paths reach; anything else throws. */
function fakeLedger(state: State): LedgerRepository {
  const impl: Partial<LedgerRepository> = {
    findSettings: async () => state.settings,
    listAccounts: async () => state.accounts,
    findAccountByNumber: async (_ws, number) => state.accounts.find((account) => account.number === number) ?? null,
    findLockingFiling: async () => null,
    documentExists: async () => true,
    transactionExists: async () => true,
    findEntry: async (_ws, id) => state.entries.find((entry) => entry.id === id) ?? null,
    findEntryBySourceKey: async (_ws, key) => state.entries.find((entry) => entry.sourceKey === key) ?? null,
    listLines: async (_ws, ids) => state.lines.filter((line) => ids.includes(line.entryId)),
    insertEntry: async (row: CreateJournalEntryRow) => {
      state.writes.push("insertEntry");
      const entry: JournalEntryRow = { id: `e${state.entries.length + 1}`, dismissedAt: null, revision: 1, createdAt: NOW, updatedAt: NOW, ...row } as JournalEntryRow;
      state.entries.push(entry);
      return entry;
    },
    updateEntry: async () => {
      state.writes.push("updateEntry");
      return null;
    },
    replaceLines: async () => {
      state.writes.push("replaceLines");
      return [];
    },
    insertRevision: async (row) => {
      state.writes.push(`revision:${row.changeKind}`);
      return { id: "r", changedAt: NOW, ...row } as never;
    },
    insertAccount: async (row) => {
      state.writes.push("insertAccount");
      return { id: "acc-new", archivedAt: null, createdAt: NOW, updatedAt: NOW, ...row };
    },
  };
  return new Proxy(impl as LedgerRepository, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === "symbol" || prop === "then") return undefined;
      throw new Error(`LedgerRepository.${String(prop)} is not provided by this fake`);
    },
  });
}

function setup(options: { enabled?: boolean; commitError?: unknown } = {}) {
  const state: State = {
    settings: options.enabled === false ? null : { workspaceId: WS, enabled: true, vatPeriod: "month", vatBasis: "soll", startDate: null, chart: "skr04", createdAt: NOW, updatedAt: NOW },
    accounts: accountRows(),
    entries: [],
    lines: [],
    writes: [],
  };
  const repos: Repositories = withUnusedRepositories({ ledger: fakeLedger(state) });
  const uow: UnitOfWork = {
    async transaction(work) {
      const result = await work(repos);
      // Postgres runs the deferred balance trigger at COMMIT, after `work` returned.
      if (options.commitError) throw options.commitError;
      return result;
    },
  };
  return { state, ledger: createLedgerUseCases({ repos, uow, now: () => NOW }) };
}

const ionos: EntryInput = {
  bookingDate: "2026-07-01",
  text: "IONOS",
  lines: [
    { accountNumber: "6810", amountCents: 150, taxCode: "vst19" },
    { accountNumber: "1800", amountCents: -150 },
  ],
};

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof UseCaseError) return err.code;
    throw err;
  }
  throw new Error("expected a UseCaseError");
}

describe("ledger use cases: before anything is written", () => {
  it("refuses everything but the settings while the ledger is off", async () => {
    const { ledger, state } = setup({ enabled: false });
    expect(await ledger.getSettings(WS)).toMatchObject({ enabled: false });
    expect(await code(ledger.createEntry({ workspaceId: WS, userId: USER, entry: ionos, book: true }))).toBe(LEDGER_ERROR.disabled);
    expect(await code(ledger.upsertProposal({ workspaceId: WS, proposal: { sourceKey: "doc:1", entry: ionos, origin: "template", warnings: [] } }))).toBe(LEDGER_ERROR.disabled);
    expect(state.writes).toEqual([]);
  });

  it("refuses to book an unbalanced entry without writing it", async () => {
    const { ledger, state } = setup();
    const entry = { ...ionos, lines: [ionos.lines[0]!, { accountNumber: "1800", amountCents: -100 }] };
    expect(await code(ledger.createEntry({ workspaceId: WS, userId: USER, entry, book: true }))).toBe(LEDGER_ERROR.unbalanced);
    expect(state.writes).toEqual([]);
  });

  it("refuses an unknown account before writing", async () => {
    const { ledger, state } = setup();
    const entry = { ...ionos, lines: [{ accountNumber: "4711", amountCents: 1 }, { accountNumber: "1800", amountCents: -1 }] };
    expect(await code(ledger.createEntry({ workspaceId: WS, userId: USER, entry, book: false }))).toBe(LEDGER_ERROR.accountNotFound);
    expect(state.writes).toEqual([]);
  });

  it("asks for a reason before changing a booked entry", async () => {
    const { ledger, state } = setup();
    await ledger.createEntry({ workspaceId: WS, userId: USER, entry: ionos, book: true });
    state.writes.length = 0;
    expect(await code(ledger.updateEntry({ workspaceId: WS, userId: USER, entryId: "e1", entry: ionos }))).toBe(LEDGER_ERROR.reasonRequired);
    expect(await code(ledger.deleteEntry({ workspaceId: WS, userId: USER, entryId: "e1" }))).toBe(LEDGER_ERROR.reasonRequired);
    expect(state.writes).toEqual([]);
  });

  it("writes the entry, its lines and the `created` revision together", async () => {
    const { ledger, state } = setup();
    expect(await ledger.createEntry({ workspaceId: WS, userId: USER, entry: ionos, book: true })).toEqual({ entryId: "e1" });
    expect(state.writes).toEqual(["insertEntry", "replaceLines", "revision:created"]);
    expect(state.entries[0]).toMatchObject({ status: "booked", origin: "manual", bookedByUserId: USER, userEditedAt: NOW });
  });

  it("leaves a booked proposal alone when the engine proposes its source again", async () => {
    const { ledger, state } = setup();
    state.entries.push({ id: "booked", sourceKey: "doc:1", status: "booked", dismissedAt: null, userEditedAt: null } as JournalEntryRow);
    expect(await ledger.upsertProposal({ workspaceId: WS, proposal: { sourceKey: "doc:1", entry: ionos, origin: "template", warnings: [] } })).toEqual({ entryId: "booked", outcome: "kept" });
    expect(state.writes).toEqual([]);
  });
});

describe("ledger use cases: the database's refusals", () => {
  it("maps the lock trigger to `locked`", async () => {
    const { ledger } = setup({ commitError: { code: "P0001", message: "ledger_locked" } });
    expect(await code(ledger.createEntry({ workspaceId: WS, userId: USER, entry: ionos, book: true }))).toBe(LEDGER_ERROR.locked);
  });

  it("maps the deferred balance check at commit, wrapped like Drizzle wraps it, to `unbalanced`", async () => {
    const wrapped = Object.assign(new Error("Failed query: COMMIT"), { cause: { code: "P0001", message: "ledger_unbalanced" } });
    const { ledger } = setup({ commitError: wrapped });
    expect(await code(ledger.createEntry({ workspaceId: WS, userId: USER, entry: ionos, book: true }))).toBe(LEDGER_ERROR.unbalanced);
  });

  it("maps a concurrent duplicate account number to `account_number_taken`", async () => {
    const { ledger } = setup({ commitError: { code: "23505", message: "duplicate key", constraint: "ledger_accounts_workspace_number_key" } });
    const account = { number: "3511", name: "Auslagen Luca", kind: "liability" as const, group: "open_items" as const, openItems: true, ownerType: "person" as const, ownerPersonName: "Luca" };
    expect(await code(ledger.createAccount({ workspaceId: WS, account }))).toBe(LEDGER_ERROR.accountNumberTaken);
  });

  it("rethrows anything it does not know", async () => {
    const { ledger } = setup({ commitError: new Error("connection reset") });
    await expect(ledger.createEntry({ workspaceId: WS, userId: USER, entry: ionos, book: false })).rejects.toThrow("connection reset");
  });
});
