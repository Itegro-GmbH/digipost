import { describe, expect, it } from "vitest";

import type { JournalEntryRevisionView } from "../core/types";
import { lineDiff, revisionSteps } from "../ui/revision-diff";

const line = (accountNumber: string, amountCents: number) => ({ accountNumber, amountCents, taxCode: null, taxRole: null, text: null });

describe("lineDiff", () => {
  it("shows the court letter split: 305 on 6825 became 300 on 6825 plus 5 on 6855", () => {
    const before = [line("6825", 30500), line("3300", -30500)];
    const after = [line("6825", 30000), line("6855", 500), line("3300", -30500)];
    expect(lineDiff(before, after)).toEqual({ removed: [line("6825", 30500)], added: [line("6825", 30000), line("6855", 500)] });
  });

  it("ignores generated tax lines and repeats", () => {
    const lines = [line("6600", 100), line("6600", 100), { ...line("1407", 19), taxRole: "tax" as const }];
    expect(lineDiff(lines, [line("6600", 100), line("6600", 100)])).toEqual({ removed: [], added: [] });
  });
});

describe("revisionSteps", () => {
  it("compares each snapshot with the next one, the newest with the entry now, newest first", () => {
    const snapshot = (lines: ReturnType<typeof line>[]) => ({
      bookingDate: "2026-09-12",
      documentDate: null,
      serviceDate: null,
      text: "Amtsgericht",
      status: "proposed" as const,
      origin: "ai" as const,
      dismissed: false,
      documentId: null,
      transactionId: null,
      lines,
    });
    const revisions: JournalEntryRevisionView[] = [
      { id: "r1", revision: 1, changeKind: "created", changedAt: "2026-09-14T10:02:00Z", changedByUserId: null, reason: null, snapshot: null },
      { id: "r2", revision: 2, changeKind: "edited", changedAt: "2026-09-14T10:05:00Z", changedByUserId: "u1", reason: null, snapshot: snapshot([line("6825", 30500), line("3300", -30500)]) },
    ];
    const steps = revisionSteps(revisions, [line("6825", 30000), line("6855", 500), line("3300", -30500)]);
    expect(steps.map((step) => step.revision.id)).toEqual(["r2", "r1"]);
    expect(steps[0]!.diff?.added).toEqual([line("6825", 30000), line("6855", 500)]);
    expect(steps[1]!.diff).toBeNull();
  });
});
