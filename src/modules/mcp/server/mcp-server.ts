// Owner: src/modules/mcp (decisions/0078-mcp-server.md). The MCP server itself: one fresh
// `McpServer` per HTTP request (stateless Streamable HTTP), every tool of `./tool-registry.ts`
// registered on it, and the fetch-shaped handler `src/app/api/mcp/route.ts` calls once the bearer
// token, the grant and the rate limit have been checked (`@/platform/auth/server`).
//
// Serves both protocol eras: 2026-07-28 per-request envelope traffic natively, and 2025-era
// clients (an `initialize` handshake) through the SDK's stateless fallback (`legacy:
// "stateless"`), each request answered by a fresh instance from the same factory. Nothing is
// kept between requests, so any serverless instance can answer any request.
import "server-only";

import { createMcpHandler, McpServer, type AuthInfo, type CallToolResult } from "@modelcontextprotocol/server";

import type { McpCaller } from "@/platform/auth/server";

import { ERROR_HINTS, type McpTool, type ToolOutcome } from "../core/tool-kit";

import { executeTool, type ToolArguments } from "./execute-tool";
import { mcpToolInputSchema, MCP_TOOLS } from "./tool-registry";

const SERVER_INFO = { name: "digipost", title: "Digipost", version: "1.0.0" } as const;

const INSTRUCTIONS = [
  "Digipost is a digital mailroom for German businesses: scanned and uploaded incoming mail, OCR'd, classified,",
  "matched against bank transactions and searchable. You act as the signed-in user, with exactly their permissions.",
  "A user may belong to several workspaces (companies): call list_workspaces, then pass workspaceId to act in a",
  "workspace other than the default one. Amounts are integer cents. Dates are ISO (YYYY-MM-DD).",
  "Finance tools (accounts, transactions, payment matching, closing check) are only available to workspace admins.",
  "Destructive tools cannot be undone: ask the user before calling them. The user's own data is shown in German.",
].join(" ");

/** `structuredContent` plus the same JSON as text, for clients that only read text content. */
function toCallToolResult(outcome: ToolOutcome): CallToolResult {
  if (outcome.ok) {
    return { content: [{ type: "text", text: JSON.stringify(outcome.data) }], structuredContent: outcome.data };
  }
  const error = { errorCode: outcome.errorCode, ...(ERROR_HINTS[outcome.errorCode] ? { hint: ERROR_HINTS[outcome.errorCode] } : {}), ...(outcome.details ?? {}) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(error) }] };
}

function annotationsOf(tool: McpTool) {
  return {
    title: tool.title,
    readOnlyHint: tool.effect === "read",
    destructiveHint: tool.effect === "destructive",
    idempotentHint: tool.idempotent ?? false,
    // Every tool acts on this workspace's own data only, never on an open world of entities.
    openWorldHint: false,
  };
}

/** Builds the per-request server for one authenticated caller. Exported for tests. */
export function buildMcpServer(caller: McpCaller): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: mcpToolInputSchema(tool), annotations: annotationsOf(tool) },
      async (args: Record<string, unknown>) => toCallToolResult(await executeTool(tool, args as ToolArguments, caller)),
    );
  }
  return server;
}

type CallerExtra = { caller: McpCaller };

function callerOf(authInfo: AuthInfo | undefined): McpCaller {
  const caller = (authInfo?.extra as CallerExtra | undefined)?.caller;
  // Unreachable: the route only calls `handleMcpRequest` after authentication. Throwing
  // (rather than serving an anonymous instance) keeps it that way if the wiring ever changes.
  if (!caller) throw new Error("MCP request reached the server without an authenticated caller");
  return caller;
}

const handler = createMcpHandler(({ authInfo }) => buildMcpServer(callerOf(authInfo)), {
  legacy: "stateless",
  responseMode: "json",
  onerror: (error) => console.error("[mcp] transport error", error.name, error.message),
});

/** Serves one authenticated MCP HTTP request. */
export function handleMcpRequest(request: Request, caller: McpCaller): Promise<Response> {
  const authInfo: AuthInfo = {
    // The raw token stays in the route; nothing below needs it.
    token: "",
    clientId: caller.clientId,
    scopes: caller.scopes,
    expiresAt: caller.expiresAt,
    extra: { caller } satisfies CallerExtra,
  };
  return handler.fetch(request, { authInfo });
}
