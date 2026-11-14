import "server-only";

/**
 * Privileged entrypoint of `src/platform/ledger-api` (decisions/0081-ledger-via-api.md): the only
 * reader of `LEDGER_API_KEY`. Never imported from client-reachable code.
 */
export { getLedgerApiClient, getLedgerApiWorkspaces, resetLedgerApiClientForTests, usesLedgerApi } from "./server/get-ledger-api";
export { createLedgerApiClient, createNotConfiguredLedgerApiClient, DEFAULT_LEDGER_API_TIMEOUT_MS, type LedgerApiClientConfig } from "./server/http-client";
