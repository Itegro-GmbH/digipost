"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

/** The MCP server URL with a copy button ("So verbinden Sie Ihre KI"). */
export function CopyMcpUrl({ url }: { url: string }) {
  const t = useTranslations("AiClients");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the URL stays selectable in the field.
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <code className="flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground" data-testid="mcp-url">
        {url}
      </code>
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        {copied ? t("copied") : t("copy")}
      </Button>
    </div>
  );
}
