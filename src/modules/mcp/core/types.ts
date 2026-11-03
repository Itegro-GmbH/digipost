// Owner: src/modules/mcp (decisions/0078-mcp-server.md). View types shared by the server read
// models and the client components of this module.

/** One connected AI client on "KI-Verbindungen". Dates are ISO strings (serializable props). */
export type AiClientView = {
  clientId: string;
  name: string | null;
  connectedAt: string;
  lastUsedAt: string | null;
};
