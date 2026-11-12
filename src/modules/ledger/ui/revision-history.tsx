"use client";

import { useTranslations } from "next-intl";

import type { JournalEntryRevisionView } from "../core/types";
import { formatCents, formatTimestamp } from "./format";
import { revisionSteps, type DiffLine } from "./revision-diff";

function lineLabel(line: DiffLine): string {
  return `${line.accountNumber} ${formatCents(Math.abs(line.amountCents))} ${line.amountCents >= 0 ? "S" : "H"}`;
}

/**
 * "Verlauf": who changed the entry when, how, why, and for an edit which lines went and came
 * ("vorher 6825 305,00 S, jetzt 6825 300,00 S, 6855 5,00 S"). `users` maps user ids to a
 * display name; a revision without a user is the proposal engine's.
 */
export function RevisionHistory({
  revisions,
  currentLines,
  users,
}: {
  revisions: readonly JournalEntryRevisionView[];
  currentLines: readonly DiffLine[];
  users: Readonly<Record<string, string>>;
}) {
  const t = useTranslations("Ledger");
  const steps = revisionSteps(revisions, currentLines);

  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold text-foreground">{t("history.heading", { count: revisions.length })}</summary>
      {steps.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t("history.empty")}</p>
      ) : (
        <ol className="mt-3 flex flex-col gap-3">
          {steps.map(({ revision, diff }) => {
            const who = revision.changedByUserId ? (users[revision.changedByUserId] ?? t("history.unknownUser")) : t("history.system");
            const changed = diff && (diff.removed.length > 0 || diff.added.length > 0);
            return (
              <li key={revision.id} className="flex flex-col gap-0.5 border-l-2 border-border pl-3 text-sm">
                <p className="text-foreground">
                  <span className="font-medium">{t(`revisionKinds.${revision.changeKind}`)}</span>
                  <span className="text-muted-foreground"> {t("history.byAt", { who, at: formatTimestamp(revision.changedAt) })}</span>
                </p>
                {revision.reason ? <p className="text-muted-foreground">{t("history.reason", { reason: revision.reason })}</p> : null}
                {revision.changeKind === "edited" && diff && changed ? (
                  <p className="font-mono text-xs text-muted-foreground">
                    {t("history.before")}: {diff.removed.map(lineLabel).join(", ") || t("history.nothing")}
                    <br />
                    {t("history.after")}: {diff.added.map(lineLabel).join(", ") || t("history.nothing")}
                  </p>
                ) : null}
                {revision.changeKind === "edited" && diff && !changed ? <p className="text-xs text-muted-foreground">{t("history.linesUnchanged")}</p> : null}
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}
