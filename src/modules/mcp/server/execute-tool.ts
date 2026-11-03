// Owner: src/modules/mcp (decisions/0078-mcp-server.md). Runs ONE tool call as the token's user.
//
// 1. The whole call runs inside `runAsDelegatedPrincipal`, so every access check inside it -
//    this file's own and every Server Action's `requirePermission` - resolves the token's user
//    and the workspace the call named, through `resolveAccess`, never a session cookie.
// 2. The workspace is resolved first: a `workspaceId` the user is not a member of ends the call
//    with `workspace_not_found` before anything else runs.
// 3. The tool's declared permission (the dashboard's own bundle for the same capability) is
//    checked against the caller's role in THAT workspace.
// 4. One audit line per call: tool, user, workspace, client, outcome, duration. Never the input
//    or the output (they carry document content and personal data).
import "server-only";

import { getWorkspaceAccess, runAsDelegatedPrincipal } from "@/platform/access/server";
import type { McpCaller } from "@/platform/auth/server";
import { captureError, logAuditEvent } from "@/platform/observability/server";

import { fail, MCP_ERROR, type McpTool, type ToolOutcome, type WorkspaceTool } from "../core/tool-kit";

/** What the caller passed, after the SDK validated it against the tool's schema. */
export type ToolArguments = Record<string, unknown> & { workspaceId?: string };

async function runWorkspaceTool(
  tool: WorkspaceTool,
  input: Record<string, unknown>,
  requestedWorkspaceId: string | undefined,
  caller: McpCaller,
  onResolved: (workspaceId: string) => void,
): Promise<ToolOutcome> {
  const access = await getWorkspaceAccess();
  if (access.status === "error") {
    if (access.errorCode === "no_workspace" && requestedWorkspaceId !== undefined) return fail(MCP_ERROR.workspaceNotFound);
    return fail(access.errorCode);
  }
  onResolved(access.access.workspace.id);
  if (!access.access.permissions.includes(tool.permission)) {
    return fail(MCP_ERROR.forbidden, { requiredPermission: tool.permission });
  }
  return tool.run(input, {
    userId: caller.user.id,
    clientId: caller.clientId,
    workspace: { id: access.access.workspace.id, name: access.access.workspace.name },
    role: access.access.role,
    permissions: access.access.permissions,
  });
}

export async function executeTool(tool: McpTool, args: ToolArguments, caller: McpCaller): Promise<ToolOutcome> {
  const startedAt = Date.now();
  const { workspaceId: requestedWorkspaceId, ...input } = args;
  let resolvedWorkspaceId: string | null = null;

  const principal = { user: caller.user, workspaceId: tool.scope === "workspace" ? requestedWorkspaceId : undefined, clientId: caller.clientId };
  const outcome = await runAsDelegatedPrincipal(principal, async (): Promise<ToolOutcome> => {
    try {
      if (tool.scope === "user") return await tool.run(input, { userId: caller.user.id, clientId: caller.clientId });
      return await runWorkspaceTool(tool, input, requestedWorkspaceId, caller, (id) => {
        resolvedWorkspaceId = id;
      });
    } catch (err) {
      captureError(err, { area: "mcp", tool: tool.name });
      console.error("[mcp] tool failed", { tool: tool.name, error: err instanceof Error ? err.name : "unknown" });
      return fail(MCP_ERROR.unknown);
    }
  });

  logAuditEvent("mcp.tool_call", {
    tool: tool.name,
    effect: tool.effect,
    userId: caller.user.id,
    clientId: caller.clientId,
    workspaceId: resolvedWorkspaceId,
    outcome: outcome.ok ? "ok" : "error",
    errorCode: outcome.ok ? null : outcome.errorCode,
    durationMs: Date.now() - startedAt,
  });

  return outcome;
}
