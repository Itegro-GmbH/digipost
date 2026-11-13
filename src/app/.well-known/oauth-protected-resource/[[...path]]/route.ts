/**
 * `/.well-known/oauth-protected-resource[/<path>]` (RFC 9728) - the MCP server's protected
 * resource metadata (decisions/0078-mcp-server.md): which authorization server issues tokens for
 * `/api/mcp` and which scopes it takes. Served by Better Auth's `mcp()` plugin, forwarded here for
 * the same reason as the authorization-server metadata next to it, with `offline_access` added to
 * the scopes so a client asks for a refresh token ("Refresh tokens" in that ADR).
 */
import { protectedResourceMetadataResponse } from "@/platform/auth/server";

export const dynamic = "force-dynamic";

export const GET = protectedResourceMetadataResponse;
