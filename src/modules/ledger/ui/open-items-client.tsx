"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CircleCheck, CircleDot, FileText, Scale } from "lucide-react";

import { Button, cn } from "@/shared/ui-primitives";

import { createOpenItemMatchAction, deleteOpenItemMatchAction } from "../actions";
import type { LedgerActionErrorCode } from "../core/error-codes";
import type { OpenItemAccountType } from "../core/balance-view";
import type { MatchSuggestionReason, OpenItemAccountStatus, OpenItemMatchKind } from "../core/types";
import { formatCents, formatShortDate, PILL_CLASSES, TEXTAREA_CLASSES } from "./format";

export type OpenItemLineView = { lineId: string; entryId: string; bookingDate: string; text: string; amountCents: number; documentId: string | null };
export type OpenItemMatchGroupView = { id: string; kind: OpenItemMatchKind; note: string | null; sumCents: number; lines: OpenItemLineView[] };
export type OpenItemSuggestionView = { reason: MatchSuggestionReason; lineIds: string[]; amountCents: number };

const STATUS_CLASSES: Record<OpenItemAccountStatus, string> = {
  open: "bg-destructive/10 text-destructive",
  zero: "bg-brand-positive/10 text-brand-positive",
  explained: "bg-muted text-foreground",
};

function LineLabel({ line }: { line: OpenItemLineView }) {
  const t = useTranslations("Ledger");
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
      <span className="shrink-0 tabular-nums text-muted-foreground">{formatShortDate(line.bookingDate)}</span>
      <Link href={`/dashboard/buchhaltung/buchung/${line.entryId}`} className="min-w-0 truncate text-foreground underline-offset-4 hover:underline">
        {line.text}
      </Link>
      {line.documentId ? (
        <Link href={`/dashboard/documents/${line.documentId}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline">
          <FileText aria-hidden className="size-3" />
          {t("sheet.documentLink")}
        </Link>
      ) : null}
    </span>
  );
}

/**
 * "Offene Posten" of one open-item account (decisions/0080 UI concept B, screen D; concept C,
 * screen E): the open lines with checkboxes, a sticky bar with the selection's live sum,
 * "Ausgleichen" only at exactly 0,00, "Rest erklären" for a balance that is legitimately left
 * (a prepaid credit, a payout still to come) with a required note, the automatic suggestions
 * ("Diese n Posten gleichen sich aus") and the existing matches, each of which can be undone.
 * Without `canManage` the list is read-only.
 */
export function OpenItemsClient({
  accountNumber,
  accountType,
  balanceCents,
  status,
  unmatched,
  matches,
  suggestions,
  canManage,
}: {
  accountNumber: string;
  accountType: OpenItemAccountType;
  balanceCents: number;
  status: OpenItemAccountStatus;
  unmatched: readonly OpenItemLineView[];
  matches: readonly OpenItemMatchGroupView[];
  suggestions: readonly OpenItemSuggestionView[];
  canManage: boolean;
}) {
  const t = useTranslations("Ledger");
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [explaining, setExplaining] = useState(false);
  const [note, setNote] = useState("");
  const [errorCode, setErrorCode] = useState<LedgerActionErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  const byId = useMemo(() => new Map(unmatched.map((line) => [line.lineId, line])), [unmatched]);
  const selectedLines = unmatched.filter((line) => selected.has(line.lineId));
  const sum = selectedLines.reduce((total, line) => total + line.amountCents, 0);
  const canMatch = canManage && selectedLines.length > 0 && sum === 0;
  const canExplain = canManage && selectedLines.length > 0 && note.trim().length > 0;
  const usableSuggestions = suggestions.filter((suggestion) => suggestion.lineIds.every((id) => byId.has(id)));

  function toggle(lineId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }

  function run(work: () => Promise<{ status: "success" } | { status: "error"; errorCode: LedgerActionErrorCode }>) {
    setErrorCode(null);
    startTransition(async () => {
      const result = await work();
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      setSelected(new Set());
      setExplaining(false);
      setNote("");
      router.refresh();
    });
  }

  const match = (lineIds: string[]) => run(() => createOpenItemMatchAction({ accountNumber, kind: "match", lineIds }));
  const explain = () => run(() => createOpenItemMatchAction({ accountNumber, kind: "explained", lineIds: selectedLines.map((line) => line.lineId), note: note.trim() }));
  const undo = (matchId: string) => run(() => deleteOpenItemMatchAction({ matchId }));

  const allSelected = unmatched.length > 0 && selectedLines.length === unmatched.length;
  let selectionHint = t("openItems.remaining", { amount: formatCents(Math.abs(sum)) });
  if (selectedLines.length === 0) selectionHint = t("openItems.selectHint");
  else if (sum === 0) selectionHint = t("openItems.zeroReached");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/30 p-3 text-sm">
        <p className="font-medium text-foreground">{t(`openItems.types.${accountType}.title`)}</p>
        <p className="text-muted-foreground">{t(`openItems.types.${accountType}.text`)}</p>
      </div>

      <p className="inline-flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("openItems.balance")}</span>
        <span className="font-medium tabular-nums text-foreground">{formatCents(balanceCents)}</span>
        <span className={cn(PILL_CLASSES, STATUS_CLASSES[status])}>
          {status === "explained" ? <CircleDot aria-hidden className="size-3" /> : <CircleCheck aria-hidden className="size-3" />}
          {t(`openItemStatuses.${status}`)}
        </span>
      </p>

      {usableSuggestions.length > 0 ? (
        <section aria-labelledby="open-items-suggestions" className="flex flex-col gap-2">
          <h2 id="open-items-suggestions" className="text-sm font-medium text-foreground">
            {t("openItems.suggestionsHeading")}
          </h2>
          <ul className="grid gap-2 md:grid-cols-2">
            {usableSuggestions.map((suggestion) => (
              <li key={suggestion.lineIds.join(",")} className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
                <p className="text-sm font-medium text-foreground">{t("openItems.suggestionTitle", { count: suggestion.lineIds.length })}</p>
                <p className="text-xs text-muted-foreground">{t(`matchSuggestionReasons.${suggestion.reason}`)}</p>
                <ul className="flex flex-col gap-1 text-sm">
                  {suggestion.lineIds.map((id) => {
                    const line = byId.get(id)!;
                    return (
                      <li key={id} className="flex items-baseline justify-between gap-2">
                        <LineLabel line={line} />
                        <span className="shrink-0 tabular-nums">{formatCents(line.amountCents)}</span>
                      </li>
                    );
                  })}
                </ul>
                {canManage ? (
                  <Button type="button" size="sm" variant="outline" className="w-fit" disabled={pending} onClick={() => match(suggestion.lineIds)}>
                    {t("openItems.applySuggestion")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <section aria-labelledby="open-items-list" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h2 id="open-items-list" className="text-sm font-medium text-foreground">
              {t("openItems.openHeading", { count: unmatched.length })}
            </h2>
            {canManage && unmatched.length > 0 ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(unmatched.map((line) => line.lineId)))} />
                {t("openItems.selectAll")}
              </label>
            ) : null}
          </div>
          {unmatched.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("openItems.noneOpen")}</p>
          ) : (
            <ul className="flex flex-col rounded-lg border border-border">
              {unmatched.map((line) => (
                <li key={line.lineId} className={cn("flex items-baseline gap-3 border-b border-border px-3 py-2 text-sm last:border-0", selected.has(line.lineId) && "bg-muted/50")}>
                  {canManage ? (
                    <input
                      type="checkbox"
                      checked={selected.has(line.lineId)}
                      onChange={() => toggle(line.lineId)}
                      aria-label={t("openItems.selectLine", { text: line.text, amount: formatCents(line.amountCents) })}
                      className="mt-0.5"
                    />
                  ) : null}
                  <LineLabel line={line} />
                  <span className={cn("shrink-0 tabular-nums", line.amountCents < 0 && "text-muted-foreground")}>{formatCents(line.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {canManage ? (
          <aside aria-label={t("openItems.selectionLabel")} className="sticky bottom-0 z-10 flex flex-col gap-3 rounded-lg border border-border bg-background p-3 shadow-sm lg:top-4 lg:bottom-auto">
            <p className="flex items-baseline justify-between gap-2 text-sm">
              <span className="text-muted-foreground">{t("openItems.selected", { count: selectedLines.length })}</span>
              <span data-testid="open-items-sum" className={cn("font-semibold tabular-nums", sum === 0 ? "text-foreground" : "text-destructive")}>
                {formatCents(sum)}
              </span>
            </p>
            <p className="text-xs text-muted-foreground" role="status">
              {selectionHint}
            </p>
            <Button type="button" disabled={!canMatch || pending} onClick={() => match(selectedLines.map((line) => line.lineId))}>
              <Scale aria-hidden />
              {t("openItems.match")}
            </Button>
            {explaining ? (
              <div className="flex flex-col gap-2">
                <label htmlFor="open-items-note" className="text-sm font-medium text-foreground">
                  {t("openItems.noteLabel")}
                </label>
                <textarea id="open-items-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} className={TEXTAREA_CLASSES} placeholder={t("openItems.notePlaceholder")} aria-describedby="open-items-note-hint" />
                <p id="open-items-note-hint" className="text-xs text-muted-foreground">
                  {t("openItems.noteHint")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" disabled={!canExplain || pending} onClick={explain}>
                    {t("openItems.explainSubmit")}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setExplaining(false)}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="outline" disabled={selectedLines.length === 0 || pending} onClick={() => setExplaining(true)}>
                {t("openItems.explain")}
              </Button>
            )}
            {errorCode ? (
              <p role="alert" className="text-sm text-destructive">
                {t(`errors.${errorCode}`)}
              </p>
            ) : null}
          </aside>
        ) : null}
      </div>

      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/50">{t("openItems.matchesHeading", { count: matches.length })}</summary>
        {matches.length === 0 ? (
          <p className="border-t border-border px-3 py-3 text-sm text-muted-foreground">{t("openItems.noMatches")}</p>
        ) : (
          <ul className="flex flex-col border-t border-border">
            {matches.map((group) => (
              <li key={group.id} className="flex flex-col gap-2 border-b border-border px-3 py-3 last:border-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={cn(PILL_CLASSES, group.kind === "match" ? "bg-brand-positive/10 text-brand-positive" : "bg-muted text-foreground")}>{t(`matchKinds.${group.kind}`)}</span>
                    {group.note ? <span className="text-muted-foreground">{group.note}</span> : null}
                    {group.kind === "explained" ? <span className="tabular-nums text-foreground">{formatCents(group.sumCents)}</span> : null}
                  </span>
                  {canManage ? (
                    <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => undo(group.id)}>
                      {t("openItems.undo")}
                    </Button>
                  ) : null}
                </div>
                <ul className="flex flex-col gap-1 text-sm">
                  {group.lines.map((line) => (
                    <li key={line.lineId} className="flex items-baseline justify-between gap-2">
                      <LineLabel line={line} />
                      <span className="shrink-0 tabular-nums">{formatCents(line.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
