import { cn } from "@/shared/ui-primitives";

import { formatCents } from "./format";

/** One right-aligned, tabular amount cell. `null` renders an empty cell (no dash placeholder,
 * AGENTS.md "Code"). */
export function AmountCell({ cents, className, muted }: { cents: number | null; className?: string; muted?: boolean }) {
  return <td className={cn("px-3 py-2 text-right tabular-nums whitespace-nowrap", muted && "text-muted-foreground", className)}>{cents === null ? "" : formatCents(cents)}</td>;
}

/** A signed line amount split into its Soll (debit, positive) and Haben (credit, negative)
 * columns, the order DATEV uses. */
export function DebitCreditCells({ amountCents, muted }: { amountCents: number; muted?: boolean }) {
  return (
    <>
      <AmountCell cents={amountCents > 0 ? amountCents : null} muted={muted} />
      <AmountCell cents={amountCents < 0 ? -amountCents : null} muted={muted} />
    </>
  );
}
