// decisions/0078-mcp-server.md: the fixed shape of the OAuth 2.1 authorization server behind the
// remote MCP server. Plain constants only (no Better Auth import), so the MCP module, the
// consent page and tests can name the same values without building the auth instance.
import "server-only";

/** The MCP protected resource (RFC 9728), relative to `APP_URL`. */
export const MCP_RESOURCE_PATH = "/api/mcp";

/** The one product scope: everything the signed-in user may do in the dashboard, with the
 * user's own permissions (user decision 1: read and write in one scope). */
export const MCP_SCOPE = "digipost";

/** Every scope the authorization server knows. `offline_access` is what earns a refresh token. */
export const MCP_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access", MCP_SCOPE] as const;

/** Access tokens are JWTs and live 15 minutes; refresh tokens rotate (Better Auth default 30 days). */
export const MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 15 * 60;

/** Better Auth's `loginPage`: a route handler that hands off to the ordinary `/login`. */
export const OAUTH_LOGIN_PAGE = "/oauth/login";

/** Better Auth's `consentPage`. */
export const OAUTH_CONSENT_PAGE = "/oauth/consent";

/** The canonical MCP resource URL (RFC 8707 / RFC 9728), the audience of every access token. */
export function mcpResourceUrl(appUrl: string): string {
  return new URL(MCP_RESOURCE_PATH, appUrl).toString();
}

/** The refresh-token scope. Better Auth only issues a refresh token when the grant holds it. */
export const OFFLINE_ACCESS_SCOPE = "offline_access";

/** The parts of a registered OAuth client `withMcpOfflineAccess` looks at (`auth.oauthClient`). */
export type OfflineAccessClient = { disabled?: boolean | null; scopes?: readonly string[] | null; grantTypes?: readonly string[] | null };

/**
 * An authorize request for `digipost` without `offline_access`, with `offline_access` added
 * (decisions/0078-mcp-server.md, "Refresh tokens"), or `null` to leave the request as it is.
 *
 * Better Auth's protected resource metadata lists only resource scopes, so a client that takes
 * its scopes from there asks for `digipost` alone, gets no refresh token and loses its connection
 * when the 15-minute access token runs out. Added only with PKCE (Better Auth refuses
 * `offline_access` without it for a public client) and only for a registered client that may
 * hold the scope and use the refresh_token grant; anything else is left to Better Auth's own
 * checks unchanged.
 */
export function withMcpOfflineAccess<Q extends Record<string, unknown>>(query: Q, client: OfflineAccessClient | null, serverScopes: readonly string[]): Q | null {
  if (typeof query.scope !== "string" || typeof query.code_challenge !== "string" || query.code_challenge === "") return null;
  const scopes = query.scope.split(" ").filter(Boolean);
  if (!scopes.includes(MCP_SCOPE) || scopes.includes(OFFLINE_ACCESS_SCOPE)) return null;
  if (!client || client.disabled) return null;
  if (!(client.scopes ?? serverScopes).includes(OFFLINE_ACCESS_SCOPE)) return null;
  // Better Auth's `clientAllowsGrant`: no grant types means authorization_code, which implies
  // refresh_token.
  const grants = client.grantTypes?.length ? client.grantTypes : ["authorization_code"];
  if (!grants.includes("refresh_token") && !grants.includes("authorization_code")) return null;
  return { ...query, scope: [...scopes, OFFLINE_ACCESS_SCOPE].join(" ") };
}
