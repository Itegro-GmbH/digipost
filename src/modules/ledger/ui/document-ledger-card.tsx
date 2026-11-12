"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { BookOpen, Check, CircleDashed, CircleDot, Lock } from "lucide-react";

import { buttonVariants, cn } from "@/shared/ui-primitives";

import type { LedgerDocumentStatus } from "../core/types";
import { formatShortDate, PILL_CLASSES } from "./format";
import { useFilingLabel } from "./period-name";

const STATE_ICONS = { locked: Lock, booked: Check, proposed: CircleDot, none: CircleDashed } as const;
const STATE_CLASSES: Record<LedgerDocumentStatus["state"], string> = {
  locked: "bg-primary text-primary-foreground",
  booked: "bg-brand-positive/10 text-brand-positive",
  proposed: "border border-dashed border-border text-foreground",
  none: "bg-muted text-muted-foreground",
};

/**
 * The document page's "Buchhaltung" card (decisions/0080 UI): whether this document is booked
 * (Vorschlag, gebucht, gesperrt, keine Buchung), the deterministic sentence of its entry, and a
 * link to the entry, or "Buchung anlegen" when there is none. Rendered only while the ledger is on
 * and for a caller with `finance.read`.
 */
export function DocumentLedgerCard({ status, documentId, canManage }: { status: LedgerDocumentStatus; documentId: string; canManage: boolean }) {
  const t = useTranslations("Ledger");
  const filingLabel = useFilingLabel();
  const visible = status.entries.filter((entry) => !entry.dismissed);
  const main = visible[0] ?? null;
  const Icon = STATE_ICONS[status.state];

  return (
    <section aria-labelledby="document-ledger-heading" className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="document-ledger-heading" className="inline-flex items-center gap-2 font-medium text-foreground">
          <BookOpen aria-hidden className="size-4" />
          {t("documentCard.heading")}
        </h2>
        <span className={cn(PILL_CLASSES, STATE_CLASSES[status.state])}>
          <Icon aria-hidden className="size-3" />
          {t(`documentCard.states.${status.state}`)}
        </span>
      </div>
      {main ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-foreground">{t(main.summary.key, main.summary.params)}</p>
          <p className="text-xs text-muted-foreground">
            {t("documentCard.bookingDate", { date: formatShortDate(main.bookingDate) })}
            {main.lockedBy ? ` ${t("documentCard.lockedBy", { filing: filingLabel(main.lockedBy) })}` : null}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Link href={`/dashboard/buchhaltung/buchung/${main.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              {t(main.status === "proposed" ? "documentCard.openProposal" : "documentCard.openEntry")}
            </Link>
          </div>
          {visible.length > 1 ? (
            <ul className="mt-2 flex flex-col gap-1 border-t border-border pt-2 text-xs">
              {visible.slice(1).map((entry) => (
                <li key={entry.id}>
                  <Link href={`/dashboard/buchhaltung/buchung/${entry.id}`} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    {formatShortDate(entry.bookingDate)}: {t(entry.summary.key, entry.summary.params)}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t(status.entries.length > 0 ? "documentCard.dismissed" : "documentCard.none")}</p>
          {canManage ? (
            <Link href={`/dashboard/buchhaltung/buchung/neu?beleg=${documentId}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}>
              {t("documentCard.create")}
            </Link>
          ) : null}
        </div>
      )}
    </section>
  );
}
