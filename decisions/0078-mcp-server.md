# A remote MCP server, with Digipost as its own OAuth authorization server

Document type: decision
Lifecycle: active
Owner: src/modules/mcp (the MCP server, its tools, "KI-Verbindungen"), src/platform/auth (the
OAuth 2.1 authorization server, token verification, grants, rate limit), src/platform/access (the
delegated principal)
Scope: `/api/mcp`, the OAuth endpoints and discovery documents under `/api/auth/**` and
`/.well-known/**`, `/oauth/login`, `/oauth/consent`, `/dashboard/settings/ai-clients`, the `auth`
tables of the `jwt()`/`mcp()`/`cimd()` plugins and `auth."mcpClientUsage"` (migration 0025)
Canonical responsibility: Active source for how an AI client connects, what it may do, and how a
connection is revoked
Maintenance triggers:
- A dashboard capability is added or removed (decide whether it becomes a tool)
- A user decision listed under "Decision" changes
- better-auth, `@better-auth/*` or `@modelcontextprotocol/server` is upgraded
- The MCP authorization spec revision clients use changes
- The privacy policy or a sub-processor agreement changes
Last verified: 2026-11-03, initial version, against `src/modules/mcp/**`,
`src/platform/auth/server/{auth,oauth-config,mcp-bearer,oauth-flow,oauth-grants}.ts`,
`src/platform/access/server/{delegated-principal,get-workspace-access}.ts`,
`src/persistence/schema/auth.ts`, migration `0025_sudden_sheva_callister.sql`, and the tests named
under "Verification"

## Status

Accepted. Builds on decisions/0005-better-auth-magic-link-drizzle-adapter.md (Better Auth, magic
link), decisions/0014-workspaces-and-access.md (permission bundles),
decisions/0070-several-workspaces-per-user.md (`resolveAccess` is the one place the active
workspace is decided) and decisions/0074-sign-up-by-invitation-only.md (no open sign-up).

## Context

Users want to work with their mail, contacts and payments from an AI assistant (Claude, ChatGPT,
Cursor, ...) instead of only in the dashboard. The Model Context Protocol (MCP) is the common
interface those clients speak; its authorization part is OAuth 2.1 with discovery (RFC 9728
protected resource metadata, RFC 8414 authorization server metadata), PKCE, resource indicators
(RFC 8707), and client registration either dynamically (RFC 7591) or by a Client ID Metadata
Document (CIMD). A throwaway spike (branch `spike/mcp-oauth`) proved Better Auth's `mcp()`,
`jwt()` and `cimd()` plugins plus the MCP TypeScript SDK's `createMcpHandler` carry the whole flow
against the real `/login`, with real clients.

User decisions for v1:

1. Write access by default: one product scope (`digipost`) covers read and write.
2. Excluded: workspace deletion, billing tiers/packages, member management, E-Mail-Eingang
   settings.
3. Members may use it; every tool enforces exactly the dashboard's permission bundles. A member
   never sees finance data the dashboard redacts.
4. Upload is v2. Reading documents (metadata, OCR text, a short-lived download link) is in.
5. Open to every standards-compliant client: DCR and CIMD, no allowlist.
6. Available to all users.
7. The AI may switch workspaces: `list_workspaces`, and an optional `workspaceId` on every
   workspace tool, resolved only among the token user's own memberships.

## Decision

**Authorization server inside the existing Better Auth instance** (`src/platform/auth`):
`jwt()` (signing keys, `/api/auth/jwks`), `mcp({ resource: <APP_URL>/api/mcp, loginPage:
"/oauth/login", consentPage: "/oauth/consent", scopes: [openid, profile, email, offline_access,
digipost], accessTokenExpiresIn: 900, allowDynamicClientRegistration,
allowUnauthenticatedClientRegistration, clientRegistrationDefaultApplicationType: "infer" })`
and `cimd({ metadataProfile: "mcp-2026-07-28" })` with Better Auth's own SSRF-safe Node transport.
Access tokens are 15-minute JWTs bound to the MCP resource; refresh tokens rotate. The jwt
plugin's own session-JWT endpoint (`/token`) is disabled. Discovery is served at the root
well-known paths (path insertion) by forwarding to the same handler, plus OIDC discovery at
`/.well-known/openid-configuration/api/auth`.

**Sign-in is the ordinary sign-in.** `/oauth/login` verifies the signed authorize query and hands
off to `/login?next=/api/auth/oauth2/authorize?...` (a same-origin relative path, minus the
signature fields and `prompt=login`); the magic link lands the user back on authorize. No new
sign-up path exists: an address without an account or invitation still gets no link
(decisions/0074). `/oauth/consent` names the client (its own, unverified claim, so the client id
is shown too), the account, the workspaces, and what the client may do; it posts the decision with
`fetch` and navigates with `window.location`, because the CSP's `form-action 'self'` also governs
the redirect after a form submission.

**Every MCP request is authenticated three ways** (`withMcpBearerAuth`): the JWT (signature,
issuer, audience, expiry, `azp`, `digipost` scope, via `requireMcpAuth`), a consent row that still
exists for (user, client) - JWTs cannot be recalled, so this per-request check is what makes
revocation immediate - and a rate limit. The unauthenticated challenge advertises
`digipost offline_access`, so spec-following clients ask for a refresh token.

**Revocation is complete and immediate.** "Verbindung trennen" (`revokeOAuthGrant`) deletes, in
one transaction, the consent, every refresh token, every stored access token and the usage row
of that client for that user. Better Auth's own `delete-consent` would leave a working refresh
token behind, so the settings page never uses it.

**Rate limits.** Better Auth's per-IP limits stay on its endpoints, with registration tightened to
20 per hour per IP. The MCP route adds a fixed 60-second window per (user, client) of 120 requests
and per user across clients of 300, counted in `auth."mcpClientUsage"` by one atomic upsert per
request, which also records the last use shown on the settings page.

**CORS** for browser-based clients on exactly the cookie-free endpoints (`/api/mcp`, the
well-known documents, JWKS, token, register, revoke, userinfo): `Access-Control-Allow-Origin: *`,
never with credentials (next.config.ts). Authorize and consent (session cookie) get none.

**Tools run as the user, through the dashboard's own code.** `src/platform/access` gains a
delegated principal (`runAsDelegatedPrincipal`, an `AsyncLocalStorage` scoped to one tool call):
inside it, `getWorkspaceAccess` - and so every Server Action's `requirePermission` - resolves the
token's user instead of a session cookie. `resolveAccess` gains an explicit selection mode: the
tool's `workspaceId` selects among the memberships read from the database for this call, an id
that is not a membership yields nothing (no silent fallback to another workspace, unlike the
cookie), and no `workspaceId` means the oldest membership. `resolveAccess` stays the only place
the workspace is decided. Each tool also declares the dashboard's permission for the same
capability, checked before it runs. Reads call the owning module's read models; writes call the
owning module's existing Server Action, so validation, error codes, side effects and the owner's
table writes are unchanged code. Finance redaction is the dashboard's: the payment read model
receives the caller's own `finance.read`.

**Efficient reads.** A lean document list (`DocumentRepository.listSummaries`, the inbox's filter
and order in one query with only list columns) and a contact list without the existing per-row
detail lookup; OCR text only on request and paged; the intake proposal only on request and
bounded; caller-chosen page sizes with upper bounds.

**Transport.** `createMcpHandler` with a fresh `McpServer` per request, `legacy: "stateless"`
(2026-07-28 envelope traffic natively, 2025-era `initialize` clients through the SDK's stateless
fallback), `responseMode: "json"`. Nothing is kept between requests.

**Audit.** One structured line per tool call (`logAuditEvent("mcp.tool_call")`,
`src/platform/observability`): tool, effect, user id, client id, workspace id, outcome, error
code, duration. Never arguments or results.

**Tables.** The Better Auth plugin tables (`jwks`, `oauthClient`, `oauthResource`,
`oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`,
`oauthClientAssertion`) and our `mcpClientUsage`, all in the `auth` schema, owned by
`src/platform/auth`, migration 0025 via `pnpm db:generate`. User-owned rows cascade from
`auth.user.id`, client-owned rows from `oauthClient.clientId`. None is workspace-owned, so
decisions/0027's workspace cascade list is unaffected; deleting a workspace leaves a user's grant
in place, and the next tool call simply no longer resolves that workspace.

## Consequences

- An AI client can do what its user can do in the dashboard, minus the exclusions, with the same
  checks; there is no second authorization model to keep in sync. A new Server Action is not
  exposed automatically: it needs a tool and a row in the permission test.
- Excluded, besides user decision 2: upload (v2), the Abschluss ZIP export (a large binary for the
  tax advisor, dashboard only), onboarding, invitation acceptance, leaving a workspace, and the
  workspace switcher (replaced by `workspaceId`). There is no document rename to expose: names
  are generated (decisions/0059).
- The download link is a presigned object-storage URL valid five minutes; whoever holds it can
  fetch the file in that time. It only works where the storage endpoint is reachable from the
  client (true for a public S3-compatible endpoint, not for an internal one).
- The MCP route fetches its own JWKS over HTTP (`<APP_URL>/api/auth/jwks`, cached five minutes
  per instance): the app must reach its own public URL.
- Unauthenticated registration lets anyone create client rows (rate limited per IP); unused
  clients are never cleaned up yet.
- **Data protection.** Like the Mistral pipeline and the Resend receiver, data a user lets an AI
  client read leaves Digipost for that client's provider. Here it is the user's own, explicit
  choice (consent screen, revocable at any time), and Digipost has no contract with those
  providers - the user's organisation does. The privacy policy (still a placeholder) must say
  that users can connect third-party AI applications and that data they retrieve is then
  processed by those providers under the user's own responsibility. The consent page and the
  settings page say so in plain German.

## Verification

- `src/modules/mcp/tests/tool-permissions.test.ts` (unit): the permission of every tool against
  an explicit table, the exclusions, member vs admin, a foreign `workspaceId`, a write through the
  real Server Action in the named workspace, the audit line, `get_document`'s redaction and
  paged OCR text.
- `src/modules/mcp/tests/mcp-server.test.ts` (unit): the real SDK transport in process.
- `src/platform/access/tests/get-workspace-access.test.ts` (unit): the delegated principal never
  reads the session or the cookie, selects the named membership with its own role, refuses a
  foreign workspace, and does not leak outside its call.
- `tests/integration/http/mcp-oauth.integration.test.ts` (real Postgres): 401 challenge, PRM, AS
  metadata, OIDC discovery, signed-out hand-off to `/login`, consent, PKCE, DCR, CIMD, refresh,
  CORS-origin token request, unregistered redirect URI, tool calls scoped to the caller's own
  workspace and role, a write, last use, and revocation killing access and refresh tokens.
- `tests/e2e/mcp-connect.spec.ts` (`@smoke`): consent page and "KI-Verbindungen" in a browser.
