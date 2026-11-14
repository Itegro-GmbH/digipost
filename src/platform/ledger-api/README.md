# src/platform/ledger-api

Document type: reference
Lifecycle: active
Owner: src/platform/ledger-api
Scope: The HTTP client of the external ledger API (the `LedgerApiClient` port, its error, the
HTTP adapter) and the per-workspace switch `LEDGER_API_WORKSPACES`
Canonical responsibility: The only holder of `LEDGER_API_KEY`; the only code that talks to the
ledger API over HTTP
Maintenance triggers:
- The ledger API's HTTP contract (`POST /v1/<operation>`, its headers, its answer envelope) changes
- `LEDGER_API_URL`/`LEDGER_API_KEY`/`LEDGER_API_WORKSPACES` change (`src/platform/env/server/env.ts`)
- decisions/0081-ledger-via-api.md moves to stage B
Last verified: 2026-11-13, decisions/0081-ledger-via-api.md stage A (initial implementation),
against the ledger API repository's `apps/api/src/app.ts` and `packages/operations/src/*.ts`

## Purpose

Digipost's bookkeeping (`src/modules/ledger`) can run on the external ledger API
(https://ledger-api-rho.vercel.app, its own repository) instead of in-process, per workspace and
off by default (decisions/0081-ledger-via-api.md). This owner is the transport only: which
operation means what for Digipost lives in `src/persistence/use-cases/ledger-api-use-cases.ts`.

The contract: `POST /v1/<operation>` with a JSON body; `Authorization: Bearer <platform key>`,
`Ledger-Tenant: <tenant id>` (the Digipost workspace id), `Ledger-Actor: <who>`, and
`Idempotency-Key` on every operation that is not a read (`list_*`, `get_*`, `find_*`). The
answer is `{ ok: true, data }` or `{ ok: false, error: { code, details? } }`; the HTTP status
only mirrors the code (422 for a domain refusal, 5xx for the service).

## Files

- `core/ports.ts`: `LedgerApiClient.call(operation, input, { tenantId, actor, idempotencyKey,
  timeoutMs })`, returning the answer's `data`.
- `core/errors.ts`: `LedgerApiError` (the API's own code, or the client's `not_configured`,
  `timeout`, `network_error`, `invalid_response`, `invalid_operation`; the HTTP status;
  `retryable` for a timeout, a network failure, 429 and 5xx; `details`, never logged).
- `core/operations.ts`: which operation names are reads, and the snake_case name check.
- `core/workspaces.ts`: `parseLedgerApiWorkspaces` (comma-separated, trimmed, lowercased; empty
  means none).
- `server/http-client.ts`: the `fetch` adapter (30 s default timeout, a per-call override, a fresh
  `crypto.randomUUID()` idempotency key per write unless one is passed, no retries), and the
  "not configured" client.
- `server/get-ledger-api.ts`: `getLedgerApiClient()` (memoized; the "not configured" client
  while the URL or key is missing, so a switched workspace fails instead of silently falling
  back to the in-process ledger), `usesLedgerApi(workspaceId)`, `getLedgerApiWorkspaces()`.

## Public interfaces

- `index.ts` (neutral): the port and option types, `LedgerApiError`, `LEDGER_API_CLIENT_ERROR`,
  `isLedgerApiReadOperation`, `parseLedgerApiWorkspaces`.
- `server.ts`: `getLedgerApiClient`, `usesLedgerApi`, `getLedgerApiWorkspaces`,
  `createLedgerApiClient`, `createNotConfiguredLedgerApiClient`, and the test hook
  `resetLedgerApiClientForTests`. Bound only by the composition root
  (`src/persistence/composition/create-request-services.ts`).

## Rules

- `LEDGER_API_KEY` is a secret: read only here, never logged, never in an error message. A failed
  call logs `[ledger-api] call failed` with the operation, the tenant id, the code and the status;
  never a header, a request body or a response body (both may hold names, amounts, bank data).
- No retry inside the client. A write's idempotency key makes a retry by the caller safe (the
  next job attempt, a person clicking again); a retry of the same request must reuse its key.
- With `LEDGER_API_WORKSPACES` unset or empty, `usesLedgerApi` is `false` for every workspace,
  the client is never built and no request is ever made.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `LEDGER_API_URL` | only when a workspace is switched | The API's base URL, e.g. `https://ledger-api-rho.vercel.app` |
| `LEDGER_API_KEY` | only when a workspace is switched | Digipost's platform key of the API (secret store only) |
| `LEDGER_API_WORKSPACES` | no | Comma-separated workspace ids whose books run on the API; empty means none |

## Tests

`tests/http-client.test.ts` (headers, idempotency keys per write and none per read, the envelope,
every error path, nothing secret in a log line or an error) and `tests/workspaces.test.ts` (the
list's parsing, the switch off by default and on only for a listed workspace, read detection).
The use cases on top: `src/persistence/tests/ledger-api-use-cases.test.ts` and
`src/persistence/tests/ledger-api-source-push.test.ts`.
