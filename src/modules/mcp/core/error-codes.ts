// Owner: src/modules/mcp (decisions/0078-mcp-server.md). Stable error codes of this module's
// Server Actions; the UI translates them (`AiClients.errors.*` in de.json).
export const AI_CLIENT_ACTION_ERROR_CODES = ["invalid_input", "unauthenticated", "unknown"] as const;
export type AiClientActionErrorCode = (typeof AI_CLIENT_ACTION_ERROR_CODES)[number];
