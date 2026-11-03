"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

/**
 * The two buttons of `/oauth/consent` (decisions/0078-mcp-server.md). Posts the decision to
 * Better Auth's consent endpoint with `fetch` and then navigates with `window.location`: a plain
 * `<form>` POST answered with a redirect to the client's `redirect_uri` (https://claude.ai/...,
 * http://127.0.0.1:port, cursor://...) would be blocked by next.config.ts's CSP
 * `form-action 'self'`, which also governs redirects that follow a form submission.
 * `oauthQuery` is the signed authorize query Better Auth handed to the page; Better Auth verifies
 * its signature again on this request, and that the session belongs to the user it was issued for.
 */
export function ConsentForm({ oauthQuery }: { oauthQuery: string }) {
  const t = useTranslations("OAuthConsent");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function decide(accept: boolean) {
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ accept, oauth_query: oauthQuery }),
      });
      const body = (await response.json()) as { url?: string; uri?: string };
      const target = body.url ?? body.uri;
      if (!response.ok || !target) throw new Error(`consent failed: ${response.status}`);
      window.location.assign(target);
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button type="button" disabled={pending} onClick={() => decide(true)} data-testid="consent-accept">
          {t("accept")}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => decide(false)} data-testid="consent-deny">
          {t("deny")}
        </Button>
      </div>
      {failed ? <p className="text-sm text-destructive">{t("failed")}</p> : null}
    </div>
  );
}
