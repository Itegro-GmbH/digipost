import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { ConsentForm } from "@/modules/mcp/client";
import { getCurrentUser, getOAuthClientDisplay, verifyOAuthQuery } from "@/platform/auth/server";
import { listWorkspacesProjection } from "@/modules/workspaces/server";

// Reads the session and the signed authorize query on every request; never prerendered.
export const dynamic = "force-dynamic";

const KNOWN_SCOPES = new Set(["openid", "profile", "email", "offline_access", "digipost"]);

/**
 * `/oauth/consent` - Better Auth's `consentPage` for the MCP server (decisions/0078-mcp-server.md).
 * Reached through the authorize endpoint's redirect, which appends a signed copy of the
 * authorize query; a query whose signature does not verify (tampered, expired) gets an error
 * instead of buttons. Shows which client asks, for which account and which workspaces, and what
 * it will be able to do. The decision itself is posted by `ConsentForm`.
 */
export default async function OAuthConsentPage({ searchParams }: PageProps<"/oauth/consent">) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  const search = params.toString();

  const user = await getCurrentUser();
  if (!user) redirect(`/login?${new URLSearchParams({ next: `/oauth/consent?${search}` }).toString()}`);

  const t = await getTranslations("OAuthConsent");

  if (!(await verifyOAuthQuery(search))) {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <p className="max-w-md text-sm text-muted-foreground" data-testid="consent-invalid">
          {t("invalidRequest")}
        </p>
      </main>
    );
  }

  const client = await getOAuthClientDisplay(params.get("client_id") ?? "");
  const clientName = client.name ?? t("unnamedClient");
  const scopes = (params.get("scope") ?? "").split(" ").filter((scope) => KNOWN_SCOPES.has(scope));
  const workspaces = await listWorkspacesProjection(user.id);

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="flex w-full max-w-md flex-col gap-4" data-testid="consent-page">
        <h1 className="text-xl font-semibold text-foreground">{t("heading", { client: clientName })}</h1>
        <p className="text-sm text-muted-foreground">{t("signedInAs", { email: user.email })}</p>
        <div className="flex flex-col gap-1">
          <p className="text-sm text-foreground">{t("grantsIntro", { client: clientName })}</p>
          <ul className="list-disc pl-5 text-sm text-foreground">
            {scopes.map((scope) => (
              <li key={scope}>{t(`scopes.${scope}`)}</li>
            ))}
          </ul>
        </div>
        {workspaces.length > 0 ? (
          <p className="text-sm text-muted-foreground">{t("workspaces", { names: workspaces.map((w) => w.name).join(", ") })}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noWorkspace")}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("dataNotice", { client: clientName })}</p>
        <p className="break-all text-xs text-muted-foreground">{t("clientId", { id: client.clientId })}</p>
        <ConsentForm oauthQuery={search} />
        <p className="text-xs text-muted-foreground">{t("revokeHint")}</p>
      </div>
    </main>
  );
}
