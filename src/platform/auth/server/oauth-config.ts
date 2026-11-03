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
