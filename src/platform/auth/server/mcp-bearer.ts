// decisions/0078-mcp-server.md: bearer-token authentication for the MCP endpoint
// (`src/app/api/mcp/route.ts`).
//
// `requireMcpAuth` (@better-auth/mcp) verifies the JWT access token against our own JWKS
// (`/api/auth/jwks`, cached per instance for five minutes): signature, `iss` (Better Auth's
// base URL), `aud` (the MCP resource, RFC 8707), `exp`, a present `azp` (the client id) and the
// `digipost` scope. Anything else gets a 401 with
// `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/api/mcp"`
// (RFC 9728), which is how an MCP client discovers where to authorize.
//
// On top of the token itself, every request:
//   1. re-checks the grant: the user must still have a consent row for this client, so a
//      revoked connection is locked out on its very next call, not when the JWT expires;
//   2. counts against the per-(user, client) and per-user rate limit (`./oauth-grants.ts`).
import "server-only";

import { requireMcpAuth } from "@better-auth/mcp";

import { serverEnv } from "@/platform/env/server";

import { getAuth } from "./auth";
import { MCP_SCOPE, mcpResourceUrl } from "./oauth-config";
import { checkMcpRateLimit, findLiveGrantUser } from "./oauth-grants";
import type { CurrentUser } from "./session";

type JWTPayload = Parameters<Parameters<typeof requireMcpAuth>[1]>[1];

/** The authenticated caller of one MCP request. Never carries a workspace: which workspace a
 * tool acts in is decided per tool call by `src/platform/access`'s `resolveAccess`. */
export type McpCaller = {
  user: CurrentUser;
  /** The OAuth client (`azp`) - a DCR client id or a CIMD metadata URL. */
  clientId: string;
  scopes: string[];
  /** Seconds since the epoch. */
  expiresAt: number | undefined;
};

function resourceMetadataUrl(): string {
  return new URL("/.well-known/oauth-protected-resource/api/mcp", serverEnv().APP_URL).toString();
}

function jsonRpcError(status: number, message: string, headers: Record<string, string>): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status, headers });
}

function revokedResponse(): Response {
  return jsonRpcError(401, "invalid_token", {
    "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl()}", error="invalid_token", error_description="grant revoked"`,
  });
}

function rateLimitedResponse(retryAfterSeconds: number): Response {
  return jsonRpcError(429, "rate_limited", { "Retry-After": String(retryAfterSeconds) });
}

/**
 * Wraps the MCP route handler: verifies the bearer token, the live grant and the rate limit,
 * then calls `handler` with the resolved caller. `handler` never runs for an unauthenticated,
 * revoked or rate-limited request.
 */
export function withMcpBearerAuth(handler: (request: Request, caller: McpCaller) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) =>
    requireMcpAuth(
      getAuth(),
      async (req: Request, claims: JWTPayload) => {
        const userId = typeof claims.sub === "string" ? claims.sub : undefined;
        const clientId = typeof claims.azp === "string" ? claims.azp : undefined;
        if (!userId || !clientId) return revokedResponse();

        const user = await findLiveGrantUser(userId, clientId);
        if (!user) return revokedResponse();

        const rate = await checkMcpRateLimit(user.id, clientId);
        if (!rate.allowed) return rateLimitedResponse(rate.retryAfterSeconds);

        const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
        return handler(req, { user, clientId, scopes, expiresAt: claims.exp });
      },
      // `challengeScopes`: MCP clients take the scope to request from this challenge (or from
      // the protected resource metadata, where @better-auth/mcp filters `offline_access` out as
      // "authorization server only"). Without `offline_access` here a spec-following client
      // never asks for a refresh token and has to re-authorize every 15 minutes.
      { resource: mcpResourceUrl(serverEnv().APP_URL), requiredScopes: [MCP_SCOPE], challengeScopes: [MCP_SCOPE, "offline_access"] },
    )(request);
}
