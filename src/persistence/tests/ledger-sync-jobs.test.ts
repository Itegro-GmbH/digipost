// The `ledger-sync` job (decisions/0080 phase 3): scheduled after every matching run for a
// workspace with the ledger on, deduplicated to one queued run, and its handler.
import { describe, expect, it, vi } from "vitest";

import { createJobHandlers } from "@/persistence/composition/job-handlers";
import type { LedgerRepository, LedgerSettingsRow } from "@/persistence/repositories/contracts";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { createLedgerUseCases, LEDGER_ERROR, type LedgerUseCases } from "@/persistence/use-cases/ledger-use-cases";
import { createFakeJobsRepository } from "@/persistence/tests/support/fake-jobs-repository";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";
import { JOB_KINDS } from "@/platform/jobs";

const WS = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-12T10:00:00Z");

function settings(enabled: boolean): LedgerSettingsRow {
  return { workspaceId: WS, enabled, vatPeriod: "month", vatBasis: "soll", startDate: "2026-06-01", chart: "skr04", createdAt: NOW, updatedAt: NOW };
}

function ledgerWith(enabled: boolean) {
  const jobs = createFakeJobsRepository();
  const ledgerRepo = { findSettings: async () => settings(enabled) } as Partial<LedgerRepository> as LedgerRepository;
  const repos = withUnusedRepositories({ ledger: ledgerRepo, jobs: jobs.repo });
  const ledger = createLedgerUseCases({ repos, uow: { transaction: (work) => work(repos) }, now: () => NOW });
  return { ledger, jobs: jobs.state };
}

describe("LedgerUseCases.scheduleSync", () => {
  it("queues one ledger-sync job for an enabled workspace, however often it is triggered", async () => {
    const { ledger, jobs } = ledgerWith(true);
    expect(await ledger.scheduleSync(WS)).toBe(true);
    await ledger.scheduleSync(WS);
    await ledger.scheduleSync(WS);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: JOB_KINDS.ledgerSync, workspaceId: WS, payload: { workspaceId: WS }, status: "pending" });
  });

  it("queues nothing while the ledger is off", async () => {
    const { ledger, jobs } = ledgerWith(false);
    expect(await ledger.scheduleSync(WS)).toBe(false);
    expect(jobs).toEqual([]);
  });
});

describe("job handlers", () => {
  function handlers(ledger: Partial<LedgerUseCases>, payments: Record<string, unknown> = {}, documents: Record<string, unknown> = {}) {
    return createJobHandlers({
      documents: documents as never,
      billing: {} as never,
      workspaces: {} as never,
      accounts: {} as never,
      payments: { runMatching: vi.fn(), matchSettlementReport: vi.fn(), ...payments } as never,
      mailIntake: {} as never,
      ledger: ledger as LedgerUseCases,
      mailer: {} as never,
      objectStorage: {} as never,
    });
  }

  it("schedules the ledger sync after a matching run and after a settlement report", async () => {
    const scheduleSync = vi.fn().mockResolvedValue(true);
    const h = handlers({ scheduleSync });
    await h[JOB_KINDS.matchPayments]!({ workspaceId: WS, trigger: "cron" });
    await h[JOB_KINDS.matchSettlementLines]!({ workspaceId: WS, documentId: WS });
    expect(scheduleSync).toHaveBeenCalledTimes(2);
    expect(scheduleSync).toHaveBeenCalledWith(WS);
  });

  it("never fails a matching run because scheduling the ledger sync failed", async () => {
    const h = handlers({ scheduleSync: vi.fn().mockRejectedValue(new Error("db down")) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(h[JOB_KINDS.matchPayments]!({ workspaceId: WS, trigger: "cron" })).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("runs the sync, schedules one more run for deferred documents, and ignores a ledger switched off since", async () => {
    const syncProposals = vi.fn().mockResolvedValueOnce({ deferred: 3 }).mockResolvedValueOnce({ deferred: 0 }).mockRejectedValueOnce(new UseCaseError(LEDGER_ERROR.disabled));
    const scheduleSync = vi.fn().mockResolvedValue(true);
    const h = handlers({ syncProposals, scheduleSync });
    await h[JOB_KINDS.ledgerSync]!({ workspaceId: WS });
    await h[JOB_KINDS.ledgerSync]!({ workspaceId: WS });
    await h[JOB_KINDS.ledgerSync]!({ workspaceId: WS });
    expect(syncProposals).toHaveBeenCalledWith({ workspaceId: WS });
    expect(scheduleSync).toHaveBeenCalledTimes(1);
  });

  it("schedules the ledger sync after a backfilled document got tax fields, not when it got none", async () => {
    const scheduleSync = vi.fn().mockResolvedValue(true);
    const backfillDocumentTaxFields = vi.fn().mockResolvedValueOnce({ filled: true }).mockResolvedValueOnce({ filled: false });
    const h = handlers({ scheduleSync }, {}, { backfillDocumentTaxFields });
    await h[JOB_KINDS.backfillTaxFields]!({ workspaceId: WS, documentId: WS });
    await h[JOB_KINDS.backfillTaxFields]!({ workspaceId: WS, documentId: WS });
    expect(backfillDocumentTaxFields).toHaveBeenCalledWith({ workspaceId: WS, documentId: WS });
    expect(scheduleSync).toHaveBeenCalledTimes(1);
  });
});
