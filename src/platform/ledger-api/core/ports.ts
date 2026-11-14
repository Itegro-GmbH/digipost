// Owner: src/platform/ledger-api (decisions/0081-ledger-via-api.md). The port the persistence
// layer calls the ledger API through: one typed call per operation (`POST /v1/<operation>`).

export type LedgerApiCallOptions = {
  /** `Ledger-Tenant`: the tenant, which is the Digipost workspace id. Omitted for a platform
   * operation (`update_tenant`, ...). */
  tenantId?: string | null;
  /** `Ledger-Actor`: who acted, recorded in the API's revisions (a Digipost user id, or
   * `digipost:<process>` for background work). */
  actor?: string | null;
  /** `Idempotency-Key` of a write. Pass the same key again only to retry the very same request;
   * omitted, a fresh one is generated for every write. Reads send none. */
  idempotencyKey?: string;
  /** Overrides the client's default timeout (a proposal sync takes longer than a read). */
  timeoutMs?: number;
};

export interface LedgerApiClient {
  /** Runs one operation and returns its `data`; throws `LedgerApiError` for anything else. */
  call<T = Record<string, unknown>>(operation: string, input: Record<string, unknown>, options?: LedgerApiCallOptions): Promise<T>;
}
