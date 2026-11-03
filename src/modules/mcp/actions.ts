"use server";

// Owner: src/modules/mcp (decisions/0078-mcp-server.md). "Verbindung trennen" on
// `/dashboard/settings/ai-clients`.

import { revalidatePath } from "next/cache";

import { getCurrentUser, revokeConnectedAiClient } from "@/platform/auth/server";
import type { ActionResult } from "@/shared/action-result";

import { revokeAiClientInputSchema } from "./core/schemas";
import type { AiClientActionErrorCode } from "./core/error-codes";

/**
 * Disconnects one AI client from the signed-in user's account: consent, refresh tokens and
 * access tokens go at once, so the client's very next MCP request is refused and it cannot mint
 * a new token. A grant belongs to a person, not a workspace, so this needs a session and nothing
 * more - and it is scoped to the session's own user, one user can never revoke another's grant.
 * Revoking something that is already gone is a success (the end state is the same).
 */
export async function revokeAiClientAction(input: unknown): Promise<ActionResult<undefined, AiClientActionErrorCode>> {
  const parsed = revokeAiClientInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const user = await getCurrentUser();
  if (!user) return { status: "error", errorCode: "unauthenticated" };

  try {
    await revokeConnectedAiClient(user.id, parsed.data.clientId);
  } catch (err) {
    console.error("[mcp] revoking an AI client failed", err instanceof Error ? err.name : "unknown");
    return { status: "error", errorCode: "unknown" };
  }
  revalidatePath("/dashboard/settings/ai-clients");
  return { status: "success", data: undefined };
}
