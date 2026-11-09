"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button, Card, CardContent, CardHeader, CardTitle } from "@/shared/ui-primitives";

import { cancelInvoiceAction } from "../actions";
import type { InvoiceActionErrorCode } from "../core/error-codes";
import type { IssuedInvoiceView } from "../core/types";
import { formatCents, formatIsoDate, formatTimestamp } from "./format";

/**
 * An issued invoice or cancellation (`/dashboard/invoices/[id]`, decisions/0079-outgoing-invoices.md):
 * read-only, with its archived PDF, both downloads, its audit trail and, for an invoice not
 * cancelled yet, "Stornieren", behind a confirmation, since the cancellation is itself a new
 * numbered invoice that can never be taken back.
 */
export function InvoiceDetailClient({ invoice }: { invoice: IssuedInvoiceView }) {
  const t = useTranslations("Invoicing.detail");
  const tStatus = useTranslations("Invoicing.status");
  const tErrors = useTranslations("Invoicing.errors");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [errorCode, setErrorCode] = useState<InvoiceActionErrorCode>();
  const [pending, startTransition] = useTransition();

  const cancellable = invoice.type === "invoice" && invoice.cancelledById === null;
  const fileUrl = (format: "pdf" | "xml", download: boolean) => `/api/invoices/${invoice.id}/file?format=${format}${download ? "&download=1" : ""}`;

  /** Links to the counterpart: the invoice a cancellation cancels, or the cancellation of an invoice. */
  function statusLine() {
    if (invoice.type === "cancellation" && invoice.cancelsId) {
      return (
        <Link href={`/dashboard/invoices/${invoice.cancelsId}`} className="underline underline-offset-4">
          {tStatus("cancellationOf", { number: invoice.cancelsNumber ?? "" })}
        </Link>
      );
    }
    if (invoice.cancelledById) {
      return (
        <Link href={`/dashboard/invoices/${invoice.cancelledById}`} className="underline underline-offset-4">
          {tStatus("cancelledBy", { number: invoice.cancelledByNumber ?? "" })}
        </Link>
      );
    }
    return tStatus("issued");
  }

  function cancel() {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await cancelInvoiceAction({ invoiceId: invoice.id });
      if (result.status === "success") {
        router.push(`/dashboard/invoices/${result.data.invoiceId}`);
        return;
      }
      setConfirming(false);
      setErrorCode(result.status === "error" ? result.errorCode : "invoice_invalid");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            {invoice.type === "invoice" ? t("headingInvoice", { number: invoice.number }) : t("headingCancellation", { number: invoice.number })}
          </h1>
          <p className="text-sm text-muted-foreground">{statusLine()}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={fileUrl("pdf", true)} className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted">
            {t("downloadPdf")}
          </a>
          <a href={fileUrl("xml", true)} className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted">
            {t("downloadXml")}
          </a>
          {cancellable ? (
            <Button type="button" variant="destructive" onClick={() => setConfirming(true)} disabled={pending}>
              {t("cancel")}
            </Button>
          ) : null}
        </div>
      </div>

      {confirming ? (
        <div role="alertdialog" aria-labelledby="cancel-confirm-heading" className="flex flex-col gap-3 rounded-lg border border-destructive/50 p-3">
          <p id="cancel-confirm-heading" className="text-sm font-medium text-foreground">
            {t("cancelConfirmHeading", { number: invoice.number })}
          </p>
          <p className="text-sm text-muted-foreground">{t("cancelConfirmText")}</p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" onClick={cancel} disabled={pending} aria-busy={pending}>
              {pending ? t("cancelPending") : t("cancelConfirm")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
              {t("cancelAbort")}
            </Button>
          </div>
        </div>
      ) : null}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {tErrors(errorCode)}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <iframe title={t("pdfTitle", { number: invoice.number })} src={fileUrl("pdf", false)} className="h-[75vh] w-full rounded-lg border border-border" />
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("facts")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t("buyer")}</dt>
                <dd>{invoice.buyerName}</dd>
                <dt className="text-muted-foreground">{t("issueDate")}</dt>
                <dd>{formatIsoDate(invoice.issueDate)}</dd>
                {invoice.dueDate ? (
                  <>
                    <dt className="text-muted-foreground">{t("dueDate")}</dt>
                    <dd>{formatIsoDate(invoice.dueDate)}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">{t("net")}</dt>
                <dd className="tabular-nums">{formatCents(invoice.netCents, invoice.currency)}</dd>
                <dt className="text-muted-foreground">{t("vat")}</dt>
                <dd className="tabular-nums">{formatCents(invoice.vatCents, invoice.currency)}</dd>
                <dt className="font-medium">{t("gross")}</dt>
                <dd className="font-medium tabular-nums">{formatCents(invoice.grossCents, invoice.currency)}</dd>
              </dl>
              {invoice.documentId ? (
                <Link href={`/dashboard/documents/${invoice.documentId}`} className="mt-3 inline-block text-sm font-medium text-primary underline underline-offset-4">
                  {t("openDocument")}
                </Link>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("history")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <ul className="flex flex-col gap-1">
                {invoice.events.map((event, index) => (
                  <li key={index}>
                    {t(`events.${event.kind}`, { actor: event.actorEmail ?? t("unknownActor"), date: formatTimestamp(event.at) })}
                  </li>
                ))}
              </ul>
              <p className="break-all text-xs text-muted-foreground">{t("integrity", { hash: invoice.pdfSha256 })}</p>
              <p className="text-xs text-muted-foreground">{t("immutable")}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
