"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { revokeAiClientAction } from "../actions";
import type { AiClientView } from "../core/types";

/**
 * `/dashboard/settings/ai-clients` ("KI-Verbindungen", decisions/0078-mcp-server.md): every AI
 * client the signed-in user has connected, with its name, when it was connected and last used,
 * and "Verbindung trennen". Revoking takes effect on the client's very next request.
 */
export function AiClientsList({ clients }: { clients: AiClientView[] }) {
  const t = useTranslations("AiClients");
  const router = useRouter();
  const [confirmingId, setConfirmingId] = useState<string>();
  const [pendingId, setPendingId] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();

  // A fixed time zone: the server (UTC) and the browser must render the same time, or React
  // reports a hydration mismatch. The product is DACH-only (decisions/0013).
  const dateFormatter = new Intl.DateTimeFormat("de", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

  function handleRevoke(clientId: string) {
    setPendingId(clientId);
    setFailed(false);
    startTransition(async () => {
      const result = await revokeAiClientAction({ clientId });
      setPendingId(undefined);
      setConfirmingId(undefined);
      if (result.status === "error") setFailed(true);
      router.refresh();
    });
  }

  if (clients.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="ai-clients-empty">
        {t("empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {failed ? <p className="text-sm text-destructive">{t("revokeFailed")}</p> : null}
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border" data-testid="ai-clients-list">
        {clients.map((client) => (
          <li key={client.clientId} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="ai-client-row">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-medium text-foreground">{client.name ?? t("unnamedClient")}</span>
              <span className="truncate text-xs text-muted-foreground">
                {t("connectedAt", { date: dateFormatter.format(new Date(client.connectedAt)) })}
                {" · "}
                {client.lastUsedAt ? t("lastUsedAt", { date: dateFormatter.format(new Date(client.lastUsedAt)) }) : t("neverUsed")}
              </span>
              <span className="truncate text-xs text-muted-foreground" title={client.clientId}>
                {t("clientId", { id: client.clientId })}
              </span>
            </div>
            {confirmingId === client.clientId ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("revokeConfirm")}</span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={pendingId === client.clientId}
                  aria-busy={pendingId === client.clientId}
                  onClick={() => handleRevoke(client.clientId)}
                  data-testid="ai-client-revoke-confirm"
                >
                  {pendingId === client.clientId ? t("revokePending") : t("revokeConfirmYes")}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingId(undefined)}>
                  {t("cancel")}
                </Button>
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingId(client.clientId)} data-testid="ai-client-revoke">
                {t("revoke")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
