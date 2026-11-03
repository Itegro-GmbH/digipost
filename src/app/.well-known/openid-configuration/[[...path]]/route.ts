/**
 * `/.well-known/openid-configuration/api/auth` - OIDC discovery with path insertion, the second
 * discovery URL the MCP authorization spec has clients try (decisions/0078-mcp-server.md). Better
 * Auth itself only answers the path-append form (`/api/auth/.well-known/openid-configuration`,
 * served by the catch-all), so this route builds the same document. Any other path is a 404.
 */
import { openIdConfigurationResponse } from "@/platform/auth/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/.well-known/openid-configuration/[[...path]]">): Promise<Response> {
  const { path } = await ctx.params;
  if ((path ?? []).join("/") !== "api/auth") return new Response(null, { status: 404 });
  return openIdConfigurationResponse(request);
}
