/**
 * `/.well-known/oauth-authorization-server[/<path>]` (RFC 8414, path insertion) for the MCP
 * server's OAuth flow (decisions/0078-mcp-server.md). Better Auth's `mcp()` plugin answers these
 * paths in its own `onRequest` hook, but only for requests that reach its handler - the
 * `/api/auth/[...all]` catch-all does not cover the root-level well-known paths, so they are
 * forwarded here. An unknown sub-path falls through to Better Auth's own 404.
 */
import { authRouteHandlers } from "@/platform/auth/server";

export const dynamic = "force-dynamic";

export const GET = authRouteHandlers.GET;
