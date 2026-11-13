// Unit test (no DB): which MCP authorize requests get `offline_access` added
// (decisions/0078-mcp-server.md, "Refresh tokens").
import { describe, expect, it } from "vitest";

import { MCP_OAUTH_SCOPES, withMcpOfflineAccess } from "../server/oauth-config";

const QUERY = { client_id: "c1", scope: "digipost", code_challenge: "abc", code_challenge_method: "S256" };
const CLIENT = { disabled: false, scopes: [...MCP_OAUTH_SCOPES], grantTypes: ["authorization_code", "refresh_token"] };

describe("withMcpOfflineAccess", () => {
  it("adds offline_access to a PKCE request for digipost alone", () => {
    expect(withMcpOfflineAccess(QUERY, CLIENT, MCP_OAUTH_SCOPES)).toEqual({ ...QUERY, scope: "digipost offline_access" });
  });

  it("keeps the other requested scopes and treats no grant types as authorization_code", () => {
    const query = { ...QUERY, scope: "openid digipost" };
    expect(withMcpOfflineAccess(query, { scopes: null, grantTypes: null }, MCP_OAUTH_SCOPES)?.scope).toBe("openid digipost offline_access");
  });

  it("leaves requests alone that already ask for it, do not ask for digipost, or have no PKCE", () => {
    expect(withMcpOfflineAccess({ ...QUERY, scope: "digipost offline_access" }, CLIENT, MCP_OAUTH_SCOPES)).toBeNull();
    expect(withMcpOfflineAccess({ ...QUERY, scope: "openid profile" }, CLIENT, MCP_OAUTH_SCOPES)).toBeNull();
    expect(withMcpOfflineAccess({ ...QUERY, scope: undefined }, CLIENT, MCP_OAUTH_SCOPES)).toBeNull();
    expect(withMcpOfflineAccess({ ...QUERY, code_challenge: undefined }, CLIENT, MCP_OAUTH_SCOPES)).toBeNull();
  });

  it("leaves requests alone for unknown, disabled or restricted clients", () => {
    expect(withMcpOfflineAccess(QUERY, null, MCP_OAUTH_SCOPES)).toBeNull();
    expect(withMcpOfflineAccess(QUERY, { ...CLIENT, disabled: true }, MCP_OAUTH_SCOPES)).toBeNull();
    expect(withMcpOfflineAccess(QUERY, { ...CLIENT, scopes: ["digipost"] }, MCP_OAUTH_SCOPES)).toBeNull();
    expect(withMcpOfflineAccess(QUERY, { ...CLIENT, grantTypes: ["client_credentials"] }, MCP_OAUTH_SCOPES)).toBeNull();
  });
});
