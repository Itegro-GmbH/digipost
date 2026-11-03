// Owner: src/modules/mcp (decisions/0078-mcp-server.md). Read models of "KI-Verbindungen".
import "server-only";

import { listConnectedAiClients } from "@/platform/auth/server";

import type { AiClientView } from "../core/types";

/** Every AI client `userId` has connected, newest first - the user's own grants only. */
export async function listAiClientsProjection(userId: string): Promise<AiClientView[]> {
  const clients = await listConnectedAiClients(userId);
  return clients.map((client) => ({ clientId: client.clientId, name: client.name, connectedAt: client.connectedAt, lastUsedAt: client.lastUsedAt }));
}
