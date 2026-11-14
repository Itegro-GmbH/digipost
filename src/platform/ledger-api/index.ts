/**
 * Neutral entrypoint of `src/platform/ledger-api` (decisions/0081-ledger-via-api.md): the
 * `LedgerApiClient` port, its error, and the pure helpers. No I/O, no `server-only`:
 * `src/persistence/use-cases/**` imports the port and the error from here.
 */
export { LEDGER_API_CLIENT_ERROR, LedgerApiError, type LedgerApiClientErrorCode, type LedgerApiErrorInfo } from "./core/errors";
export { isLedgerApiOperationName, isLedgerApiReadOperation } from "./core/operations";
export type { LedgerApiCallOptions, LedgerApiClient } from "./core/ports";
export { parseLedgerApiWorkspaces } from "./core/workspaces";
