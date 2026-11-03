// Owner: src/modules/mcp (decisions/0078-mcp-server.md). The shape every MCP tool is declared in,
// and the stable outcome codes a tool call can end with. Neutral: no I/O, no server-only import,
// so the unit tests can build tools against fakes.
import { z } from "zod";

import type { Permission } from "@/platform/access";

/** How a tool changes data - drives the MCP annotations an AI client shows its user. */
export const TOOL_EFFECTS = ["read", "write", "destructive"] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

/** Outcome codes the MCP layer itself produces, on top of each module's own action codes. */
export const MCP_ERROR = {
  /** No membership at all (or the token's user was never added to a workspace). */
  noWorkspace: "no_workspace",
  /** `workspaceId` names a workspace the caller is not a member of (or that does not exist -
   * indistinguishable on purpose). */
  workspaceNotFound: "workspace_not_found",
  /** The caller's role in that workspace lacks the permission the tool needs. */
  forbidden: "forbidden",
  /** The item does not exist in that workspace. */
  notFound: "not_found",
  /** Anything unexpected; details only in the server log. */
  unknown: "unknown",
} as const;

export type ToolOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; errorCode: string; details?: Record<string, unknown> };

/** The caller of one tool call, as the tools see it. `permissions` are the caller's resolved
 * permissions in `workspace`, read from the database for this very call. */
export type ToolContext = {
  userId: string;
  clientId: string;
  workspace: { id: string; name: string };
  role: string;
  permissions: readonly Permission[];
};

/** A tool's input schema: always a plain object, so `workspaceId` can be added uniformly. */
export type ToolInputSchema = z.ZodObject;

/** The caller of a tool that is about the user, not about one workspace (`list_workspaces`). */
export type UserToolContext = { userId: string; clientId: string };

type ToolBase<S extends ToolInputSchema> = {
  name: string;
  title: string;
  /** English, for the model: what it does, when to use it, what it returns, and for a
   * destructive tool that it cannot be undone. */
  description: string;
  input: S;
  effect: ToolEffect;
  /** Calling it twice with the same input leaves the same state (MCP `idempotentHint`). */
  idempotent?: boolean;
};

/** A tool that acts in one workspace: takes the optional `workspaceId` argument. */
export type WorkspaceTool<S extends ToolInputSchema = ToolInputSchema> = ToolBase<S> & {
  scope: "workspace";
  /**
   * The permission bundle the dashboard requires for the same capability
   * (`src/platform/access`). Checked before `run`, against the caller's role in the resolved
   * workspace; a write tool's Server Action checks it a second time itself.
   */
  permission: Permission;
  run(input: z.output<S>, ctx: ToolContext): Promise<ToolOutcome>;
};

/** A tool about the user across workspaces. */
export type UserTool<S extends ToolInputSchema = ToolInputSchema> = ToolBase<S> & {
  scope: "user";
  run(input: z.output<S>, ctx: UserToolContext): Promise<ToolOutcome>;
};

export type McpTool = WorkspaceTool | UserTool;

/** Identity helper that keeps `run`'s input typed by the schema. */
export function defineWorkspaceTool<S extends ToolInputSchema>(tool: Omit<WorkspaceTool<S>, "scope">): WorkspaceTool<S> {
  return { ...tool, scope: "workspace" };
}

export function defineUserTool<S extends ToolInputSchema>(tool: Omit<UserTool<S>, "scope">): UserTool<S> {
  return { ...tool, scope: "user" };
}

/** Every workspace-scoped tool takes this optional argument (user decision 7). */
export const workspaceIdArgument = z
  .uuid()
  .optional()
  .describe("Workspace to act in (from list_workspaces). Omit to use your default workspace.");

/** A successful outcome. Arrays are wrapped, MCP structured content must be an object. */
export function ok(data: Record<string, unknown>): ToolOutcome {
  return { ok: true, data };
}

export function fail(errorCode: string, details?: Record<string, unknown>): ToolOutcome {
  return details ? { ok: false, errorCode, details } : { ok: false, errorCode };
}

/** The `ActionResult` every Server Action returns (`@/shared/action-result`), as a tool outcome. */
export function fromActionResult(
  result: { status: "success"; data?: unknown } | { status: "error"; errorCode: string; problems?: unknown },
  successData: Record<string, unknown> = {},
): ToolOutcome {
  if (result.status === "error") {
    return "problems" in result && result.problems !== undefined ? fail(result.errorCode, { problems: result.problems }) : fail(result.errorCode);
  }
  const data = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {};
  return ok({ ...data, ...successData });
}

/** Short English explanations for the codes an AI client will meet most, so the model can
 * recover without guessing. Module-specific codes pass through unexplained but stable. */
export const ERROR_HINTS: Readonly<Record<string, string>> = {
  [MCP_ERROR.noWorkspace]: "You are not a member of any workspace yet.",
  [MCP_ERROR.workspaceNotFound]: "workspaceId is not one of your workspaces. Call list_workspaces for valid ids.",
  [MCP_ERROR.forbidden]: "Your role in this workspace does not allow this action.",
  [MCP_ERROR.notFound]: "Nothing with this id exists in this workspace.",
  [MCP_ERROR.unknown]: "An unexpected error occurred. Try again later.",
  invalid_input: "The input was rejected by validation. Check the tool's input schema.",
  unauthenticated: "The access token is no longer valid. Reconnect the Digipost connector.",
};
