// The non-redirecting workspace access lookup (WEBAPP_TEMPLATE_SPEC.md §6.6). Server
// Actions and API routes need a result they can translate into an `ActionResult`/JSON
// error code, never a `redirect()` - a Server Action or route handler has no page to
// redirect from mid-request. `server/require-workspace-member.ts` (pages/layouts) and
// `server/workspace-access-step.ts` (the api-pipeline access step) both build on
// `resolveAccess` below so the membership lookup itself lives in exactly one place.
import "server-only";

import { getCurrentUser, type CurrentUser } from "@/platform/auth/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import type { MembershipWithWorkspace } from "@/persistence/use-cases/workspaces-use-cases";

import { permissionsForRole, type Permission, type Role } from "../core/permissions";

import { readActiveWorkspaceId } from "./active-workspace-cookie";
import { currentDelegatedPrincipal } from "./delegated-principal";

export type WorkspaceAccess = {
  user: CurrentUser;
  membershipId: string;
  role: Role;
  workspace: { id: string; name: string; tier: string };
  permissions: readonly Permission[];
};

export type WorkspaceAccessErrorCode = "unauthenticated" | "no_workspace" | "forbidden";

export type WorkspaceAccessResult =
  | { status: "ok"; access: WorkspaceAccess }
  | { status: "error"; errorCode: WorkspaceAccessErrorCode };

/**
 * How `resolveAccess` picks among the caller's memberships.
 *
 * - `{ source: "cookie" }` (the default): a browser request. The active-workspace cookie
 *   selects, the oldest membership is the fallback for a missing or foreign cookie
 *   (decisions/0070-several-workspaces-per-user.md).
 * - `{ source: "explicit", workspaceId }` (decisions/0078-mcp-server.md): a bearer-token
 *   caller (the MCP server) that names a workspace as a tool argument, or names none. No
 *   cookie is read. A named workspace must be one of the caller's memberships, otherwise the
 *   result is `null` - never a silent fallback to another workspace: an AI that asked for
 *   workspace B must not quietly act in workspace A. Naming none means the oldest membership,
 *   the same deterministic default the cookie path falls back to.
 */
export type ResolveAccessOptions = { source: "cookie" } | { source: "explicit"; workspaceId?: string };

function toAccess(user: CurrentUser, membership: MembershipWithWorkspace): WorkspaceAccess {
  return {
    user,
    membershipId: membership.membershipId,
    role: membership.role,
    workspace: { id: membership.workspace.id, name: membership.workspace.name, tier: membership.workspace.tier },
    permissions: permissionsForRole(membership.role),
  };
}

/**
 * The ONE place the caller's active workspace is decided
 * (decisions/0070-several-workspaces-per-user.md). `null` when `user` has no workspace
 * membership at all (or, for an explicit selection, not the named one); every other caller
 * (page guard, Server Action guard, api-pipeline access step, the MCP server) builds on this,
 * so the membership -> active workspace -> permissions mapping exists exactly once.
 *
 * The active-workspace cookie and an explicit `workspaceId` are client input and are treated
 * as such: they only select among the memberships this request just read from the database. A
 * cookie naming a workspace the user is not a member of (forged, stale after leaving, or simply
 * another tenant's id) falls through to the deterministic fallback - the caller's OLDEST
 * membership - and grants nothing; the response is indistinguishable from one where the cookie
 * named a workspace that does not exist at all. An explicit id that is not a membership yields
 * `null`, equally indistinguishable from a workspace that does not exist.
 */
export async function resolveAccess(user: CurrentUser, options: ResolveAccessOptions = { source: "cookie" }): Promise<WorkspaceAccess | null> {
  const memberships = await getRequestServices().workspaces.listMembershipsForUser(user.id);
  if (memberships.length === 0) return null;

  if (options.source === "explicit") {
    const selected = options.workspaceId === undefined ? memberships[0] : memberships.find((m) => m.workspace.id === options.workspaceId);
    return selected ? toAccess(user, selected) : null;
  }

  const requestedWorkspaceId = await readActiveWorkspaceId();
  const requested = requestedWorkspaceId
    ? memberships.find((m) => m.workspace.id === requestedWorkspaceId)
    : undefined;

  // `memberships[0]` is the oldest membership: `listMembershipsForUser` orders by
  // `joined_at` then `id`, a total order, so the fallback never flips between two requests.
  const active = requested ?? memberships[0];
  if (!active) return null;

  return toAccess(user, active);
}

/**
 * Resolves the caller's workspace membership without ever redirecting. Server Actions call
 * this (via `requirePermission`) and map `status: "error"` to their own `ActionResult` error
 * code; `server/require-workspace-member.ts` is the redirecting equivalent for pages/layouts.
 *
 * The caller is the signed-in session user, or - inside an MCP tool call
 * (`runAsDelegatedPrincipal`, decisions/0078-mcp-server.md) - the user the verified OAuth
 * access token belongs to. In that case no session cookie is consulted at all, and the
 * workspace is the one the tool call named (or the default), through `resolveAccess` as always.
 */
export async function getWorkspaceAccess(): Promise<WorkspaceAccessResult> {
  const delegated = currentDelegatedPrincipal();
  const user = delegated ? delegated.user : await getCurrentUser();
  if (!user) return { status: "error", errorCode: "unauthenticated" };

  const options: ResolveAccessOptions = delegated ? { source: "explicit", workspaceId: delegated.workspaceId } : { source: "cookie" };
  const access = await resolveAccess(user, options);
  if (!access) return { status: "error", errorCode: "no_workspace" };

  return { status: "ok", access };
}
