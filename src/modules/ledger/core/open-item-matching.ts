// Matching open items (decisions/0080 phase 4, the automatic part): which booked lines of an
// open-item account settle each other. Pure; the use case reads the unmatched booked lines and
// writes the matches.
//
// - `findAutoMatches`: the only matches made without a human: every unmatched line of an
//   account that carries the same document (the invoice's line and its payment's lines, both
//   written by the proposal engine) when together they sum to exactly zero.
// - `suggestMatchGroups`: candidates for the UI, never applied by themselves: the same-document
//   groups, and combinations of opposite lines that add up to one line (Google Ads: charges of
//   10,00 + 50,00 + 36,57 against one invoice of 96,57; a platform payout against its report).
import type { MatchSuggestion } from "./types";

export type OpenItemLine = {
  lineId: string;
  accountId: string;
  amountCents: number;
  documentId: string | null;
  bookingDate: string;
};

export type AutoMatch = { accountId: string; documentId: string; lineIds: string[] };

/** Most lines one subset may combine, and how many candidates a subset is searched in. */
export const MAX_SUBSET_SIZE = 4;
export const MAX_SUBSET_CANDIDATES = 24;
export const MAX_SUGGESTIONS = 50;

function groupKey(lineIds: readonly string[]): string {
  return [...lineIds].sort().join(",");
}

/** Same account, same document, both signs, sum zero. */
export function findAutoMatches(lines: readonly OpenItemLine[]): AutoMatch[] {
  const groups = new Map<string, OpenItemLine[]>();
  for (const line of lines) {
    if (!line.documentId) continue;
    const key = `${line.accountId}|${line.documentId}`;
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
  }
  const matches: AutoMatch[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (!group.some((line) => line.amountCents > 0) || !group.some((line) => line.amountCents < 0)) continue;
    if (group.reduce((sum, line) => sum + line.amountCents, 0) !== 0) continue;
    matches.push({ accountId: group[0]!.accountId, documentId: group[0]!.documentId!, lineIds: group.map((line) => line.lineId).sort() });
  }
  return matches;
}

function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** A subset of `candidates` (at most `maxSize` lines) summing to `target`, or `null`. Depth
 * first in candidate order (closest dates first), so the first hit is the most plausible. */
function findSubset(candidates: readonly OpenItemLine[], target: number, maxSize: number): OpenItemLine[] | null {
  const chosen: OpenItemLine[] = [];
  const search = (start: number, remaining: number): boolean => {
    if (remaining === 0 && chosen.length > 0) return true;
    if (chosen.length === maxSize) return false;
    for (let index = start; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      // Every candidate has the target's sign: overshooting can never come back.
      if (Math.abs(candidate.amountCents) > Math.abs(remaining)) continue;
      chosen.push(candidate);
      if (search(index + 1, remaining - candidate.amountCents)) return true;
      chosen.pop();
    }
    return false;
  };
  return search(0, target) ? [...chosen] : null;
}

/**
 * Candidate groups over the unmatched lines of ONE account: first every same-document group
 * summing to zero, then, for each line not yet in a group (largest first), the closest-dated
 * combination of up to `MAX_SUBSET_SIZE` opposite lines that settles it exactly. A line is used
 * in at most one suggestion, so the suggestions can be applied together.
 */
export function suggestMatchGroups(lines: readonly OpenItemLine[], options: { maxSize?: number; maxCandidates?: number } = {}): MatchSuggestion[] {
  const maxSize = options.maxSize ?? MAX_SUBSET_SIZE;
  const maxCandidates = options.maxCandidates ?? MAX_SUBSET_CANDIDATES;
  const suggestions: MatchSuggestion[] = [];
  const used = new Set<string>();
  const seen = new Set<string>();

  const push = (reason: MatchSuggestion["reason"], group: readonly OpenItemLine[]) => {
    const lineIds = group.map((line) => line.lineId).sort();
    const key = groupKey(lineIds);
    if (seen.has(key)) return;
    seen.add(key);
    for (const id of lineIds) used.add(id);
    suggestions.push({ accountId: group[0]!.accountId, reason, lineIds, amountCents: group.reduce((sum, line) => (line.amountCents > 0 ? sum + line.amountCents : sum), 0) });
  };

  for (const match of findAutoMatches(lines)) {
    push(
      "same_document",
      lines.filter((line) => match.lineIds.includes(line.lineId)),
    );
  }

  const anchors = lines.filter((line) => !used.has(line.lineId)).sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents) || (a.lineId < b.lineId ? -1 : 1));
  for (const anchor of anchors) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    if (used.has(anchor.lineId)) continue;
    const candidates = lines
      .filter((line) => !used.has(line.lineId) && line.lineId !== anchor.lineId && line.accountId === anchor.accountId && Math.sign(line.amountCents) === -Math.sign(anchor.amountCents))
      .sort((a, b) => dayDistance(a.bookingDate, anchor.bookingDate) - dayDistance(b.bookingDate, anchor.bookingDate) || (a.lineId < b.lineId ? -1 : 1))
      .slice(0, maxCandidates);
    const subset = findSubset(candidates, -anchor.amountCents, maxSize);
    if (subset) push("subset_sum", [anchor, ...subset]);
  }
  return suggestions;
}
