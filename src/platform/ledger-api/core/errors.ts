// Owner: src/platform/ledger-api (decisions/0081-ledger-via-api.md). The one error every call of
// the ledger API throws: the API's own stable code (`unbalanced`, `locked`, `not_found`,
// `tenant_not_found`, `unauthenticated`, ...) or one of the client's codes below, never text.
// `details` is kept for a caller that branches on it and is never logged (it may echo input).

/** Codes the client itself produces, when no answer of the API carries one. */
export const LEDGER_API_CLIENT_ERROR = {
  /** `LEDGER_API_URL` or `LEDGER_API_KEY` is missing while a workspace is switched to the API. */
  notConfigured: "not_configured",
  timeout: "timeout",
  network: "network_error",
  /** The answer was not the `{ ok, data | error }` envelope. */
  invalidResponse: "invalid_response",
  /** An operation name that is not snake_case (a programming error, never sent). */
  invalidOperation: "invalid_operation",
} as const;
export type LedgerApiClientErrorCode = (typeof LEDGER_API_CLIENT_ERROR)[keyof typeof LEDGER_API_CLIENT_ERROR];

export type LedgerApiErrorInfo = {
  operation: string;
  /** The HTTP status, `null` when no answer arrived. */
  status: number | null;
  /** A timeout, a network failure, 429 or a 5xx: worth trying again later. */
  retryable: boolean;
  details?: Record<string, unknown>;
};

export class LedgerApiError extends Error {
  override readonly name = "LedgerApiError";

  constructor(
    readonly code: string,
    readonly info: LedgerApiErrorInfo,
  ) {
    super(`ledger api ${info.operation}: ${code}`);
  }
}
