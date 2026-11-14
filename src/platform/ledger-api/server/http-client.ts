// The HTTP adapter of the `LedgerApiClient` port (decisions/0081-ledger-via-api.md), plain
// `fetch`, no SDK. Contract of the ledger API (its `apps/api/src/app.ts`): `POST /v1/<operation>`
// with a JSON body; `Authorization: Bearer <platform key>`, `Ledger-Tenant`, `Ledger-Actor`, and
// `Idempotency-Key` on every write; the answer is `{ ok: true, data }` or
// `{ ok: false, error: { code, details? } }`, whatever the HTTP status.
//
// No retries here: a write carries its idempotency key, so the caller (a job's next attempt, a
// person clicking again) may retry safely. Logs name the operation, the tenant, the code and
// the status only: never the key, a header, a request or a response body.
import "server-only";

import { z } from "zod";

import { LEDGER_API_CLIENT_ERROR, LedgerApiError } from "../core/errors";
import { isLedgerApiOperationName, isLedgerApiReadOperation } from "../core/operations";
import type { LedgerApiCallOptions, LedgerApiClient } from "../core/ports";

/** A read or a booking answers in well under a second; a slow network should not hang a page. */
export const DEFAULT_LEDGER_API_TIMEOUT_MS = 30_000;

export type LedgerApiClientConfig = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  generateIdempotencyKey?: () => string;
  logger?: Pick<Console, "warn">;
};

const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().min(1), details: z.record(z.string(), z.unknown()).optional() }) }),
]);

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createLedgerApiClient(config: LedgerApiClientConfig): LedgerApiClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const fetchImpl = config.fetch ?? fetch;
  const generateKey = config.generateIdempotencyKey ?? (() => crypto.randomUUID());
  const logger = config.logger ?? console;

  function fail(operation: string, tenantId: string | null, code: string, status: number | null, retryable: boolean, details?: Record<string, unknown>): never {
    logger.warn("[ledger-api] call failed", { operation, tenantId, code, status });
    throw new LedgerApiError(code, { operation, status, retryable, ...(details ? { details } : {}) });
  }

  return {
    async call<T = Record<string, unknown>>(operation: string, input: Record<string, unknown>, options: LedgerApiCallOptions = {}): Promise<T> {
      const tenantId = options.tenantId ?? null;
      if (!isLedgerApiOperationName(operation)) fail(operation, tenantId, LEDGER_API_CLIENT_ERROR.invalidOperation, null, false);

      const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` };
      if (tenantId) headers["ledger-tenant"] = tenantId;
      if (options.actor) headers["ledger-actor"] = options.actor;
      if (!isLedgerApiReadOperation(operation)) headers["idempotency-key"] = options.idempotencyKey ?? generateKey();

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/${operation}`, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(options.timeoutMs ?? config.timeoutMs ?? DEFAULT_LEDGER_API_TIMEOUT_MS),
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        return fail(operation, tenantId, timedOut ? LEDGER_API_CLIENT_ERROR.timeout : LEDGER_API_CLIENT_ERROR.network, null, true);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return fail(operation, tenantId, LEDGER_API_CLIENT_ERROR.invalidResponse, response.status, isRetryableStatus(response.status));
      }
      const parsed = envelopeSchema.safeParse(body);
      if (!parsed.success) return fail(operation, tenantId, LEDGER_API_CLIENT_ERROR.invalidResponse, response.status, isRetryableStatus(response.status));
      if (parsed.data.ok) return parsed.data.data as T;
      return fail(operation, tenantId, parsed.data.error.code, response.status, isRetryableStatus(response.status), parsed.data.error.details);
    },
  };
}

/** Bound while a workspace is switched to the API but the URL or key is missing: every call
 * fails, so nothing silently falls back to the in-process ledger and diverges. */
export function createNotConfiguredLedgerApiClient(): LedgerApiClient {
  return {
    async call(operation) {
      throw new LedgerApiError(LEDGER_API_CLIENT_ERROR.notConfigured, { operation, status: null, retryable: false });
    },
  };
}
