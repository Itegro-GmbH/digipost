"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { FileSearch } from "lucide-react";

import { Button } from "@/shared/ui-primitives";

/** The documents owner's action, passed in by the page so this module never imports another
 * owner's actions (`src/modules/documents`' `requestTaxFieldBackfillAction`). */
export type TaxBackfillAction = () => Promise<{ status: "success"; data: { queued: number; remaining: number } } | { status: "error"; errorCode: string }>;

/**
 * "Einstellungen > Allgemein": "Steuerdaten alter Belege nachträglich erkennen". Documents
 * processed before the tax fields existed have none, so their proposals guess; this queues the
 * tax-only re-extraction of up to `maxPerRequest` of them (the documents owner's use case, README
 * "Tax field backfill") and says how many are being read. A second click only queues documents
 * not queued before, so the button stays harmless.
 */
export function TaxBackfillCard({ candidates, maxPerRequest, canManage, action }: { candidates: number; maxPerRequest: number; canManage: boolean; action: TaxBackfillAction }) {
  const t = useTranslations("Ledger.settings");
  const router = useRouter();
  const [result, setResult] = useState<{ queued: number; remaining: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function start() {
    setFailed(false);
    setResult(null);
    startTransition(async () => {
      const outcome = await action();
      if (outcome.status === "error") {
        setFailed(true);
        return;
      }
      setResult(outcome.data);
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="settings-tax-backfill-heading" className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <h2 id="settings-tax-backfill-heading" className="font-medium text-foreground">
        {t("taxBackfillHeading")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("taxBackfillHint", { max: maxPerRequest })}</p>
      {result === null ? <p className="text-sm text-foreground">{t("taxBackfillCandidates", { count: candidates })}</p> : null}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" disabled={pending || (candidates === 0 && result === null)} aria-busy={pending} onClick={start}>
            <FileSearch aria-hidden />
            {t("taxBackfill")}
          </Button>
          <p role="status" className="text-sm text-muted-foreground">
            {result !== null ? t("taxBackfillQueued", { count: result.queued }) : null}
            {result !== null && result.remaining > 0 ? ` ${t("taxBackfillRemaining", { count: result.remaining })}` : null}
            {failed ? t("taxBackfillFailed") : null}
          </p>
        </div>
      ) : null}
    </section>
  );
}
