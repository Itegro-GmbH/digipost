"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronRight, CircleCheck, Trash2, Upload } from "lucide-react";

import { Button, cn, Input, Label } from "@/shared/ui-primitives";

import { deleteAdvisorUploadAction, uploadAdvisorBalancesAction } from "../actions";
import type { AdvisorComparisonRow } from "../core/advisor";
import type { LedgerActionErrorCode } from "../core/error-codes";
import type { AccountSheetRow } from "../core/reports";
import type { AdvisorUploadView } from "../core/types";
import { formatCents, formatSaldo, formatShortDate, formatTimestamp } from "./format";
import { usePeriodLabel } from "./period-name";

/** DATEV exports are usually Windows-1252; a file that is not valid UTF-8 is read as that. */
async function readCsvText(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * Upload of the tax advisor's Summen- und Saldenliste (decisions/0080 spec section 4): a DATEV
 * CSV export and the period it covers. Only account totals are compared, so the period must be
 * the one the advisor exported.
 */
export function AdvisorUploadForm({ defaultFrom, defaultTo }: { defaultFrom: string; defaultTo: string }) {
  const t = useTranslations("Ledger");
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [errorCode, setErrorCode] = useState<LedgerActionErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setErrorCode(null);
    startTransition(async () => {
      let csvText: string;
      try {
        csvText = await readCsvText(file);
      } catch {
        setErrorCode("advisor_file_invalid");
        return;
      }
      const result = await uploadAdvisorBalancesAction({ periodFrom: from, periodTo: to, fileName: file.name.slice(0, 255), csvText });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      router.push(`/dashboard/buchhaltung/auswertungen/abgleich?upload=${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-border p-4" aria-labelledby="advisor-upload-heading">
      <h2 id="advisor-upload-heading" className="font-medium text-foreground">
        {t("advisor.uploadHeading")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("advisor.uploadHint")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="advisor-file" className="text-xs text-muted-foreground">
            {t("advisor.file")}
          </Label>
          <Input id="advisor-file" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="w-fit" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="advisor-from" className="text-xs text-muted-foreground">
            {t("filters.from")}
          </Label>
          <Input id="advisor-from" type="date" required value={from} onChange={(event) => setFrom(event.target.value)} className="w-fit" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="advisor-to" className="text-xs text-muted-foreground">
            {t("filters.to")}
          </Label>
          <Input id="advisor-to" type="date" required value={to} onChange={(event) => setTo(event.target.value)} className="w-fit" />
        </div>
        <Button type="submit" disabled={!file || !from || !to || pending} aria-busy={pending}>
          <Upload aria-hidden />
          {pending ? t("advisor.uploading") : t("advisor.upload")}
        </Button>
      </div>
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
    </form>
  );
}

/** The uploaded lists, newest first: pick one to compare, or delete it. */
export function AdvisorUploadsList({ uploads, selectedId, canManage }: { uploads: readonly AdvisorUploadView[]; selectedId: string | null; canManage: boolean }) {
  const t = useTranslations("Ledger");
  const period = usePeriodLabel();
  const router = useRouter();
  const [errorCode, setErrorCode] = useState<LedgerActionErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  function remove(upload: AdvisorUploadView) {
    if (!window.confirm(t("advisor.deleteConfirm", { file: upload.fileName ?? period(upload.periodFrom, upload.periodTo) }))) return;
    setErrorCode(null);
    startTransition(async () => {
      const result = await deleteAdvisorUploadAction({ uploadId: upload.id });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      if (upload.id === selectedId) router.push("/dashboard/buchhaltung/auswertungen/abgleich");
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="advisor-uploads-heading" className="flex flex-col gap-2">
      <h2 id="advisor-uploads-heading" className="text-sm font-medium text-foreground">
        {t("advisor.uploadsHeading")}
      </h2>
      <ul className="flex flex-col rounded-lg border border-border">
        {uploads.map((upload) => (
          <li key={upload.id} className={cn("flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm last:border-0", upload.id === selectedId && "bg-muted/50")}>
            <Link href={`/dashboard/buchhaltung/auswertungen/abgleich?upload=${upload.id}`} aria-current={upload.id === selectedId ? "true" : undefined} className="flex min-w-0 flex-col underline-offset-4 hover:underline">
              <span className="font-medium text-foreground">{period(upload.periodFrom, upload.periodTo)}</span>
              <span className="text-xs text-muted-foreground">
                {t("advisor.uploadMeta", { file: upload.fileName ?? "", date: formatTimestamp(upload.uploadedAt), count: upload.lineCount })}
              </span>
            </Link>
            {canManage ? (
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => remove(upload)} aria-label={t("advisor.delete")}>
                <Trash2 aria-hidden />
                {t("advisor.delete")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
    </section>
  );
}

const GRID = "grid grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_7rem] items-baseline gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem_8rem]";

/**
 * Per account: Digipost's closing balance, the tax advisor's and the difference (decisions/0080
 * acceptance test). A differing row opens to Digipost's own Kontenblatt lines of the period,
 * which is where a difference is found; her side has totals only.
 */
export function AdvisorComparisonTable({
  rows,
  sheetLines,
  sheetQuery,
}: {
  rows: readonly AdvisorComparisonRow[];
  /** Digipost's lines of the period for the differing accounts, by account number. */
  sheetLines: Readonly<Record<string, readonly AccountSheetRow[]>>;
  sheetQuery: string;
}) {
  const t = useTranslations("Ledger");
  if (rows.length === 0) return <p className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{t("advisor.noRows")}</p>;

  return (
    <div role="table" aria-label={t("advisor.caption")} className="rounded-lg border border-border text-sm">
      <div role="row" className={cn(GRID, "bg-muted/50 px-3 py-2 text-xs text-muted-foreground")}>
        <span role="columnheader">{t("advisor.columns.account")}</span>
        <span role="columnheader" className="text-right">
          {t("advisor.columns.ours")}
        </span>
        <span role="columnheader" className="text-right">
          {t("advisor.columns.theirs")}
        </span>
        <span role="columnheader" className="text-right">
          {t("advisor.columns.difference")}
        </span>
      </div>
      {rows.map((row) => {
        const differs = row.differenceCents !== 0;
        const cells = (
          <>
            <span role="cell" className="flex min-w-0 items-baseline gap-1.5">
              {differs ? <ChevronRight aria-hidden className="size-3 shrink-0 self-center transition-transform group-open:rotate-90" /> : <CircleCheck aria-label={t("advisor.equal")} className="size-3 shrink-0 self-center text-brand-positive" />}
              <span className="truncate text-foreground">{row.name ?? ""}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.accountNumber}</span>
            </span>
            <span role="cell" className="text-right tabular-nums">
              {formatSaldo(row.oursCents)}
            </span>
            <span role="cell" className="text-right tabular-nums">
              {formatSaldo(row.theirsCents)}
            </span>
            <span role="cell" className={cn("text-right tabular-nums", differs ? "font-medium text-destructive" : "text-muted-foreground")}>
              {formatCents(row.differenceCents)}
            </span>
          </>
        );
        if (!differs) {
          return (
            <div key={row.accountNumber} role="row" className={cn(GRID, "border-t border-border px-3 py-2")}>
              {cells}
            </div>
          );
        }
        const lines = sheetLines[row.accountNumber] ?? [];
        return (
          <details key={row.accountNumber} className="group border-t border-border" data-account={row.accountNumber}>
            <summary role="row" className={cn(GRID, "cursor-pointer list-none px-3 py-2 hover:bg-muted/40")}>
              {cells}
            </summary>
            <div className="flex flex-col gap-2 px-3 pb-3 pl-8">
              {lines.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("advisor.noLines")}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {lines.map((line) => (
                    <li key={line.lineId} className="flex items-baseline justify-between gap-3">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatShortDate(line.bookingDate)}</span>
                        <Link href={`/dashboard/buchhaltung/buchung/${line.entryId}`} className="truncate text-foreground underline-offset-4 hover:underline">
                          {line.text}
                        </Link>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums">{formatSaldo(line.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <Link href={`/dashboard/buchhaltung/konten/${row.accountNumber}${sheetQuery}`} className="w-fit text-xs text-foreground underline underline-offset-4">
                {t("advisor.openSheet")}
              </Link>
            </div>
          </details>
        );
      })}
    </div>
  );
}
