import "server-only";

/**
 * Privileged entrypoint of src/modules/mcp (decisions/0078-mcp-server.md). `src/app/api/mcp/route.ts`
 * serves MCP requests through `handleMcpRequest` once `@/platform/auth/server`'s
 * `withMcpBearerAuth` has authenticated them; `/dashboard/settings/ai-clients` reads
 * `listAiClientsProjection`.
 */
export { handleMcpRequest } from "./server/mcp-server";
export { listAiClientsProjection } from "./server/read-models";
