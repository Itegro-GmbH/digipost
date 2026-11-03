// decisions/0078-mcp-server.md: the caller of a request that carries no session cookie but an
// OAuth bearer token the MCP route has already verified (`@/platform/auth/server`'s
// `withMcpBearerAuth`: signature, audience, scope, a live grant). An AI client acting for that
// user must go through exactly the same permission checks as the dashboard, so the MCP server
// runs each tool call inside `runAsDelegatedPrincipal(...)`, and `getWorkspaceAccess` (and with
// it `requirePermission`, every Server Action's guard) resolves THIS user instead of reading a
// session cookie.
//
// Nothing here decides a workspace. `workspaceId` is client input (a tool argument), handed to
// `resolveAccess`, which only ever selects among the memberships it just read from the database
// for this user - the one place the active workspace is decided stays the one place
// (decisions/0070-several-workspaces-per-user.md).
//
// `AsyncLocalStorage` scopes the principal to the async call chain of one tool call: it is
// invisible to any other request, and gone the moment the callback settles.
import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import type { CurrentUser } from "@/platform/auth/server";

export type DelegatedPrincipal = {
  user: CurrentUser;
  /** The workspace the caller asked for, or `undefined` for its default (oldest) membership. */
  workspaceId?: string;
  /** The OAuth client acting for the user - carried for audit logging only, never for authorization. */
  clientId: string;
};

const storage = new AsyncLocalStorage<DelegatedPrincipal>();

/** Runs `fn` with `principal` as the caller of every access check inside it. */
export function runAsDelegatedPrincipal<T>(principal: DelegatedPrincipal, fn: () => Promise<T>): Promise<T> {
  return storage.run(principal, fn);
}

/** The delegated principal of the current call chain, if any. */
export function currentDelegatedPrincipal(): DelegatedPrincipal | undefined {
  return storage.getStore();
}
