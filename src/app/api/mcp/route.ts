/**
 * `/api/mcp` - the remote MCP server (decisions/0078-mcp-server.md). Streamable HTTP, stateless.
 *
 * Every request is authenticated first by `withMcpBearerAuth` (`src/platform/auth`): a valid,
 * audience-bound OAuth access token with the `digipost` scope, a grant (consent) that still
 * exists, and the per-user/per-client rate limit. Only then does `handleMcpRequest`
 * (`src/modules/mcp`) serve it. An unauthenticated request gets the RFC 9728 401 challenge that
 * starts an MCP client's OAuth discovery.
 *
 * The workspace a tool acts in is decided per tool call by `src/platform/access`'s
 * `resolveAccess` among the token user's own memberships, never by anything in this route.
 *
 * Bypasses `src/platform/api-pipeline` deliberately (like `src/app/api/documents/[id]/file`):
 * the contract is JSON-RPC over the MCP transport, not the pipeline's `{ errorCode }` envelope.
 * CORS for browser-based MCP clients comes from next.config.ts (`Access-Control-Allow-Origin: *`,
 * never with credentials: the bearer token is the only credential this route accepts).
 */
import { withMcpBearerAuth } from "@/platform/auth/server";
import { handleMcpRequest } from "@/modules/mcp/server";

export const dynamic = "force-dynamic";

const handle = withMcpBearerAuth(handleMcpRequest);

export const POST = handle;
// 2025-era clients may open a GET SSE stream or DELETE a session; the stateless fallback answers
// 405 for both, but only after authentication, so discovery still starts from a 401.
export const GET = handle;
export const DELETE = handle;
