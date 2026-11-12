"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CircleCheck, Keyboard, TriangleAlert } from "lucide-react";

import { Button, buttonVariants, cn } from "@/shared/ui-primitives";

import { bookJournalEntryAction, bulkBookJournalEntriesAction, dismissProposalAction } from "../actions";
import type { LedgerActionErrorCode } from "../core/error-codes";
import type { JournalEntryListItem } from "../core/types";
import { EntryLinesTable } from "./entry-lines-table";
import { formatCents, formatShortDate } from "./format";
import { OriginPill, WarningChip } from "./pills";
import { groupQueue, isSafeProposal, problemHref, type QueueProblem } from "./queue-model";

/** Keys only act when the user is not typing (decisions/0080 UI concept A, "Keyboard"). */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

const editHref = (id: string) => `/dashboard/buchhaltung/buchung/${id}`;

/**
 * "Zu prüfen" (`/dashboard/buchhaltung/zu-pruefen`): the proposals grouped by certainty, the
 * sources without a proposal ("Probleme"), single and bulk booking, and the keyboard map
 * (j/k move, Enter books, e edits, x selects, ? opens the help). A booked or dismissed row
 * disappears at once and comes back with its error if the action fails.
 */
export function ReviewQueueClient({ entries, problems, canManage, filtered }: { entries: readonly JournalEntryListItem[]; problems: readonly QueueProblem[]; canManage: boolean; filtered: boolean }) {
  const t = useTranslations("Ledger");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, LedgerActionErrorCode>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [confirmingDismiss, setConfirmingDismiss] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ booked: number; failed: number } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const visible = useMemo(() => entries.filter((entry) => !hidden.has(entry.id)), [entries, hidden]);
  const groups = useMemo(() => groupQueue(visible), [visible]);
  // Keyboard order follows the page: the safe group first, then "Bitte ansehen".
  const ordered = useMemo(() => [...groups.safe, ...groups.review], [groups]);
  const selectedVisible = ordered.filter((entry) => selected.has(entry.id));
  const selectedSum = selectedVisible.reduce((sum, entry) => sum + entry.totalCents, 0);

  const update = <T,>(set: React.Dispatch<React.SetStateAction<ReadonlySet<T>>>, id: T, on: boolean) =>
    set((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const setFailure = (id: string, code: LedgerActionErrorCode | null) =>
    setFailures((current) => {
      const next = new Map(current);
      if (code) next.set(id, code);
      else next.delete(id);
      return next;
    });

  const focusRow = useCallback((id: string | null) => {
    setFocusedId(id);
    if (id) rowRefs.current.get(id)?.focus();
  }, []);

  /** The row after `id` (or before it when it was the last), for focus once it disappears. */
  const neighbourOf = (id: string) => {
    const index = ordered.findIndex((entry) => entry.id === id);
    return ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? null;
  };

  function book(id: string) {
    if (!canManage || busy.has(id)) return;
    const next = neighbourOf(id);
    setFailure(id, null);
    setBulkResult(null);
    update(setHidden, id, true);
    update(setSelected, id, false);
    if (focusedId === id) focusRow(next);
    startTransition(async () => {
      const result = await bookJournalEntryAction({ entryId: id });
      if (result.status === "error") {
        update(setHidden, id, false);
        setFailure(id, result.errorCode);
        return;
      }
      router.refresh();
    });
  }

  function dismiss(id: string) {
    const next = neighbourOf(id);
    setConfirmingDismiss(null);
    setFailure(id, null);
    update(setBusy, id, true);
    startTransition(async () => {
      const result = await dismissProposalAction({ entryId: id });
      update(setBusy, id, false);
      if (result.status === "error") {
        setFailure(id, result.errorCode);
        return;
      }
      update(setHidden, id, true);
      update(setSelected, id, false);
      focusRow(next);
      router.refresh();
    });
  }

  function bookSelected() {
    const ids = selectedVisible.map((entry) => entry.id);
    if (!canManage || ids.length === 0) return;
    setBulkResult(null);
    setHidden((current) => new Set([...current, ...ids]));
    setSelected(new Set());
    startTransition(async () => {
      const result = await bulkBookJournalEntriesAction({ entryIds: ids });
      if (result.status === "error") {
        setHidden((current) => new Set([...current].filter((id) => !ids.includes(id))));
        for (const id of ids) setFailure(id, result.errorCode);
        return;
      }
      const failedIds = new Set(result.data.failed.map((failure) => failure.entryId));
      setHidden((current) => new Set([...current].filter((id) => !failedIds.has(id))));
      for (const failure of result.data.failed) setFailure(failure.entryId, failure.errorCode);
      setBulkResult({ booked: result.data.booked.length, failed: result.data.failed.length });
      router.refresh();
    });
  }

  function selectAllSafe() {
    setSelected(new Set(groups.safe.map((entry) => entry.id)));
  }

  // The keyboard map. One listener for the page; it ignores keys typed into a field and any
  // combination with a modifier, so browser and screen-reader shortcuts keep working.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      const index = ordered.findIndex((entry) => entry.id === focusedId);
      const current = index >= 0 ? ordered[index] : undefined;
      switch (event.key) {
        case "j": {
          const next = ordered[Math.min(index + 1, ordered.length - 1)];
          if (next) {
            event.preventDefault();
            focusRow(next.id);
          }
          return;
        }
        case "k": {
          const previous = ordered[Math.max(index - 1, 0)];
          if (previous) {
            event.preventDefault();
            focusRow(previous.id);
          }
          return;
        }
        case "x":
          if (current && canManage) {
            event.preventDefault();
            update(setSelected, current.id, !selected.has(current.id));
          }
          return;
        case "e":
          if (current) {
            event.preventDefault();
            router.push(editHref(current.id));
          }
          return;
        case "Enter":
          // Only on the row itself: Enter on one of its buttons or links does what they do.
          if (current && event.target instanceof HTMLElement && event.target.dataset.queueRow === current.id) {
            event.preventDefault();
            book(current.id);
          }
          return;
        case "?":
          event.preventDefault();
          setHelpOpen((open) => !open);
          return;
        case "Escape":
          setHelpOpen(false);
          setConfirmingDismiss(null);
          return;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  const nothingLeft = ordered.length === 0 && problems.length === 0;

  function reasonOf(entry: JournalEntryListItem): string | null {
    if (entry.origin === "ai") return entry.originReason;
    if (entry.origin === "template" && entry.originReason?.startsWith("template:")) {
      const id = entry.originReason.slice("template:".length);
      return t.has(`templates.${id}`) ? t("queue.templateReason", { template: t(`templates.${id}`) }) : null;
    }
    if (entry.origin === "rule") return t("queue.ruleReason");
    return null;
  }

  function renderRow(entry: JournalEntryListItem) {
    const isFocused = focusedId === entry.id;
    const failure = failures.get(entry.id);
    const reason = reasonOf(entry);
    const titleId = `queue-row-${entry.id}-title`;
    return (
      <li
        key={entry.id}
        ref={(element) => {
          if (element) rowRefs.current.set(entry.id, element);
          else rowRefs.current.delete(entry.id);
        }}
        tabIndex={isFocused || (focusedId === null && entry.id === ordered[0]?.id) ? 0 : -1}
        data-queue-row={entry.id}
        aria-labelledby={titleId}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocusedId(entry.id);
        }}
        className={cn(
          "flex flex-col gap-2 rounded-lg border border-dashed border-border p-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          isFocused && "border-ring bg-muted/30",
        )}
      >
        <div className="flex items-start gap-3">
          {canManage ? (
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.has(entry.id)}
              onChange={(event) => update(setSelected, entry.id, event.target.checked)}
              aria-label={t("queue.select", { text: entry.text })}
            />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p id={titleId} className="min-w-0 font-medium text-foreground">
                <span className="mr-2 text-sm tabular-nums text-muted-foreground">{formatShortDate(entry.documentDate ?? entry.bookingDate)}</span>
                {entry.text}
              </p>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium tabular-nums">{formatCents(entry.totalCents)}</span>
                <OriginPill origin={entry.origin} />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{t(entry.summary.key, entry.summary.params)}</p>
            {entry.differenceCents !== 0 ? (
              <p className="inline-flex items-center gap-1 text-xs text-destructive">
                <TriangleAlert aria-hidden className="size-3" />
                {t("lines.difference", { amount: formatCents(Math.abs(entry.differenceCents)) })}
              </p>
            ) : null}
            {entry.warnings.length > 0 ? (
              <ul className="flex flex-col gap-1" aria-label={t("queue.warningsLabel")}>
                {entry.warnings.map((code) => (
                  <WarningChip key={code} code={code} />
                ))}
              </ul>
            ) : null}
            {reason && entry.origin === "ai" ? (
              <details className="text-sm">
                <summary className="w-fit cursor-pointer text-brand-warm underline-offset-4 hover:underline">{t("queue.why")}</summary>
                <p className="mt-1 text-muted-foreground">{reason}</p>
              </details>
            ) : null}
            {reason && entry.origin !== "ai" ? <p className="text-xs text-muted-foreground">{reason}</p> : null}
            <details className="text-sm">
              <summary className="w-fit cursor-pointer text-muted-foreground underline-offset-4 hover:underline">{t("queue.showLines")}</summary>
              <EntryLinesTable className="mt-2" caption={t("lines.caption")} lines={entry.lines} />
            </details>
          </div>
        </div>

        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {t(`errors.${failure}`)}
          </p>
        ) : null}

        {confirmingDismiss === entry.id ? (
          <div role="alertdialog" aria-labelledby={`dismiss-${entry.id}`} className="flex flex-col gap-2 rounded-lg border border-destructive/50 p-3">
            <p id={`dismiss-${entry.id}`} className="text-sm text-foreground">
              {t("queue.dismissConfirm")}
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="destructive" size="sm" onClick={() => dismiss(entry.id)}>
                {t("queue.dismissYes")}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingDismiss(null)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {canManage ? (
              <Button type="button" size="sm" onClick={() => book(entry.id)} disabled={busy.has(entry.id) || entry.differenceCents !== 0}>
                {t("queue.book")}
              </Button>
            ) : null}
            <Link href={editHref(entry.id)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              {t("queue.edit")}
            </Link>
            {canManage ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingDismiss(entry.id)} disabled={busy.has(entry.id)}>
                {t("queue.dismiss")}
              </Button>
            ) : null}
          </div>
        )}
      </li>
    );
  }

  function section(id: string, heading: string, hint: string, rows: readonly JournalEntryListItem[]) {
    if (rows.length === 0) return null;
    return (
      <section aria-labelledby={id} className="flex flex-col gap-2">
        <div>
          <h2 id={id} className="text-base font-semibold text-foreground">
            {heading} <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
          </h2>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        <ul className="flex flex-col gap-2">{rows.map(renderRow)}</ul>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {canManage && ordered.length > 0 ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/95 p-3 backdrop-blur">
          <Button type="button" variant="outline" size="sm" onClick={selectAllSafe} disabled={groups.safe.length === 0}>
            {t("queue.selectSafe", { count: groups.safe.length })}
          </Button>
          {selectedVisible.length > 0 ? (
            <>
              <Button type="button" size="sm" onClick={bookSelected}>
                {t("queue.bookSelected", { count: selectedVisible.length, sum: formatCents(selectedSum) })}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                {t("queue.clearSelection")}
              </Button>
            </>
          ) : null}
          {selectedVisible.some((entry) => !isSafeProposal(entry)) ? <p className="text-xs text-muted-foreground">{t("queue.selectionHasUnsafe")}</p> : null}
          <p role="status" className="text-sm text-muted-foreground">
            {bulkResult ? t("queue.bulkResult", { booked: bulkResult.booked, failed: bulkResult.failed }) : null}
          </p>
          <Button type="button" variant="ghost" size="sm" className="ml-auto" aria-expanded={helpOpen} aria-controls="queue-keyboard-help" onClick={() => setHelpOpen((open) => !open)}>
            <Keyboard aria-hidden />
            {t("keyboard.button")}
          </Button>
        </div>
      ) : null}

      {helpOpen ? (
        <section id="queue-keyboard-help" aria-labelledby="queue-keyboard-help-heading" className="rounded-lg border border-border p-3">
          <h2 id="queue-keyboard-help-heading" className="text-sm font-semibold text-foreground">
            {t("keyboard.heading")}
          </h2>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {(["j", "k", "enter", "e", "x", "help"] as const).map((key) => (
              <div key={key} className="contents">
                <dt>
                  <kbd className="rounded border border-border bg-muted px-1.5 font-mono text-xs">{t(`keyboard.keys.${key}`)}</kbd>
                </dt>
                <dd className="text-muted-foreground">{t(`keyboard.${key}`)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">{t("keyboard.note")}</p>
        </section>
      ) : null}

      {nothingLeft ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center">
          <CircleCheck aria-hidden className="size-6 text-brand-positive" />
          <p className="font-medium text-foreground">{filtered ? t("queue.emptyFilteredHeading") : t("queue.emptyHeading")}</p>
          <p className="max-w-prose text-sm text-muted-foreground">{filtered ? t("queue.emptyFiltered") : t("queue.empty")}</p>
          <Link href="/dashboard/buchhaltung" className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("queue.emptyNext")}
          </Link>
        </div>
      ) : null}

      {section("queue-safe", t("queue.safe"), t("queue.safeHint"), groups.safe)}
      {section("queue-review", t("queue.review"), t("queue.reviewHint"), groups.review)}

      {problems.length > 0 ? (
        <section aria-labelledby="queue-problems" className="flex flex-col gap-2">
          <div>
            <h2 id="queue-problems" className="text-base font-semibold text-foreground">
              {t("queue.problems")} <span className="text-sm font-normal text-muted-foreground">({problems.length})</span>
            </h2>
            <p className="text-sm text-muted-foreground">{t("queue.problemsHint")}</p>
          </div>
          <ul className="flex flex-col gap-2">
            {problems.map((problem) => (
              <li key={`${problem.kind}-${problem.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <TriangleAlert aria-hidden className="size-3" />
                    {t(problem.kind === "transaction" ? "queue.problemTransaction" : "queue.problemDocument")}
                  </p>
                  <p className="min-w-0 font-medium text-foreground">
                    {problem.date ? <span className="mr-2 text-sm tabular-nums text-muted-foreground">{formatShortDate(problem.date)}</span> : null}
                    {problem.title}
                  </p>
                  {problem.dismissed ? <p className="text-xs text-muted-foreground">{t("queue.problemDismissed")}</p> : null}
                </div>
                <div className="flex items-center gap-3">
                  {problem.amountCents !== null ? <span className="text-sm tabular-nums">{formatCents(problem.amountCents)}</span> : null}
                  {problem.kind === "document" ? (
                    <Link href={`/dashboard/documents/${problem.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                      {t("queue.openDocument")}
                    </Link>
                  ) : null}
                  {canManage ? (
                    <Link href={problemHref(problem)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                      {t("queue.createEntry")}
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
