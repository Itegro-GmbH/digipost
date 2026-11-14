// Owner: src/platform/ledger-api (decisions/0081-ledger-via-api.md). `LEDGER_API_WORKSPACES`:
// the workspaces whose bookkeeping runs on the ledger API. Comma-separated workspace ids,
// whitespace and case ignored; unset or empty means none. An entry that is not a workspace id
// simply never matches one (no error: a typo must not take the application down).

export function parseLedgerApiWorkspaces(raw: string | null | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}
