import { getTranslations } from "next-intl/server";

import { AiClientsList, CopyMcpUrl } from "@/modules/mcp/client";
import { listAiClientsProjection } from "@/modules/mcp/server";
import { requireWorkspaceMember } from "@/platform/access/server";
import { MCP_RESOURCE_PATH } from "@/platform/auth/server";
import { serverEnv } from "@/platform/env/server";

/**
 * "KI-Verbindungen" (decisions/0078-mcp-server.md): how to connect an AI client to Digipost
 * (the MCP server URL), and every AI client the signed-in user has connected, each with
 * "Verbindung trennen". Every user sees this page (user decision 6): a connection is the user's
 * own and acts with the user's own permissions, so it is not an admin setting.
 */
export default async function AiClientsSettingsPage() {
  const access = await requireWorkspaceMember();
  const t = await getTranslations("AiClients");
  const clients = await listAiClientsProjection(access.user.id);
  const mcpUrl = new URL(MCP_RESOURCE_PATH, serverEnv().APP_URL).toString();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-medium text-foreground">{t("howToHeading")}</h2>
        <ol className="list-decimal pl-5 text-sm text-foreground">
          <li>{t("howToStep1")}</li>
          <li>{t("howToStep2")}</li>
          <li>{t("howToStep3")}</li>
        </ol>
        <CopyMcpUrl url={mcpUrl} />
        <p className="text-xs text-muted-foreground">{t("howToPermissions")}</p>
        <p className="text-xs text-muted-foreground">{t("howToDataNotice")}</p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-medium text-foreground">{t("listHeading")}</h2>
        <AiClientsList clients={clients} />
      </section>
    </div>
  );
}
