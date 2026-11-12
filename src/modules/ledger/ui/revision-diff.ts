// "Verlauf" (decisions/0080 UI): every revision keeps the entry as it was BEFORE that change, so
// what a change did is that snapshot against the next revision's snapshot (or the entry as it is
// now, for the newest one). Only base lines are compared: tax lines follow from them.
import type { JournalEntryRevisionView, TaxCode, TaxRole } from "../core/types";

export type DiffLine = { accountNumber: string; amountCents: number; taxCode: TaxCode | null; taxRole?: TaxRole | null };

const keyOf = (line: DiffLine) => `${line.accountNumber}|${line.amountCents}|${line.taxCode ?? ""}`;

/** Lines in `before` but not in `after` (removed) and the other way round (added), as multisets. */
export function lineDiff(before: readonly DiffLine[], after: readonly DiffLine[]): { removed: DiffLine[]; added: DiffLine[] } {
  const bases = (lines: readonly DiffLine[]) => lines.filter((line) => line.taxRole !== "tax");
  const remaining = new Map<string, number>();
  for (const line of bases(after)) remaining.set(keyOf(line), (remaining.get(keyOf(line)) ?? 0) + 1);
  const removed: DiffLine[] = [];
  for (const line of bases(before)) {
    const count = remaining.get(keyOf(line)) ?? 0;
    if (count > 0) remaining.set(keyOf(line), count - 1);
    else removed.push(line);
  }
  const unmatched = new Map<string, number>();
  for (const line of bases(before)) unmatched.set(keyOf(line), (unmatched.get(keyOf(line)) ?? 0) + 1);
  const added: DiffLine[] = [];
  for (const line of bases(after)) {
    const count = unmatched.get(keyOf(line)) ?? 0;
    if (count > 0) unmatched.set(keyOf(line), count - 1);
    else added.push(line);
  }
  return { removed, added };
}

export type RevisionStep = {
  revision: JournalEntryRevisionView;
  /** `null` for the creation (nothing before it). */
  diff: { removed: DiffLine[]; added: DiffLine[] } | null;
};

/** The revisions newest first, each with the line change it made. */
export function revisionSteps(revisions: readonly JournalEntryRevisionView[], currentLines: readonly DiffLine[]): RevisionStep[] {
  const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
  const steps = ordered.map((revision, index): RevisionStep => {
    const before = revision.snapshot?.lines ?? null;
    const after = ordered[index + 1]?.snapshot?.lines ?? currentLines;
    return { revision, diff: before ? lineDiff(before, after) : null };
  });
  return steps.reverse();
}
