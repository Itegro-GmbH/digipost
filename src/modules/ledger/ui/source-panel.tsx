"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { FileText, Landmark, TriangleAlert } from "lucide-react";

import { buttonVariants } from "@/shared/ui-primitives";

import type { LedgerSourceDocument, LedgerSourceTransaction } from "../core/types";
import { formatCents, formatIsoDate } from "./format";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Missing({ text }: { text: string }) {
  return (
    <p className="inline-flex items-start gap-1.5 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      {text}
    </p>
  );
}

/**
 * The left column of the booking editor: what the entry books. The document's extracted fields
 * (title, sender, date, total, the printed tax breakdown, reverse charge, pass-through costs,
 * service date) with links to the document page and its PDF, and/or the bank transaction. A
 * source that no longer exists says so ("Beleg gelöscht"); the entry itself stays.
 */
export function SourcePanel({
  documentId,
  document,
  transactionId,
  transaction,
}: {
  documentId: string | null;
  document: LedgerSourceDocument | null;
  transactionId: string | null;
  transaction: LedgerSourceTransaction | null;
}) {
  const t = useTranslations("Ledger.source");
  const currency = document?.currency ?? "EUR";

  return (
    <div className="flex flex-col gap-4">
      {documentId ? (
        <section aria-labelledby="source-document" className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <h2 id="source-document" className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <FileText aria-hidden className="size-4" />
            {t("document")}
          </h2>
          {document ? (
            <>
              <p className="font-medium text-foreground">{document.title ?? document.originalFileName}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                {document.sender || document.contactName ? <Fact label={t("sender")}>{document.contactName ?? document.sender}</Fact> : null}
                <Fact label={t("date")}>{formatIsoDate(document.documentDate ?? document.effectiveDate)}</Fact>
                {document.invoiceNumber ? <Fact label={t("invoiceNumber")}>{document.invoiceNumber}</Fact> : null}
                {document.totalAmountCents !== null ? (
                  <Fact label={t("total")}>
                    <span className="font-medium tabular-nums">{formatCents(document.totalAmountCents, currency)}</span>
                  </Fact>
                ) : null}
                {document.netTotalCents !== null ? (
                  <Fact label={t("net")}>
                    <span className="tabular-nums">{formatCents(document.netTotalCents, currency)}</span>
                  </Fact>
                ) : null}
                {document.taxTotalCents !== null ? (
                  <Fact label={t("tax")}>
                    <span className="tabular-nums">{formatCents(document.taxTotalCents, currency)}</span>
                  </Fact>
                ) : null}
                {(document.taxBreakdown ?? []).map((entry, index) => (
                  <Fact key={index} label={t("rate", { rate: entry.ratePercent })}>
                    <span className="tabular-nums">
                      {t("rateAmounts", {
                        net: entry.netCents === null ? t("notPrinted") : formatCents(entry.netCents, currency),
                        tax: entry.taxCents === null ? t("notPrinted") : formatCents(entry.taxCents, currency),
                      })}
                    </span>
                  </Fact>
                ))}
                {document.passThroughCents !== null && document.passThroughCents !== 0 ? (
                  <Fact label={t("passThrough")}>
                    <span className="tabular-nums">{formatCents(document.passThroughCents, currency)}</span>
                  </Fact>
                ) : null}
                {document.serviceDate ? <Fact label={t("serviceDate")}>{formatIsoDate(document.serviceDate)}</Fact> : null}
                {document.servicePeriodFrom && document.servicePeriodTo ? (
                  <Fact label={t("servicePeriod")}>{t("periodRange", { from: formatIsoDate(document.servicePeriodFrom), to: formatIsoDate(document.servicePeriodTo) })}</Fact>
                ) : null}
              </dl>
              {document.reverseCharge ? <p className="text-xs text-muted-foreground">{t("reverseCharge")}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Link href={`/dashboard/documents/${document.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  {t("openDocument")}
                </Link>
                <a href={`/api/documents/${document.id}/file`} target="_blank" rel="noopener" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  {t("openPdf")}
                </a>
              </div>
            </>
          ) : (
            <Missing text={t("documentMissing")} />
          )}
        </section>
      ) : null}

      {transactionId ? (
        <section aria-labelledby="source-transaction" className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <h2 id="source-transaction" className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Landmark aria-hidden className="size-4" />
            {t("transaction")}
          </h2>
          {transaction ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <Fact label={t("date")}>{formatIsoDate(transaction.bookingDate)}</Fact>
              <Fact label={t("amount")}>
                <span className={transaction.amountCents >= 0 ? "font-medium tabular-nums text-brand-positive" : "font-medium tabular-nums"}>
                  {formatCents(transaction.amountCents, transaction.currency)}
                </span>
              </Fact>
              {transaction.accountName ? <Fact label={t("bankAccount")}>{transaction.accountName}</Fact> : null}
              {transaction.counterpartyName ? <Fact label={t("counterparty")}>{transaction.counterpartyName}</Fact> : null}
              {transaction.remittanceText ? <Fact label={t("purpose")}>{transaction.remittanceText}</Fact> : null}
            </dl>
          ) : (
            <Missing text={t("transactionMissing")} />
          )}
        </section>
      ) : null}

      {!documentId && !transactionId ? <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{t("none")}</p> : null}
    </div>
  );
}
