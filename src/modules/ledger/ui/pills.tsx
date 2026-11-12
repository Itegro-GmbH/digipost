"use client";

import { useTranslations } from "next-intl";
import { Check, Circle, CircleDot, CircleCheck, FileText, ListChecks, Lock, PenLine, Send, Sparkles, TriangleAlert, X } from "lucide-react";

import { cn } from "@/shared/ui-primitives";

import type { JournalEntryOrigin, JournalEntryStatus, PeriodStatus, ProposalWarningCode } from "../core/types";
import { PILL_CLASSES } from "./format";

// Status chips always carry a label and an icon, never colour alone (decisions/0080 UI).

const ORIGIN_ICONS = { template: FileText, rule: ListChecks, ai: Sparkles, manual: PenLine } as const;

/** Where a proposal came from. The AI is marked in the warm brand colour: look twice. */
export function OriginPill({ origin }: { origin: JournalEntryOrigin }) {
  const t = useTranslations("Ledger");
  const Icon = ORIGIN_ICONS[origin];
  return (
    <span className={cn(PILL_CLASSES, origin === "ai" ? "bg-brand-warm/10 text-brand-warm" : "bg-muted text-foreground")}>
      <Icon aria-hidden className="size-3" />
      <span className="sr-only">{t("pills.originPrefix")} </span>
      {t(`origins.${origin}`)}
    </span>
  );
}

/** Vorschlag (dashed), Gebucht, Verworfen, and a lock when a filing freezes the entry. */
export function StatusPill({ status, dismissed = false, locked = false }: { status: JournalEntryStatus; dismissed?: boolean; locked?: boolean }) {
  const t = useTranslations("Ledger");
  if (locked) {
    return (
      <span className={cn(PILL_CLASSES, "bg-primary text-primary-foreground")}>
        <Lock aria-hidden className="size-3" />
        {t("pills.locked")}
      </span>
    );
  }
  if (dismissed) {
    return (
      <span className={cn(PILL_CLASSES, "bg-muted text-muted-foreground line-through decoration-muted-foreground/60")}>
        <X aria-hidden className="size-3" />
        {t("statuses.dismissed")}
      </span>
    );
  }
  if (status === "proposed") {
    return (
      <span className={cn(PILL_CLASSES, "border border-dashed border-border text-foreground")}>
        <CircleDot aria-hidden className="size-3" />
        {t("statuses.proposed")}
      </span>
    );
  }
  return (
    <span className={cn(PILL_CLASSES, "bg-brand-positive/10 text-brand-positive")}>
      <Check aria-hidden className="size-3" />
      {t("statuses.booked")}
    </span>
  );
}

const PERIOD_ICONS = { submitted: Lock, handed_over: Send, ready: CircleCheck, in_progress: CircleDot, open: Circle } as const;
const PERIOD_CLASSES: Record<PeriodStatus, string> = {
  submitted: "bg-primary text-primary-foreground",
  handed_over: "bg-accent text-accent-foreground",
  ready: "bg-brand-positive/10 text-brand-positive",
  in_progress: "bg-brand-warm/10 text-brand-warm",
  open: "bg-muted text-muted-foreground",
};

export function PeriodStatusPill({ status }: { status: PeriodStatus }) {
  const t = useTranslations("Ledger");
  const Icon = PERIOD_ICONS[status];
  return (
    <span className={cn(PILL_CLASSES, PERIOD_CLASSES[status])}>
      <Icon aria-hidden className="size-3" />
      {t(`periodStatus.${status}`)}
    </span>
  );
}

/** A proposal warning: a short chip plus the sentence that explains it. */
export function WarningChip({ code }: { code: ProposalWarningCode }) {
  const t = useTranslations("Ledger");
  return (
    <li className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
      <span className={cn(PILL_CLASSES, "w-fit shrink-0 bg-brand-warm/10 text-brand-warm")}>
        <TriangleAlert aria-hidden className="size-3" />
        {t(`warningLabels.${code}`)}
      </span>
      <span className="text-xs text-muted-foreground">{t(`warnings.${code}`)}</span>
    </li>
  );
}
