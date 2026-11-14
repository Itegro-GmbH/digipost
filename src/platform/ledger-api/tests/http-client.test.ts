// The ledger API's HTTP client against an injected `fetch` (no network in unit tests):
// headers, idempotency keys, the answer envelope, error mapping, and that neither the key nor a
// body ever reaches a log line.
import { describe, expect, it, vi } from "vitest";

import { LEDGER_API_CLIENT_ERROR, LedgerApiError } from "@/platform/ledger-api";
import { createLedgerApiClient, createNotConfiguredLedgerApiClient } from "@/platform/ledger-api/server";

const KEY = "lk_test_not_a_real_key_0123456789";
const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(respond: () => Response | Promise<Response>) {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => respond());
  const logger = { warn: vi.fn() };
  let next = 0;
  const client = createLedgerApiClient({
    baseUrl: "https://ledger.example.test/",
    apiKey: KEY,
    fetch: fetchMock as unknown as typeof fetch,
    generateIdempotencyKey: () => `generated-${++next}`,
    logger,
  });
  const request = (index = 0) => {
    const [url, init] = fetchMock.mock.calls[index]!;
    return { url, init, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as unknown };
  };
  return { client, fetchMock, logger, request };
}

async function caught(work: Promise<unknown>): Promise<LedgerApiError> {
  try {
    await work;
  } catch (err) {
    if (err instanceof LedgerApiError) return err;
    throw err;
  }
  throw new Error("expected a LedgerApiError");
}

describe("createLedgerApiClient", () => {
  it("posts the input to /v1/<operation> with the key, tenant and actor, and returns data", async () => {
    const { client, request } = setup(() => json({ ok: true, data: { entryId: "e-1" } }));

    const data = await client.call("create_entry", { entry: { text: "x" }, book: false }, { tenantId: TENANT, actor: USER });

    expect(data).toEqual({ entryId: "e-1" });
    const { url, init, headers, body } = request();
    expect(url).toBe("https://ledger.example.test/v1/create_entry");
    expect(init.method).toBe("POST");
    expect(headers).toMatchObject({ "content-type": "application/json", authorization: `Bearer ${KEY}`, "ledger-tenant": TENANT, "ledger-actor": USER });
    expect(body).toEqual({ entry: { text: "x" }, book: false });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("generates a fresh idempotency key for every write, keeps a given one, and sends none on a read", async () => {
    const { client, request } = setup(() => json({ ok: true, data: {} }));

    await client.call("book_entries", { entryIds: [] }, { tenantId: TENANT });
    await client.call("book_entries", { entryIds: [] }, { tenantId: TENANT });
    await client.call("dismiss_proposal", { entryId: "e" }, { tenantId: TENANT, idempotencyKey: "retry-key" });
    await client.call("list_entries", {}, { tenantId: TENANT });
    await client.call("get_overview", {}, { tenantId: TENANT });

    expect(request(0).headers["idempotency-key"]).toBe("generated-1");
    expect(request(1).headers["idempotency-key"]).toBe("generated-2");
    expect(request(2).headers["idempotency-key"]).toBe("retry-key");
    expect(request(3).headers).not.toHaveProperty("idempotency-key");
    expect(request(4).headers).not.toHaveProperty("idempotency-key");
  });

  it("sends no tenant or actor header when none is given (a platform operation)", async () => {
    const { client, request } = setup(() => json({ ok: true, data: {} }));
    await client.call("update_tenant", { id: TENANT });
    expect(request().headers).not.toHaveProperty("ledger-tenant");
    expect(request().headers).not.toHaveProperty("ledger-actor");
  });

  it("throws the API's own code with its status, details and whether it is worth retrying", async () => {
    const refused = setup(() => json({ ok: false, error: { code: "unbalanced", details: { differenceCents: 1 } } }, 422));
    const refusal = await caught(refused.client.call("book_entries", { entryIds: ["e"] }, { tenantId: TENANT }));
    expect(refusal.code).toBe("unbalanced");
    expect(refusal.info).toEqual({ operation: "book_entries", status: 422, retryable: false, details: { differenceCents: 1 } });

    const down = setup(() => json({ ok: false, error: { code: "unavailable" } }, 503));
    expect((await caught(down.client.call("list_rules", {}, { tenantId: TENANT }))).info.retryable).toBe(true);
  });

  it("maps a body that is not the envelope, a network failure and a timeout to the client's codes", async () => {
    const html = setup(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const invalid = await caught(html.client.call("list_rules", {}, { tenantId: TENANT }));
    expect(invalid.code).toBe(LEDGER_API_CLIENT_ERROR.invalidResponse);
    expect(invalid.info.retryable).toBe(true);

    const odd = setup(() => json({ hello: "world" }));
    expect((await caught(odd.client.call("list_rules", {}, { tenantId: TENANT }))).code).toBe(LEDGER_API_CLIENT_ERROR.invalidResponse);

    const offline = setup(() => Promise.reject(new TypeError("fetch failed")));
    expect((await caught(offline.client.call("list_rules", {}, { tenantId: TENANT }))).code).toBe(LEDGER_API_CLIENT_ERROR.network);

    const slow = setup(() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")));
    const timeout = await caught(slow.client.call("sync_proposals", {}, { tenantId: TENANT, timeoutMs: 5 }));
    expect(timeout.code).toBe(LEDGER_API_CLIENT_ERROR.timeout);
    expect(timeout.info.retryable).toBe(true);
  });

  it("refuses an operation name that is not snake_case without sending anything", async () => {
    const { client, fetchMock } = setup(() => json({ ok: true, data: {} }));
    expect((await caught(client.call("../admin", {}, { tenantId: TENANT }))).code).toBe(LEDGER_API_CLIENT_ERROR.invalidOperation);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never logs the key, a header or a body, and keeps the key out of the error", async () => {
    const { client, logger } = setup(() => json({ ok: false, error: { code: "invalid_input", details: { issues: [{ path: ["entry", "text"] }] } } }, 400));

    const err = await caught(client.call("create_entry", { entry: { text: "Miete Musterstraße 1" } }, { tenantId: TENANT, actor: USER }));

    expect(logger.warn).toHaveBeenCalledWith("[ledger-api] call failed", { operation: "create_entry", tenantId: TENANT, code: "invalid_input", status: 400 });
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("Musterstraße");
    expect(logged).not.toContain("issues");
    expect(logged).not.toContain(USER);
    expect(`${err.message} ${err.stack ?? ""}`).not.toContain(KEY);
  });
});

describe("createNotConfiguredLedgerApiClient", () => {
  it("fails every call with not_configured instead of falling back to anything", async () => {
    const err = await caught(createNotConfiguredLedgerApiClient().call("list_rules", {}, { tenantId: TENANT }));
    expect(err.code).toBe(LEDGER_API_CLIENT_ERROR.notConfigured);
  });
});
