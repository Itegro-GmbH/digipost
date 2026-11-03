// Owner: src/modules/mcp (decisions/0078-mcp-server.md). Every tool the MCP server offers, in one
// list. A dashboard capability that is NOT here is excluded on purpose (user decision 2:
// workspace deletion, billing tiers/packages, member management, E-Mail-Eingang settings;
// user decision 4: upload is v2; onboarding/invitation acceptance and the workspace switcher are
// browser flows, the latter replaced by `workspaceId`).
import "server-only";

import { workspaceIdArgument, type McpTool, type ToolInputSchema } from "../core/tool-kit";

import { CONTACT_TOOLS } from "./tools/contact-tools";
import { DOCUMENT_TOOLS } from "./tools/document-tools";
import { FINANCE_TOOLS } from "./tools/finance-tools";
import { WORKSPACE_TOOLS } from "./tools/workspace-tools";

export const MCP_TOOLS: readonly McpTool[] = [...WORKSPACE_TOOLS, ...DOCUMENT_TOOLS, ...CONTACT_TOOLS, ...FINANCE_TOOLS];

const names = new Set<string>();
for (const tool of MCP_TOOLS) {
  if (names.has(tool.name)) throw new Error(`duplicate MCP tool name: ${tool.name}`);
  names.add(tool.name);
}

/** The schema a client sees: a workspace tool's own input plus the optional `workspaceId`. */
export function mcpToolInputSchema(tool: McpTool): ToolInputSchema {
  return tool.scope === "workspace" ? tool.input.extend({ workspaceId: workspaceIdArgument }) : tool.input;
}

export function findMcpTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}
