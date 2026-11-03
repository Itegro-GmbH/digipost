// Owner: src/modules/mcp (decisions/0078-mcp-server.md). Server Action inputs of this module.
import { z } from "zod";

/** A client id is either an opaque DCR id or a CIMD metadata URL; 2048 covers any real URL. */
export const revokeAiClientInputSchema = z.object({ clientId: z.string().trim().min(1).max(2048) });
