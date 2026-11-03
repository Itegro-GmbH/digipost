// Narrow entry (WEBAPP_TEMPLATE_SPEC.md §5.1, src/persistence/README.md's "Entry seams"):
//
//   target   src/persistence/composition/auth-database.ts
//   owner    persistence
//   importer src/platform/auth/server/auth.ts, src/platform/auth/server/oauth-grants.ts
//   reason   Better Auth's Drizzle adapter needs the Drizzle instance and the raw
//            auth schema object directly for its own adapter; the rest of the
//            persistence graph (use cases, the Unit of Work) does not belong in
//            auth initialization (decisions/0005-better-auth-magic-link-drizzle-adapter.md).
//            The OAuth grant checks of the MCP server read and revoke `auth` tables the
//            same way (decisions/0078-mcp-server.md).
//
// The only file under src/persistence/ besides composition/request-services.ts,
// composition/create-request-services.ts and composition/public-services.ts that
// application code may import.
import "server-only";

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { getDb, type AppDb } from "@/persistence/foundation/client";
import * as authSchema from "@/persistence/schema/auth";
import { workspaceInvitations } from "@/persistence/schema/workspaces";

/**
 * The runtime connection (`app_runtime`, `DATABASE_URL`) - the same one every other
 * owner area uses. decisions/0004-three-database-roles.md already grants
 * `app_runtime` full DML on the `auth` schema (src/persistence/sql/grants/grants.sql),
 * so Better Auth's adapter does not need, and this template does not provision, a
 * fourth, auth-specific database role.
 */
export function getAuthDb(): AppDb {
  return getDb();
}

/**
 * The whole `src/persistence/schema/auth.ts` namespace (`user`, `session`, `account`,
 * `verification`, `rateLimit`, and the `authSchema` pgSchema itself) - exactly the
 * shape Better Auth's Drizzle adapter wants for its `schema` option:
 * `drizzleAdapter(getAuthDb(), { provider: "pg", schema: authSchema })`
 * (src/platform/auth/server/auth.ts). Re-exported under the same name; this module
 * never needs the individual table bindings itself.
 */
export { authSchema };

/** decisions/0074: what the sign-in gate needs to know about an e-mail address. */
export type SignInEligibility = { hasAccount: boolean; hasPendingInvitation: boolean };

/**
 * decisions/0074-sign-up-by-invitation-only.md: whether `email` already has an account, and
 * whether any workspace holds a pending, unexpired invitation for it. Both compared
 * case-insensitively. A read of `src/modules/workspaces`' own table, never a write (the
 * "read via a join" side of the owner rule); it lives here because `src/platform/auth` may only
 * import this seam.
 */
export async function findSignInEligibility(email: string, now: Date): Promise<SignInEligibility> {
  const db = getDb();
  const normalized = email.trim().toLowerCase();
  const [account] = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(sql`lower(${authSchema.user.email}) = ${normalized}`)
    .limit(1);
  const [invitation] = await db
    .select({ id: workspaceInvitations.id })
    .from(workspaceInvitations)
    .where(and(sql`lower(${workspaceInvitations.email}) = ${normalized}`, isNull(workspaceInvitations.acceptedAt), gt(workspaceInvitations.expiresAt, now)))
    .limit(1);
  return { hasAccount: account !== undefined, hasPendingInvitation: invitation !== undefined };
}

// ---------------------------------------------------------------------------------------
// decisions/0078-mcp-server.md: OAuth grants of the MCP server. Every function below reads or
// writes only `auth` tables (owner: src/platform/auth), and is imported only by
// `src/platform/auth/server/oauth-grants.ts` (STRUCTURE.md §4's narrow-entry importer list).
// ---------------------------------------------------------------------------------------

/** The bearer-token caller of `/api/mcp`, once its grant is confirmed to still exist. */
export type McpGrantUser = { id: string; email: string };

/**
 * `{ id, email }` of `userId`, but ONLY while that user still has a consent row for
 * `clientId`. JWT access tokens cannot be recalled once issued; checking the grant on every
 * MCP request (one indexed join) makes revoking a connection effective on the very next
 * call instead of when the token expires.
 */
export async function findMcpGrantUser(userId: string, clientId: string): Promise<McpGrantUser | null> {
  const [row] = await getDb()
    .select({ id: authSchema.user.id, email: authSchema.user.email })
    .from(authSchema.oauthConsent)
    .innerJoin(authSchema.user, eq(authSchema.user.id, authSchema.oauthConsent.userId))
    .where(and(eq(authSchema.oauthConsent.userId, userId), eq(authSchema.oauthConsent.clientId, clientId)))
    .limit(1);
  return row ?? null;
}

/** Request counts inside the current fixed window, AFTER counting this request. */
export type McpRequestCounts = { clientCount: number; userCount: number };

/**
 * Counts one MCP request for (user, client) and stamps `lastUsedAt`, in one atomic upsert:
 * a row whose window started more than `windowSeconds` ago restarts at 1. `userCount` sums
 * every client of the same user whose window is still open, so one person cannot multiply
 * their budget by registering more clients.
 */
export async function recordMcpRequest(userId: string, clientId: string, now: Date, windowSeconds: number): Promise<McpRequestCounts> {
  const db = getDb();
  const usage = authSchema.mcpClientUsage;
  const windowStart = new Date(now.getTime() - windowSeconds * 1000);
  const [row] = await db
    .insert(usage)
    .values({ userId, clientId, lastUsedAt: now, windowStartedAt: now, windowCount: 1 })
    .onConflictDoUpdate({
      target: [usage.userId, usage.clientId],
      set: {
        lastUsedAt: now,
        windowStartedAt: sql`case when ${usage.windowStartedAt} <= ${windowStart} then ${now} else ${usage.windowStartedAt} end`,
        windowCount: sql`case when ${usage.windowStartedAt} <= ${windowStart} then 1 else ${usage.windowCount} + 1 end`,
      },
    })
    .returning({ windowCount: usage.windowCount });
  const [total] = await db
    .select({ count: sql<number>`coalesce(sum(${usage.windowCount}), 0)::int` })
    .from(usage)
    .where(and(eq(usage.userId, userId), gt(usage.windowStartedAt, windowStart)));
  return { clientCount: row?.windowCount ?? 1, userCount: total?.count ?? 1 };
}

/** One connected AI client of one user, for "Verbundene KI-Anwendungen". */
export type OAuthGrantRow = {
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  scopes: string[];
  connectedAt: Date;
  lastUsedAt: Date | null;
};

/** Every client `userId` has consented to, newest first. One query, no N+1. */
export async function listOAuthGrants(userId: string): Promise<OAuthGrantRow[]> {
  const consent = authSchema.oauthConsent;
  const client = authSchema.oauthClient;
  const usage = authSchema.mcpClientUsage;
  return getDb()
    .select({
      clientId: consent.clientId,
      clientName: client.name,
      clientUri: client.uri,
      scopes: consent.scopes,
      connectedAt: consent.createdAt,
      lastUsedAt: usage.lastUsedAt,
    })
    .from(consent)
    .leftJoin(client, eq(client.clientId, consent.clientId))
    .leftJoin(usage, and(eq(usage.clientId, consent.clientId), eq(usage.userId, consent.userId)))
    .where(eq(consent.userId, userId))
    .orderBy(desc(consent.createdAt));
}

/**
 * Disconnects one client for one user, completely and at once: the consent row (which the
 * MCP route checks on every call, so an already issued access token stops working on its
 * next request), every refresh token (so no new access token can be minted), every stored
 * access token row, and the usage row. Better Auth's own `/oauth2/delete-consent` deletes
 * only the consent, which would leave a working refresh token behind. Returns whether there
 * was anything to revoke. Scoped by `userId`: one user can never revoke another's grant.
 */
export async function revokeOAuthGrant(userId: string, clientId: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const deleted = await tx
      .delete(authSchema.oauthConsent)
      .where(and(eq(authSchema.oauthConsent.userId, userId), eq(authSchema.oauthConsent.clientId, clientId)))
      .returning({ id: authSchema.oauthConsent.id });
    await tx
      .delete(authSchema.oauthAccessToken)
      .where(and(eq(authSchema.oauthAccessToken.userId, userId), eq(authSchema.oauthAccessToken.clientId, clientId)));
    await tx
      .delete(authSchema.oauthRefreshToken)
      .where(and(eq(authSchema.oauthRefreshToken.userId, userId), eq(authSchema.oauthRefreshToken.clientId, clientId)));
    await tx
      .delete(authSchema.mcpClientUsage)
      .where(and(eq(authSchema.mcpClientUsage.userId, userId), eq(authSchema.mcpClientUsage.clientId, clientId)));
    return deleted.length > 0;
  });
}
