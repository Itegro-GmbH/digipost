"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Lock, Send, TriangleAlert } from "lucide-react";

import { Button, cn, Input, Label } from "@/shared/ui-primitives";

import { createCorrectionFilingAction, createFilingAction, createHandoverAction, submitFilingAction } from "../actions";
import type { LedgerActionErrorCode } from "../core/error-codes";
import type { FilingKind, FilingView, PeriodStatus } from "../core/types";
import { formatCents, formatIsoDate, formatTimestamp, parseAmountInput, PILL_CLASSES, SELECT_CLASSES, TEXTAREA_CLASSES } from "./format";
import { PeriodStatusPill } from "./pills";
import { usePeriodLabel } from "./period-name";

export type PeriodHandoverView = { id: string; createdAt: string; changesSince: number; note: string | null };

/** One filing period ("Zeiträume und Meldungen"), as the page hands it over. */
export type FilingPeriodView = {
  key: string;
  kind: FilingKind;
  from: string;
  to: string;
  status: PeriodStatus | null;
  /** Booked entries dated in the period: what a submission locks. */
  bookedCount: number;
  proposedCount: number;
  /** The preview's Zahllast (positive) or Erstattung (negative), `null` when not computed. */
  previewPayableCents: number | null;
  handover: PeriodHandoverView | null;
  /** The newest submitted filing of the period (an original or a correction). */
  submitted: FilingView | null;
  /** The original submitted filing a correction refers to. */
  original: FilingView | null;
  /** A draft waiting to be submitted: a correction, or a plain draft. */
  draft: FilingView | null;
};

type ActionOutcome = { status: "success" } | { status: "error"; errorCode: LedgerActionErrorCode };

function useAction() {
  const router = useRouter();
  const [errorCode, setErrorCode] = useState<LedgerActionErrorCode | null>(null);
  const [pending, startTransition] = useTransition();
  function run(work: () => Promise<ActionOutcome>, onSuccess?: () => void) {
    setErrorCode(null);
    startTransition(async () => {
      const result = await work();
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      onSuccess?.();
      router.refresh();
    });
  }
  return { errorCode, pending, run };
}

function ErrorLine({ code }: { code: LedgerActionErrorCode | null }) {
  const t = useTranslations("Ledger");
  return code ? (
    <p role="alert" className="text-sm text-destructive">
      {t(`errors.${code}`)}
    </p>
  ) : null;
}

/**
 * "Als eingereicht markieren" (decisions/0080 UI concept C, screen H): an inline confirm card. It
 * names how many booked entries the submission freezes, asks for the date it was filed and,
 * for a USt-VA, the Zahllast on the filing protocol (a warning, never a block, when it differs
 * from the preview), and needs the explicit checkbox "Ich habe die Meldung beim Finanzamt
 * abgegeben". Creates the draft filing (unless one is waiting) and submits it.
 */
export function FilingConfirmCard({
  period,
  periodLabel,
  today,
  onCancel,
}: {
  period: Pick<FilingPeriodView, "kind" | "from" | "to" | "bookedCount" | "proposedCount" | "previewPayableCents" | "draft">;
  periodLabel: string;
  today: string;
  onCancel: () => void;
}) {
  const t = useTranslations("Ledger.filing");
  const { errorCode, pending, run } = useAction();
  const [submittedOn, setSubmittedOn] = useState(today);
  const [amountText, setAmountText] = useState("");
  const [direction, setDirection] = useState<"payable" | "refund">(period.previewPayableCents !== null && period.previewPayableCents < 0 ? "refund" : "payable");
  const [confirmed, setConfirmed] = useState(false);
  // The draft this card created: when submitting it fails, a retry submits the same draft
  // instead of creating a second one (which the database would refuse as overlapping).
  const createdDraftId = useRef<string | null>(null);

  const isVat = period.kind === "vat_return";
  const parsed = amountText.trim() === "" ? null : parseAmountInput(amountText);
  const amountInvalid = amountText.trim() !== "" && parsed === null;
  const signed = (cents: number) => (direction === "refund" ? -cents : cents);
  const amountCents = parsed === null ? null : signed(parsed);
  const differs = isVat && amountCents !== null && period.previewPayableCents !== null && amountCents !== period.previewPayableCents;
  const canSubmit = confirmed && submittedOn !== "" && !amountInvalid && !pending;
  const titleId = `filing-confirm-${period.kind}-${period.from}`;

  function submit() {
    run(async () => {
      let filingId = period.draft?.id ?? createdDraftId.current;
      if (!filingId) {
        const created = await createFilingAction({ kind: period.kind, periodFrom: period.from, periodTo: period.to, status: "draft" });
        if (created.status === "error") return created;
        filingId = created.data.id;
        createdDraftId.current = filingId;
      }
      return submitFilingAction({ filingId, submittedOn, amountCents });
    }, onCancel);
  }

  return (
    <div role="alertdialog" aria-labelledby={titleId} className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <p id={titleId} className="font-medium text-foreground">
        {t("confirmHeading", { period: periodLabel })}
      </p>
      <p className="text-sm text-muted-foreground">{t("notByDigipost")}</p>
      <p className="inline-flex items-start gap-1.5 text-sm text-foreground" data-testid="filing-lock-count">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
        {t("lockCount", { count: period.bookedCount, period: periodLabel })}
      </p>
      {period.proposedCount > 0 ? <p className="text-sm text-muted-foreground">{t("proposalsNotLocked", { count: period.proposedCount })}</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${titleId}-date`} className="text-xs text-muted-foreground">
            {t("submittedOn")}
          </Label>
          <Input id={`${titleId}-date`} type="date" required value={submittedOn} max={today} onChange={(event) => setSubmittedOn(event.target.value)} className="w-fit" />
        </div>
        {isVat ? (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${titleId}-direction`} className="text-xs text-muted-foreground">
                {t("amountKind")}
              </Label>
              <select id={`${titleId}-direction`} value={direction} onChange={(event) => setDirection(event.target.value as "payable" | "refund")} className={`${SELECT_CLASSES} w-fit`}>
                <option value="payable">{t("payable")}</option>
                <option value="refund">{t("refund")}</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${titleId}-amount`} className="text-xs text-muted-foreground">
                {t("amount")}
              </Label>
              <Input id={`${titleId}-amount`} inputMode="decimal" value={amountText} onChange={(event) => setAmountText(event.target.value)} aria-invalid={amountInvalid || undefined} placeholder="0,00" className="w-32" />
            </div>
          </>
        ) : null}
      </div>
      {isVat && period.previewPayableCents !== null ? (
        <p className="text-xs text-muted-foreground">{t(period.previewPayableCents >= 0 ? "previewPayable" : "previewRefund", { amount: formatCents(Math.abs(period.previewPayableCents)) })}</p>
      ) : null}
      {differs ? (
        <p role="status" className="inline-flex items-start gap-1.5 text-sm text-brand-warm">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t("amountDiffers", { difference: formatCents(Math.abs((amountCents ?? 0) - (period.previewPayableCents ?? 0))) })}
        </p>
      ) : null}
      <label className="flex items-start gap-2 text-sm text-foreground">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" />
        {t(isVat ? "confirmCheckbox" : "confirmCheckboxAnnual")}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!canSubmit} aria-busy={pending} onClick={submit}>
          <Lock aria-hidden />
          {t("submit")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
      <ErrorLine code={errorCode} />
    </div>
  );
}

/** "Berichtigte Meldung anlegen" (decisions/0080 UI concept C, screen I): the two ways to change a
 * submitted period, explained, with the recommendation left to the tax advisor. */
function CorrectionGuide({ original, period, onCancel }: { original: FilingView; period: Pick<FilingPeriodView, "from" | "to">; onCancel: () => void }) {
  const t = useTranslations("Ledger.filing");
  const { errorCode, pending, run } = useAction();
  return (
    <div role="region" aria-label={t("correctionHeading")} className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
      <p className="font-medium text-foreground">{t("correctionHeading")}</p>
      <div className="flex flex-col gap-1">
        <p className="font-medium text-foreground">{t("correctionFilingTitle")}</p>
        <p className="text-muted-foreground">{t("correctionFilingText")}</p>
        <Button type="button" variant="outline" size="sm" className="w-fit" disabled={pending} onClick={() => run(() => createCorrectionFilingAction({ filingId: original.id }), onCancel)}>
          {t("correctionCreate")}
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium text-foreground">{t("correctionLaterTitle")}</p>
        <p className="text-muted-foreground">{t("correctionLaterText")}</p>
        <Link href={`/dashboard/buchhaltung/journal?von=${period.from}&bis=${period.to}&status=booked`} className="w-fit text-foreground underline underline-offset-4">
          {t("correctionLaterLink")}
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">{t("correctionAdvisor")}</p>
      <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={onCancel}>
        {t("cancel")}
      </Button>
      <ErrorLine code={errorCode} />
    </div>
  );
}

/** "An Steuerberaterin übergeben": a marker with an optional note, never a lock. */
function HandoverForm({ period, onCancel }: { period: Pick<FilingPeriodView, "from" | "to">; onCancel: () => void }) {
  const t = useTranslations("Ledger.handover");
  const { errorCode, pending, run } = useAction();
  const [note, setNote] = useState("");
  const id = `handover-${period.from}`;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
      <Label htmlFor={id}>{t("noteLabel")}</Label>
      <textarea id={id} value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} className={TEXTAREA_CLASSES} placeholder={t("notePlaceholder")} />
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => run(() => createHandoverAction({ periodFrom: period.from, periodTo: period.to, note: note.trim() || null }), onCancel)}>
          <Send aria-hidden />
          {t("submit")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
      <ErrorLine code={errorCode} />
    </div>
  );
}

function PeriodRow({ period, today, canManage }: { period: FilingPeriodView; today: string; canManage: boolean }) {
  const t = useTranslations("Ledger");
  const label = usePeriodLabel()(period.from, period.to);
  const [open, setOpen] = useState<"handover" | "filing" | "correction" | null>(null);
  const draftIsCorrection = period.draft?.correctsFilingId != null;
  const canFile = canManage && (!period.submitted || draftIsCorrection);

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border p-3" data-period={period.key}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{period.kind === "annual_statement" ? t("filing.annualTitle", { period: label }) : label}</span>
            {period.status ? <PeriodStatusPill status={period.status} /> : null}
            {period.submitted ? (
              <span className={cn(PILL_CLASSES, "bg-primary text-primary-foreground")}>
                <Lock aria-hidden className="size-3" />
                {t("filing.submittedPill", { date: formatIsoDate(period.submitted.submittedOn ?? period.submitted.createdAt) })}
              </span>
            ) : null}
            {period.draft && draftIsCorrection ? <span className={cn(PILL_CLASSES, "bg-brand-warm/10 text-brand-warm")}>{t("filing.correctionDraft")}</span> : null}
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">{t("overview.counts", { booked: period.bookedCount, proposed: period.proposedCount })}</p>
          {period.submitted?.amountCents != null ? (
            <p className="text-xs text-muted-foreground">{t(period.submitted.amountCents >= 0 ? "filing.protocolPayable" : "filing.protocolRefund", { amount: formatCents(Math.abs(period.submitted.amountCents)) })}</p>
          ) : null}
          {period.handover ? (
            <p className="text-xs text-muted-foreground">
              {t("handover.done", { date: formatTimestamp(period.handover.createdAt) })}{" "}
              <Link href={`/dashboard/buchhaltung/journal?von=${period.from}&bis=${period.to}&seit=${period.handover.id}`} className={cn("underline underline-offset-4", period.handover.changesSince > 0 ? "font-medium text-foreground" : "")}>
                {t("periodChangesSince", { count: period.handover.changesSince })}
              </Link>
            </p>
          ) : null}
        </div>
        {canManage && open === null ? (
          <div className="flex flex-wrap gap-2">
            {period.kind === "vat_return" && !period.submitted ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setOpen("handover")}>
                <Send aria-hidden />
                {t("handover.button")}
              </Button>
            ) : null}
            {canFile ? (
              <Button type="button" size="sm" onClick={() => setOpen("filing")}>
                {t(draftIsCorrection ? "filing.markCorrectionSubmitted" : "filing.markSubmitted")}
              </Button>
            ) : null}
            {period.submitted && period.original && !period.draft ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setOpen("correction")}>
                {t("filing.correctionButton")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {open === "handover" ? <HandoverForm period={period} onCancel={() => setOpen(null)} /> : null}
      {open === "filing" ? <FilingConfirmCard period={period} periodLabel={label} today={today} onCancel={() => setOpen(null)} /> : null}
      {open === "correction" && period.original ? <CorrectionGuide original={period.original} period={period} onCancel={() => setOpen(null)} /> : null}
    </li>
  );
}

/**
 * "Zeiträume und Meldungen" (decisions/0080 UI concept C, screens A, H, I): every USt-VA period
 * of the year with its status, the handover to the tax advisor and the changes made since, the
 * filing flow that locks a period, the way to correct a submitted one, and the year's annual
 * statement.
 */
export function PeriodsClient({ periods, annual, today, canManage }: { periods: readonly FilingPeriodView[]; annual: FilingPeriodView; today: string; canManage: boolean }) {
  const t = useTranslations("Ledger");
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="periods-vat" className="flex flex-col gap-2">
        <h2 id="periods-vat" className="text-base font-semibold text-foreground">
          {t("filing.vatHeading")}
        </h2>
        {periods.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("overview.noPeriods")}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {periods.map((period) => (
              <PeriodRow key={period.key} period={period} today={today} canManage={canManage} />
            ))}
          </ol>
        )}
      </section>
      <section aria-labelledby="periods-annual" className="flex flex-col gap-2">
        <h2 id="periods-annual" className="text-base font-semibold text-foreground">
          {t("filing.annualHeading")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("filing.annualHint")}</p>
        <ol>
          <PeriodRow period={annual} today={today} canManage={canManage} />
        </ol>
      </section>
    </div>
  );
}
