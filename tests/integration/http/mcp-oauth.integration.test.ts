// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1) of the remote MCP server and its
// OAuth 2.1 authorization server (decisions/0078-mcp-server.md), against real Postgres. Every
// HTTP endpoint is the real route handler, called in process: Better Auth's catch-all, the
// well-known discovery routes, `/oauth/login`, and `/api/mcp`. Mocked only:
// - `fetch` for exactly one URL, the JWKS the MCP route verifies tokens against (there is no
//   listening server in this test; it is answered by the same in-process auth handler);
// - the CIMD metadata transport (`@better-auth/cimd/node`), which refuses non-public hosts by
//   design - it serves one test client's metadata document;
// - `next/cache` (no Next request store here).
// Sessions are created the way the e2e helpers do it (a session row and a locally signed cookie),
// so no mail round trip is needed; `/oauth/login`'s hand-off to `/login` is checked on its own.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const CIMD_CLIENT_ID = "https://cimd-client.example/oauth/client.json";
const CIMD_REDIRECT_URI = "https://cimd-client.example/callback";
vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== CIMD_CLIENT_ID) return new Response(null, { status: 404 });
    return Response.json(
      {
        client_id: CIMD_CLIENT_ID,
        client_name: "CIMD Test Client",
        redirect_uris: [CIMD_REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      { headers: { "cache-control": "max-age=300" } },
    );
  },
}));

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleWorkspaceMemberRepository, createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { session, user } from "@/persistence/schema/auth";
import { authRouteHandlers, revokeConnectedAiClient, listConnectedAiClients } from "@/platform/auth/server";

import { POST as mcpPost } from "@/app/api/mcp/route";
import { GET as authorizationServerMetadata } from "@/app/.well-known/oauth-authorization-server/[[...path]]/route";
import { GET as protectedResourceMetadata } from "@/app/.well-known/oauth-protected-resource/[[...path]]/route";
import { GET as openIdConfiguration } from "@/app/.well-known/openid-configuration/[[...path]]/route";
import { GET as oauthLogin } from "@/app/(auth)/oauth/login/route";

const APP = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const MCP_URL = `${APP}/api/mcp`;
const ISSUER = `${APP}/api/auth`;
const REDIRECT_URI = "http://127.0.0.1:53682/callback";
const LEGACY_VERSION = "2025-11-25";

// --- The one network call the MCP route makes: its own JWKS, answered in process. -------------
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === `${ISSUER}/jwks`) return authRouteHandlers.GET(new Request(url, init));
  return realFetch(input, init);
});

// --- Fixtures ---------------------------------------------------------------------------------

type TestUser = { id: string; email: string; cookie: string };

function signedSessionCookie(token: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET must be set for this test");
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function createUserWithSession(label: string): Promise<TestUser> {
  const email = `${label}-${randomUUID()}@example.test`;
  const [row] = await getDb().insert(user).values({ name: label, email, emailVerified: true }).returning({ id: user.id });
  if (!row) throw new Error("user insert failed");
  const token = randomBytes(32).toString("hex");
  await getDb()
    .insert(session)
    .values({ token, userId: row.id, expiresAt: new Date(Date.now() + 86_400_000), updatedAt: new Date() });
  return { id: row.id, email, cookie: signedSessionCookie(token) };
}

async function createWorkspace(name: string, members: { userId: string; role: "admin" | "member" }[]) {
  const workspace = await createDrizzleWorkspaceRepository(getDb()).create({ name });
  for (const member of members) await createDrizzleWorkspaceMemberRepository(getDb()).create({ workspaceId: workspace.id, ...member });
  return workspace;
}

async function createDocument(workspaceId: string, fileName: string) {
  const id = randomUUID();
  await createDrizzleDocumentRepository(getDb()).create({
    id,
    workspaceId,
    uploadedByUserId: null,
    originalFileName: fileName,
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: 10,
    storageKey: `workspaces/${workspaceId}/documents/${id}/original.pdf`,
    fileHash: randomUUID(),
  });
  return id;
}

// --- OAuth client helpers ---------------------------------------------------------------------

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(clientId: string, challenge: string, redirectUri = REDIRECT_URI): string {
  const url = new URL(`${ISSUER}/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid offline_access digipost",
    state: randomBytes(8).toString("hex"),
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_URL,
  }))
    url.searchParams.set(key, value);
  return url.toString();
}

async function authGet(url: string, cookie?: string): Promise<Response> {
  return authRouteHandlers.GET(new Request(url, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } }));
}

/** Better Auth answers a redirect either as a 302 or (for fetch-mode requests) as `{ url }` JSON. */
async function redirectTarget(response: Response): Promise<string> {
  const location = response.headers.get("location");
  if (location) return location;
  const body = (await response.clone().json().catch(() => null)) as { url?: string } | null;
  if (body?.url) return body.url;
  throw new Error(`expected a redirect, got ${response.status}: ${await response.text()}`);
}

async function tokenRequest(params: Record<string, string>, origin?: string) {
  const response = await authRouteHandlers.POST(
    new Request(`${ISSUER}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...(origin ? { origin } : {}) },
      body: new URLSearchParams(params),
    }),
  );
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, string> };
}

async function registerClient(name: string): Promise<string> {
  const response = await authRouteHandlers.POST(
    new Request(`${ISSUER}/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  expect([200, 201]).toContain(response.status);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

/** authorize (signed in) -> consent -> code -> tokens, like an MCP client plus its user. A user
 * who already consented to this client is sent straight back with a code (no consent page). */
async function connect(person: TestUser, clientId: string): Promise<{ accessToken: string; refreshToken: string }> {
  const { verifier, challenge } = pkce();
  const authorizeLocation = new URL(await redirectTarget(await authGet(authorizeUrl(clientId, challenge), person.cookie)), APP);

  let callback = authorizeLocation;
  if (authorizeLocation.pathname === "/oauth/consent") {
    const consent = await authRouteHandlers.POST(
      new Request(`${ISSUER}/oauth2/consent`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", origin: APP, cookie: person.cookie },
        body: JSON.stringify({ accept: true, oauth_query: authorizeLocation.search.slice(1) }),
      }),
    );
    callback = new URL(await redirectTarget(consent));
  }
  expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
    resource: MCP_URL,
  });
  expect(tokens.status).toBe(200);
  return { accessToken: tokens.body.access_token!, refreshToken: tokens.body.refresh_token! };
}

async function mcp(accessToken: string | null, body: unknown) {
  const response = await mcpPost(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": LEGACY_VERSION,
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse((text.split("\n").find((l) => l.startsWith("data:")) ?? "data:{}").slice(5));
  return { response, json: json as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] }; error?: unknown } };
}

function callTool(accessToken: string, name: string, args: Record<string, unknown> = {}) {
  return mcp(accessToken, { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } });
}

function toolError(call: { response: Response; json: { result?: { isError?: boolean; content?: { text: string }[] }; error?: unknown } }): string | null {
  const result = call.json;
  if (!result.result) throw new Error(`no tool result (HTTP ${call.response.status}): ${JSON.stringify(result)}`);
  if (!result.result.isError) return null;
  return (JSON.parse(result.result.content?.[0]?.text ?? "{}") as { errorCode: string }).errorCode;
}

// --- The scenario -----------------------------------------------------------------------------

let admin: TestUser;
let member: TestUser;
let outsider: TestUser;
let workspaceA: { id: string };
let workspaceB: { id: string };
let documentA: string;
let documentB: string;
let dcrClientId: string;

beforeAll(async () => {
  admin = await createUserWithSession("mcp-admin");
  member = await createUserWithSession("mcp-member");
  outsider = await createUserWithSession("mcp-outsider");
  workspaceA = await createWorkspace("MCP Alpha GmbH", [
    { userId: admin.id, role: "admin" },
    { userId: member.id, role: "member" },
  ]);
  workspaceB = await createWorkspace("MCP Beta GmbH", [{ userId: outsider.id, role: "admin" }]);
  documentA = await createDocument(workspaceA.id, "alpha-rechnung.pdf");
  documentB = await createDocument(workspaceB.id, "beta-geheim.pdf");
  dcrClientId = await registerClient("Integration Test Client");
});

describe("MCP OAuth discovery", () => {
  it("challenges an unauthenticated MCP request with RFC 9728 resource metadata", async () => {
    const { response } = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${APP}/.well-known/oauth-protected-resource/api/mcp"`);
  });

  it("serves protected resource metadata naming our authorization server", async () => {
    const response = await protectedResourceMetadata(new Request(`${APP}/.well-known/oauth-protected-resource/api/mcp`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resource: string; authorization_servers: string[]; scopes_supported?: string[] };
    expect(body.resource).toBe(MCP_URL);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).toContain("digipost");
  });

  it("serves authorization server metadata (path insertion) with PKCE, DCR and CIMD", async () => {
    const response = await authorizationServerMetadata(new Request(`${APP}/.well-known/oauth-authorization-server/api/auth`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ISSUER);
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
    expect(body.client_id_metadata_document_supported).toBe(true);
  });

  it("serves OIDC discovery at the path-insertion URL and 404s any other path", async () => {
    const ok = await openIdConfiguration(new Request(`${APP}/.well-known/openid-configuration/api/auth`), {
      params: Promise.resolve({ path: ["api", "auth"] }),
    });
    expect(ok.status).toBe(200);
    const other = await openIdConfiguration(new Request(`${APP}/.well-known/openid-configuration/elsewhere`), {
      params: Promise.resolve({ path: ["elsewhere"] }),
    });
    expect(other.status).toBe(404);
  });
});

describe("MCP OAuth authorization", () => {
  it("sends a signed-out user through /oauth/login to the ordinary /login, resuming at authorize", async () => {
    const { challenge } = pkce();
    const loginLocation = await redirectTarget(await authGet(authorizeUrl(dcrClientId, challenge)));
    const loginPage = new URL(loginLocation, APP);
    expect(loginPage.pathname).toBe("/oauth/login");

    const handOff = await oauthLogin(new Request(loginPage.toString()));
    expect(handOff.status).toBe(303);
    const login = new URL(handOff.headers.get("location") ?? "", APP);
    expect(login.pathname).toBe("/login");
    const next = login.searchParams.get("next") ?? "";
    expect(next.startsWith("/api/auth/oauth2/authorize?")).toBe(true);
    expect(next).not.toContain("sig=");
    expect(next).toContain(`client_id=${encodeURIComponent(dcrClientId)}`);
  });

  it("asks a signed-in user for consent before the first connection, with a signed query", async () => {
    const { challenge } = pkce();
    const location = new URL(await redirectTarget(await authGet(authorizeUrl(dcrClientId, challenge), outsider.cookie)), APP);
    expect(location.pathname).toBe("/oauth/consent");
    expect(location.searchParams.get("sig")).toBeTruthy();
  });

  it("refuses a tampered authorize query on /oauth/login", async () => {
    const response = await oauthLogin(new Request(`${APP}/oauth/login?client_id=x&sig=forged&exp=9999999999`));
    expect(response.status).toBe(400);
  });

  it("never redirects to an unregistered redirect_uri", async () => {
    const { challenge } = pkce();
    const response = await authGet(authorizeUrl(dcrClientId, challenge, "https://evil.example/callback"), admin.cookie);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("https://evil.example")).toBe(false);
  });

  it("issues audience-bound tokens through DCR, consent and PKCE, and refreshes them", async () => {
    const { accessToken, refreshToken } = await connect(admin, dcrClientId);
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString()) as { aud: string | string[]; azp: string; scope: string };
    expect([claims.aud].flat()).toContain(MCP_URL);
    expect(claims.azp).toBe(dcrClientId);
    expect(claims.scope.split(" ")).toContain("digipost");

    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: dcrClientId, resource: MCP_URL });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(refreshToken);
    const call = await callTool(refreshed.body.access_token!, "list_workspaces");
    expect(call.response.status).toBe(200);
  });

  it("accepts a token request from a browser origin (CORS clients)", async () => {
    const { refreshToken } = await connect(admin, dcrClientId);
    const refreshed = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: refreshToken, client_id: dcrClientId, resource: MCP_URL },
      "https://inspector.example",
    );
    expect(refreshed.status).toBe(200);
  });

  it("resolves a Client ID Metadata Document client without registration", async () => {
    const { challenge } = pkce();
    const response = await authGet(authorizeUrl(CIMD_CLIENT_ID, challenge, CIMD_REDIRECT_URI), admin.cookie);
    const location = new URL(await redirectTarget(response), APP);
    expect(location.pathname).toBe("/oauth/consent");
    expect(location.searchParams.get("client_id")).toBe(CIMD_CLIENT_ID);
  });
});

describe("MCP tool calls with the user's own permissions", () => {
  let adminToken: string;
  let memberToken: string;

  beforeAll(async () => {
    adminToken = (await connect(admin, dcrClientId)).accessToken;
    memberToken = (await connect(member, dcrClientId)).accessToken;
  });

  it("lists exactly the caller's own workspaces", async () => {
    const { json } = await callTool(adminToken, "list_workspaces");
    const workspaces = json.result?.structuredContent?.workspaces as { id: string; role: string }[];
    expect(workspaces.map((w) => w.id)).toEqual([workspaceA.id]);
    expect(workspaces[0]?.role).toBe("admin");
  });

  it("searches only the resolved workspace's documents", async () => {
    const { json } = await callTool(adminToken, "search_documents", {});
    const ids = (json.result?.structuredContent?.items as { id: string }[]).map((item) => item.id);
    expect(ids).toContain(documentA);
    expect(ids).not.toContain(documentB);
  });

  it("answers not_found for another workspace's document and workspace_not_found for a foreign workspaceId", async () => {
    expect(toolError(await callTool(adminToken, "get_document", { documentId: documentB }))).toBe("not_found");
    expect(toolError(await callTool(adminToken, "get_document", { documentId: documentB, workspaceId: workspaceB.id }))).toBe("workspace_not_found");
    expect(toolError(await callTool(adminToken, "get_document", { documentId: documentA }))).toBeNull();
  });

  it("refuses finance tools to a member and allows them to the admin", async () => {
    expect(toolError(await callTool(memberToken, "list_accounts"))).toBe("forbidden");
    expect(toolError(await callTool(memberToken, "list_unmatched_transactions"))).toBe("forbidden");
    expect(toolError(await callTool(adminToken, "list_accounts"))).toBeNull();
  });

  it("writes through the dashboard's own Server Action, in the caller's workspace", async () => {
    const created = await callTool(memberToken, "create_contact", { name: "MCP Lieferant GmbH", city: "Berlin" });
    expect(toolError(created)).toBeNull();
    const contactId = created.json.result?.structuredContent?.id as string;

    const found = await callTool(adminToken, "search_contacts", { q: "MCP Lieferant" });
    expect((found.json.result?.structuredContent?.items as { id: string }[]).map((c) => c.id)).toContain(contactId);
  });

  it("records the last use of a connected client", async () => {
    const clients = await listConnectedAiClients(admin.id);
    const client = clients.find((c) => c.clientId === dcrClientId);
    expect(client?.name).toBe("Integration Test Client");
    expect(client?.lastUsedAt).not.toBeNull();
  });
});

describe("MCP revocation", () => {
  it("kills the access token on its next request and the refresh token at once", async () => {
    const person = await createUserWithSession("mcp-revoke");
    await createWorkspace("MCP Revoke GmbH", [{ userId: person.id, role: "admin" }]);
    const clientId = await registerClient("Revocation Client");
    const { accessToken, refreshToken } = await connect(person, clientId);
    expect((await callTool(accessToken, "list_workspaces")).response.status).toBe(200);

    await expect(revokeConnectedAiClient(person.id, clientId)).resolves.toBe(true);

    const after = await callTool(accessToken, "list_workspaces");
    expect(after.response.status).toBe(401);
    expect(after.response.headers.get("www-authenticate")).toContain("invalid_token");
    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: MCP_URL });
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
    expect(await listConnectedAiClients(person.id)).toEqual([]);
  });

  it("never lets one user revoke another user's grant", async () => {
    const victim = await createUserWithSession("mcp-victim");
    await createWorkspace("MCP Victim GmbH", [{ userId: victim.id, role: "member" }]);
    const clientId = await registerClient("Victim Client");
    const { accessToken } = await connect(victim, clientId);

    await expect(revokeConnectedAiClient(admin.id, clientId)).resolves.toBe(false);
    expect((await callTool(accessToken, "list_workspaces")).response.status).toBe(200);
  });
});
