// The review queue's grouping (decisions/0080 UI concept A): certainty is shown by grouping, not
// by a score. "Sicher" is a template or rule proposal that balances and carries no warning; those
// are the only ones "Alle sicheren auswählen" selects. Everything else (the AI, a manual
// proposal, any warning, a difference still open) is "Bitte ansehen".
import type { JournalEntryListItem } from "../core/types";

export type QueueEntry = Pick<JournalEntryListItem, "origin" | "warnings" | "differenceCents">;

export function isSafeProposal(entry: QueueEntry): boolean {
  return (entry.origin === "template" || entry.origin === "rule") && entry.warnings.length === 0 && entry.differenceCents === 0;
}

export function groupQueue<T extends QueueEntry>(entries: readonly T[]): { safe: T[]; review: T[] } {
  return { safe: entries.filter(isSafeProposal), review: entries.filter((entry) => !isSafeProposal(entry)) };
}

/** One source without any proposal ("Probleme"): a bank transaction or a document, with the
 * link that opens the editor prefilled from it. */
export type QueueProblem = {
  kind: "transaction" | "document";
  id: string;
  date: string | null;
  title: string;
  /** Signed for a transaction (money in positive), the document's total otherwise. */
  amountCents: number | null;
  /** A proposal for it exists but was dismissed ("Verwerfen"). */
  dismissed: boolean;
};

/** The editor prefilled from a problem's source. */
export function problemHref(problem: Pick<QueueProblem, "kind" | "id">): string {
  return problem.kind === "transaction" ? `/dashboard/buchhaltung/buchung/neu?umsatz=${problem.id}` : `/dashboard/buchhaltung/buchung/neu?beleg=${problem.id}`;
}
