// Unit test (no DB, no network): the MCP transport over the real SDK handler, in process. Proves
// every tool's input schema converts to JSON Schema (a transform-only Zod schema would not), the
// optional `workspaceId` is on every workspace tool, and annotations follow each tool's effect.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/persistence/composition/request-services", () => ({
  getRequestServices: () => ({ workspaces: { listMembershipsForUser: async () => [] } }),
}));
vi.mock("@/platform/auth/server", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/platform/observability/server", () => ({ logAuditEvent: vi.fn(), captureError: vi.fn() }));

import { handleMcpRequest } from "../server/mcp-server";

const CALLER = { user: { id: "u1", email: "u1@example.test" }, clientId: "client-1", scopes: ["digipost"], expiresAt: undefined };
const LEGACY_VERSION = "2025-11-25";

async function rpc(body: unknown, headers: Record<string, string> = {}) {
  const response = await handleMcpRequest(
    new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    }),
    CALLER,
  );
  const text = await response.text();
  const data = text.trim().startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice(5);
  return { status: response.status, json: JSON.parse(data) as { result?: Record<string, unknown>; error?: unknown } };
}

describe("the MCP server over the SDK transport", () => {
  it("answers a 2025-era initialize handshake", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(status).toBe(200);
    expect(json.result).toMatchObject({ serverInfo: { name: "digipost" } });
  });

  it("lists every tool with a JSON Schema, workspaceId and effect annotations", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": LEGACY_VERSION });
    const tools = (json.result?.tools ?? []) as {
      name: string;
      inputSchema: { type: string; properties?: Record<string, unknown> };
      annotations: { readOnlyHint: boolean; destructiveHint: boolean };
    }[];

    expect(tools.length).toBeGreaterThan(40);
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      if (tool.name !== "list_workspaces") expect(tool.inputSchema.properties, tool.name).toHaveProperty("workspaceId");
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("search_documents")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get("delete_document")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("returns a tool error (not a protocol error) for a user without a workspace", async () => {
    const { json } = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_documents", arguments: {} } },
      { "mcp-protocol-version": LEGACY_VERSION },
    );
    expect(json.result).toMatchObject({ isError: true });
    expect(JSON.stringify(json.result)).toContain("no_workspace");
  });
});
