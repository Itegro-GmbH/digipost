// decisions/0078-mcp-server.md: the OAuth grants a user has given to AI clients - checked on
// every MCP request, counted for the rate limit, listed and revoked on "Verbundene
// KI-Anwendungen". The only file besides `./auth.ts` that may import the auth-database narrow
// entry (STRUCTURE.md §4), so every `auth`-table read/write of the MCP server goes through here.
import "server-only";

import {
  findMcpGrantUser,
  listOAuthGrants,
  recordMcpRequest,
  revokeOAuthGrant,
  type McpGrantUser,
  type McpRequestCounts,
  type OAuthGrantRow,
} from "@/persistence/composition/auth-database";

export type { McpGrantUser, McpRequestCounts };

/** Fixed rate-limit window for MCP requests. */
export const MCP_RATE_LIMIT_WINDOW_SECONDS = 60;
/** Requests per window for one (user, client) pair - generous for an AI that chains tool calls. */
export const MCP_RATE_LIMIT_PER_CLIENT = 120;
/** Requests per window for one user across all of their clients. */
export const MCP_RATE_LIMIT_PER_USER = 300;

/** `null` once the grant is gone (revoked, user deleted, client deleted). */
export function findLiveGrantUser(userId: string, clientId: string): Promise<McpGrantUser | null> {
  return findMcpGrantUser(userId, clientId);
}

export type McpRateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Counts this request and decides whether it is still within both limits. */
export async function checkMcpRateLimit(userId: string, clientId: string, now: Date = new Date()): Promise<McpRateLimitDecision> {
  const counts = await recordMcpRequest(userId, clientId, now, MCP_RATE_LIMIT_WINDOW_SECONDS);
  if (counts.clientCount > MCP_RATE_LIMIT_PER_CLIENT || counts.userCount > MCP_RATE_LIMIT_PER_USER) {
    return { allowed: false, retryAfterSeconds: MCP_RATE_LIMIT_WINDOW_SECONDS };
  }
  return { allowed: true };
}

/** One connected AI client, as the settings page shows it. */
export type ConnectedAiClient = {
  clientId: string;
  /** The name the client registered with; `null` when it gave none. */
  name: string | null;
  /** The client's own homepage as it registered it (display only, never fetched). */
  uri: string | null;
  scopes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
};

function toConnectedAiClient(row: OAuthGrantRow): ConnectedAiClient {
  return {
    clientId: row.clientId,
    name: row.clientName,
    uri: row.clientUri,
    scopes: row.scopes,
    connectedAt: row.connectedAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/** Every AI client `userId` has connected. Scoped to that user only. */
export async function listConnectedAiClients(userId: string): Promise<ConnectedAiClient[]> {
  return (await listOAuthGrants(userId)).map(toConnectedAiClient);
}

/** Revokes consent, refresh and access tokens of one client for one user, at once. */
export function revokeConnectedAiClient(userId: string, clientId: string): Promise<boolean> {
  return revokeOAuthGrant(userId, clientId);
}
