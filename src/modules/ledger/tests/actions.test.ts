// Unit tests for the ledger Server Actions (WEBAPP_TEMPLATE_SPEC.md §10.2: `vi.mock` on the exact
// module paths `actions.ts` imports, no DB, no network). The permission gate is `finance.manage`
// (admin-only): a member's `requirePermission` resolves to `forbidden` and the use case is never
// reached; malformed input is refused before the permission check.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/access/server", () => ({ requirePermission: vi.fn() }));
const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePathMock(...args) }));

const ledgerUseCases = {
  setSettings: vi.fn(),
  createEntry: vi.fn(),
  bookEntry: vi.fn(),
  bulkBook: vi.fn(),
  createMatch: vi.fn(),
  submitFiling: vi.fn(),
  uploadAdvisorBalances: vi.fn(),
  syncProposals: vi.fn(),
  learnRuleFromEntry: vi.fn(),
};
vi.mock("@/persistence/composition/request-services", () => ({ getRequestServices: () => ({ ledger: ledgerUseCases }) }));

import { PERMISSIONS } from "@/platform/access";
import { requirePermission } from "@/platform/access/server";
import { UseCaseError } from "@/persistence/use-cases/errors";

import {
  bookJournalEntryAction,
  bulkBookJournalEntriesAction,
  createJournalEntryAction,
  createOpenItemMatchAction,
  learnLedgerRuleFromEntryAction,
  saveLedgerSettingsAction,
  syncLedgerProposalsAction,
  submitFilingAction,
  uploadAdvisorBalancesAction,
} from "../actions";

const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const FORBIDDEN = { status: "error" as const, errorCode: "forbidden" as const };
const OK_ACCESS = {
  status: "ok" as const,
  access: {
    user: { id: "u1", email: "admin@example.test" },
    membershipId: "m1",
    role: "admin" as const,
    workspace: { id: "w1", name: "Itegro GmbH", tier: "free" },
    permissions: [PERMISSIONS.financeRead, PERMISSIONS.financeManage] as const,
  },
};
const ENTRY = {
  entry: {
    bookingDate: "2026-07-01",
    text: "IONOS",
    lines: [
      { accountNumber: "6810", amountCents: 150, taxCode: "vst19" },
      { accountNumber: "1800", amountCents: -150 },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ledger actions: the finance.manage gate", () => {
  it.each([
    ["saveLedgerSettingsAction", () => saveLedgerSettingsAction({ enabled: true, vatPeriod: "quarter", vatBasis: "soll", startDate: "2026-06-01" })],
    ["createJournalEntryAction", () => createJournalEntryAction(ENTRY)],
    ["bookJournalEntryAction", () => bookJournalEntryAction({ entryId: ENTRY_ID })],
    ["bulkBookJournalEntriesAction", () => bulkBookJournalEntriesAction({ entryIds: [ENTRY_ID] })],
    ["createOpenItemMatchAction", () => createOpenItemMatchAction({ accountNumber: "1461", kind: "match", lineIds: [ENTRY_ID] })],
    ["submitFilingAction", () => submitFilingAction({ filingId: ENTRY_ID, submittedOn: "2026-10-10" })],
    ["uploadAdvisorBalancesAction", () => uploadAdvisorBalancesAction({ periodFrom: "2026-01-01", periodTo: "2026-09-30", csvText: "Konto;Saldo" })],
    ["syncLedgerProposalsAction", () => syncLedgerProposalsAction({})],
    ["learnLedgerRuleFromEntryAction", () => learnLedgerRuleFromEntryAction({ entryId: ENTRY_ID })],
  ])("%s: a member is forbidden and no use case runs", async (_name, call) => {
    vi.mocked(requirePermission).mockResolvedValue(FORBIDDEN);
    expect(await call()).toEqual({ status: "error", errorCode: "forbidden" });
    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.financeManage);
    for (const fn of Object.values(ledgerUseCases)) expect(fn).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("createJournalEntryAction", () => {
  it("refuses invalid input before checking the permission", async () => {
    expect(await createJournalEntryAction({ entry: { ...ENTRY.entry, lines: [] } })).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("creates the entry in the caller's own workspace and revalidates the ledger", async () => {
    vi.mocked(requirePermission).mockResolvedValue(OK_ACCESS);
    ledgerUseCases.createEntry.mockResolvedValue({ entryId: ENTRY_ID });
    expect(await createJournalEntryAction({ ...ENTRY, book: true, workspaceId: "someone-else" })).toEqual({ status: "success", data: { entryId: ENTRY_ID } });
    expect(ledgerUseCases.createEntry).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", userId: "u1", book: true }));
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/buchhaltung", "layout");
  });
});

describe("bookJournalEntryAction", () => {
  it("passes a use-case code through", async () => {
    vi.mocked(requirePermission).mockResolvedValue(OK_ACCESS);
    ledgerUseCases.bookEntry.mockRejectedValue(new UseCaseError("locked"));
    expect(await bookJournalEntryAction({ entryId: ENTRY_ID })).toEqual({ status: "error", errorCode: "locked" });
  });

  it("maps anything else to unknown", async () => {
    vi.mocked(requirePermission).mockResolvedValue(OK_ACCESS);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ledgerUseCases.bookEntry.mockRejectedValue(new Error("connection reset"));
    expect(await bookJournalEntryAction({ entryId: ENTRY_ID })).toEqual({ status: "error", errorCode: "unknown" });
    expect(consoleError).toHaveBeenCalledWith("[ledger] action failed", "Error");
    consoleError.mockRestore();
  });

  it("maps an unknown UseCaseError code to unknown", async () => {
    vi.mocked(requirePermission).mockResolvedValue(OK_ACCESS);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ledgerUseCases.bookEntry.mockRejectedValue(new UseCaseError("some_other_module_code"));
    expect(await bookJournalEntryAction({ entryId: ENTRY_ID })).toEqual({ status: "error", errorCode: "unknown" });
    consoleError.mockRestore();
  });
});

describe("syncLedgerProposalsAction", () => {
  it("syncs the caller's own workspace, optionally for a period", async () => {
    vi.mocked(requirePermission).mockResolvedValue(OK_ACCESS);
    ledgerUseCases.syncProposals.mockResolvedValue({ created: 2 });
    expect(await syncLedgerProposalsAction({ from: "2026-07-01", to: "2026-07-31", workspaceId: "someone-else" })).toEqual({ status: "success", data: { created: 2 } });
    expect(ledgerUseCases.syncProposals).toHaveBeenCalledWith({ workspaceId: "w1", from: "2026-07-01", to: "2026-07-31" });
    expect(await syncLedgerProposalsAction(undefined)).toMatchObject({ status: "success" });
  });

  it("refuses a reversed period before checking the permission", async () => {
    expect(await syncLedgerProposalsAction({ from: "2026-08-01", to: "2026-07-01" })).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });
});

describe("learnLedgerRuleFromEntryAction", () => {
  it("passes rule_source_missing through", async () => {
    vi.mocked(requirePermission).mockResolvedValue(OK_ACCESS);
    ledgerUseCases.learnRuleFromEntry.mockRejectedValue(new UseCaseError("rule_source_missing"));
    expect(await learnLedgerRuleFromEntryAction({ entryId: ENTRY_ID })).toEqual({ status: "error", errorCode: "rule_source_missing" });
    expect(ledgerUseCases.learnRuleFromEntry).toHaveBeenCalledWith({ workspaceId: "w1", entryId: ENTRY_ID });
  });
});
