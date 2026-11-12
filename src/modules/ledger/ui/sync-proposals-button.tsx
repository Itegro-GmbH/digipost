"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";

import { Button } from "@/shared/ui-primitives";

import { syncLedgerProposalsAction } from "../actions";
import type { LedgerActionErrorCode } from "../core/error-codes";
import type { SyncProposalsResult } from "../core/types";

/** "Vorschläge aktualisieren": runs the proposal engine for the workspace (idempotent) and says
 * what it did, inline next to the button (`role="status"`). */
export function SyncProposalsButton({ from, to }: { from?: string; to?: string }) {
  const t = useTranslations("Ledger");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SyncProposalsResult | null>(null);
  const [errorCode, setErrorCode] = useState<LedgerActionErrorCode | null>(null);

  function sync() {
    setErrorCode(null);
    setResult(null);
    startTransition(async () => {
      const response = await syncLedgerProposalsAction({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
      if (response.status === "error") {
        setErrorCode(response.errorCode);
        return;
      }
      setResult(response.data);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" variant="outline" onClick={sync} disabled={pending} aria-busy={pending}>
        <RefreshCw aria-hidden className={pending ? "animate-spin" : undefined} />
        {pending ? t("sync.pending") : t("sync.button")}
      </Button>
      <p role="status" className="text-xs text-muted-foreground">
        {result ? t("sync.result", { created: result.created, updated: result.updated, unproposed: result.unproposed }) : null}
        {result && result.deferred > 0 ? ` ${t("sync.deferred")}` : null}
      </p>
      {result && result.problems.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {[...new Set(result.problems.map((problem) => problem.code))].map((code) => (
            <li key={code}>{t(`problems.${code}`)}</li>
          ))}
        </ul>
      ) : null}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
    </div>
  );
}
