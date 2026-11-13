// decisions/0078-mcp-server.md: the pieces of the OAuth authorization flow our own pages
// take part in - `/oauth/login` (Better Auth's `loginPage`), `/oauth/consent` (its
// `consentPage`), the OIDC discovery document at the path-insertion URL and the protected
// resource metadata.
import "server-only";

import { oauthProviderOpenIdConfigMetadata, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { headers } from "next/headers";

import { getAuth } from "./auth";
import { OFFLINE_ACCESS_SCOPE } from "./oauth-config";
import { authRouteHandlers } from "./route-handlers";

/** Signature-only parameters Better Auth adds to the authorize query it hands to our pages. */
const SIGNED_QUERY_ONLY_PARAMS = ["sig", "exp", "ba_iat", "ba_param", "ba_pl"] as const;

/**
 * Verifies the signed authorize query Better Auth appends when it redirects to `loginPage` or
 * `consentPage` (signature and expiry only: it proves the query came from our own authorize
 * endpoint unaltered, nothing about the client or the session).
 */
export async function verifyOAuthQuery(search: string): Promise<boolean> {
  const { secret } = await getAuth().$context;
  return verifyOAuthQueryParams(search.replace(/^\?/, ""), secret);
}

/**
 * The same-origin authorize URL that resumes the flow once the user is signed in: the
 * original authorize parameters minus the signature fields and minus `prompt=login` (already
 * satisfied by the fresh sign-in; keeping it would loop back to the login page forever).
 * Always a relative path on this origin, so `/login`'s own `safeNextPath` accepts it and it
 * can never become an open redirect.
 */
export function oauthAuthorizeResumePath(search: string): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  for (const name of SIGNED_QUERY_ONLY_PARAMS) params.delete(name);
  const prompt = (params.get("prompt") ?? "")
    .split(" ")
    .filter((p) => p && p !== "login");
  if (prompt.length > 0) params.set("prompt", prompt.join(" "));
  else params.delete("prompt");
  return `/api/auth/oauth2/authorize?${params.toString()}`;
}

/** What the consent page shows about the requesting client. Every field is the client's own,
 * unverified claim (a DCR client names itself), so the page also shows the client id. */
export type OAuthClientDisplay = { clientId: string; name: string | null; uri: string | null };

export async function getOAuthClientDisplay(clientId: string): Promise<OAuthClientDisplay> {
  const client = await getAuth()
    .api.getOAuthClientPublic({ query: { client_id: clientId }, headers: await headers() })
    .catch(() => null);
  return { clientId, name: client?.client_name ?? null, uri: client?.client_uri ?? null };
}

/**
 * OIDC discovery at the path-insertion URL (`/.well-known/openid-configuration/api/auth`), the
 * second discovery URL the MCP authorization spec has clients try. Better Auth itself only
 * answers the path-append form under `/api/auth`.
 */
export function openIdConfigurationResponse(request: Request): Promise<Response> {
  return oauthProviderOpenIdConfigMetadata(getAuth())(request);
}

/**
 * The MCP server's protected resource metadata (RFC 9728), served by Better Auth's `mcp()`
 * plugin, with `offline_access` added to `scopes_supported` (decisions/0078-mcp-server.md,
 * "Refresh tokens"). The plugin lists only resource scopes there, and an MCP client that picks
 * its scopes from this document then never asks for a refresh token and loses the connection
 * when the 15-minute access token runs out. Any other answer passes through unchanged.
 */
export async function protectedResourceMetadataResponse(request: Request): Promise<Response> {
  const response = await authRouteHandlers.GET(request);
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
  const metadata = (await response.json()) as { scopes_supported?: string[] };
  const scopes = metadata.scopes_supported ?? [];
  if (scopes.length === 0 || scopes.includes(OFFLINE_ACCESS_SCOPE)) return Response.json(metadata, { headers: response.headers });
  return Response.json({ ...metadata, scopes_supported: [...scopes, OFFLINE_ACCESS_SCOPE] }, { headers: response.headers });
}
