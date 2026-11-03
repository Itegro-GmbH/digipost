/**
 * `/oauth/login` - Better Auth's `loginPage` for the MCP server's OAuth flow
 * (decisions/0078-mcp-server.md). The authorize endpoint redirects a signed-out user here with
 * the signed authorize query. This hands off to the unchanged `/login` page with
 * `next=/api/auth/oauth2/authorize?<original params>`; the magic link's `callbackURL` then lands
 * the freshly signed-in user back on the authorize endpoint, which continues to the consent page.
 *
 * Nothing here opens a sign-up path: `/login` is the ordinary magic-link sign-in, and an address
 * without an account or an invitation still gets no link (decisions/0074-sign-up-by-invitation-only.md).
 * `next` is always a same-origin relative path (`oauthAuthorizeResumePath`), and `/login`'s own
 * `safeNextPath` checks it again, so this can never become an open redirect. A query whose
 * signature does not verify is refused outright.
 */
import { oauthAuthorizeResumePath, verifyOAuthQuery } from "@/platform/auth/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!(await verifyOAuthQuery(url.search))) {
    return new Response("Ungültige oder abgelaufene Anmeldeanfrage. Bitte starten Sie die Verbindung in Ihrer KI-Anwendung erneut.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  // A relative `Location` (RFC 9110): stays on whatever origin the browser is already on.
  const login = `/login?${new URLSearchParams({ next: oauthAuthorizeResumePath(url.search) }).toString()}`;
  return new Response(null, { status: 303, headers: { location: login } });
}
