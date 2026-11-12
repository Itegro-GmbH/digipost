// Which pages may use the wide content column. The shell's `<main>` is `max-w-3xl` (a reading
// width that suits forms and lists); the ledger's tables (journal, account sheets, the review
// queue with its Buchungssatz, the two-column editor) need more room
// (decisions/0080-ledger-double-entry-bookkeeping.md). A page opts out by its path prefix here,
// matched at a segment boundary the same way `activeNavHref` matches.
export const WIDE_LAYOUT_PREFIXES: readonly string[] = ["/dashboard/buchhaltung"];

export function usesWideLayout(pathname: string, prefixes: readonly string[] = WIDE_LAYOUT_PREFIXES): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
