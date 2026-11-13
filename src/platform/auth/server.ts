import "server-only";

/**
 * Privileged entrypoint of `src/platform/auth` (WEBAPP_TEMPLATE_SPEC.md §6.2). Never
 * imported from client-reachable code; see `src/platform/auth/proxy-gate.ts` for the
 * one deliberately DB-free subpath the proxy uses instead.
 */
export { getAuth, MAGIC_LINK_EXPIRES_IN_SECONDS, resetAuthForTests } from "./server/auth";
export { getCurrentUser, requireUser, type CurrentUser } from "./server/session";
export { authRouteHandlers } from "./server/route-handlers";
// decisions/0078-mcp-server.md: the OAuth 2.1 authorization server of the remote MCP server.
export { MCP_RESOURCE_PATH, MCP_SCOPE, MCP_OAUTH_SCOPES, mcpResourceUrl } from "./server/oauth-config";
export { withMcpBearerAuth, type McpCaller } from "./server/mcp-bearer";
export {
  getOAuthClientDisplay,
  oauthAuthorizeResumePath,
  openIdConfigurationResponse,
  protectedResourceMetadataResponse,
  verifyOAuthQuery,
  type OAuthClientDisplay,
} from "./server/oauth-flow";
export {
  listConnectedAiClients,
  MCP_RATE_LIMIT_PER_CLIENT,
  MCP_RATE_LIMIT_PER_USER,
  MCP_RATE_LIMIT_WINDOW_SECONDS,
  revokeConnectedAiClient,
  type ConnectedAiClient,
} from "./server/oauth-grants";
