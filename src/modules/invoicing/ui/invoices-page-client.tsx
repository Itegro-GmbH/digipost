"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui-primitives";

import { createInvoiceDraftAction } from "../actions";
import type { InvoiceActionErrorCode } from "../core/error-codes";
import type { InvoiceDraftListItem, IssuedInvoiceListItem, SellerMissingField } from "../core/types";
import { formatCents, formatIsoDate, formatTimestamp } from "./format";

/**
 * `/dashboard/invoices` ("Rechnungen", decisions/0079-outgoing-invoices.md): the drafts still
 * being written, and every issued invoice and cancellation, newest number first. Issued rows
 * are read-only by design (GoBD); the only thing to do with one is to open, download or cancel
 * it.
 */
export function InvoicesPageClient({
  drafts,
  invoices,
  sellerMissing,
  canEditCompanyProfile,
}: {
  drafts: InvoiceDraftListItem[];
  invoices: IssuedInvoiceListItem[];
  sellerMissing: SellerMissingField[];
  canEditCompanyProfile: boolean;
}) {
  const t = useTranslations("Invoicing");
  const router = useRouter();
  const [errorCode, setErrorCode] = useState<InvoiceActionErrorCode>();
  const [pending, startTransition] = useTransition();

  function statusLabel(invoice: IssuedInvoiceListItem): string {
    if (invoice.type === "cancellation") return t("status.cancellationOf", { number: invoice.cancelsNumber ?? "" });
    if (invoice.cancelledByNumber) return t("status.cancelledBy", { number: invoice.cancelledByNumber });
    return t("status.issued");
  }

  function handleNew() {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await createInvoiceDraftAction();
      if (result.status === "success") {
        router.push(`/dashboard/invoices/drafts/${result.data.draftId}`);
        return;
      }
      setErrorCode(result.status === "error" ? result.errorCode : "invoice_invalid");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex gap-2">
          {invoices.length > 0 ? (
            <a href="/api/invoices/export" download className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted">
              {t("list.downloadAll")}
            </a>
          ) : null}
          <Button type="button" onClick={handleNew} disabled={pending} aria-busy={pending}>
            {pending ? t("list.newPending") : t("list.new")}
          </Button>
        </div>
      </div>

      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}

      {sellerMissing.length > 0 ? <SellerMissingNotice missing={sellerMissing} canEditCompanyProfile={canEditCompanyProfile} /> : null}

      {drafts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("list.draftsHeading")}</CardTitle>
            <CardDescription>{t("list.draftsDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y divide-border">
              {drafts.map((draft) => (
                <li key={draft.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/dashboard/invoices/drafts/${draft.id}`} className="text-sm font-medium text-foreground underline-offset-4 hover:underline">
                    {draft.buyerName || t("list.draftWithoutBuyer")}
                  </Link>
                  <span className="text-sm text-muted-foreground">
                    {draft.grossCents === null ? t("list.noTotal") : formatCents(draft.grossCents)} · {t("list.lineCount", { count: draft.lineCount })} ·{" "}
                    {t("list.editedAt", { date: formatTimestamp(draft.updatedAt) })}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("list.issuedHeading")}</CardTitle>
          <CardDescription>{t("list.issuedDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("list.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{t("list.columns.number")}</th>
                    <th className="py-2 pr-3 font-medium">{t("list.columns.date")}</th>
                    <th className="py-2 pr-3 font-medium">{t("list.columns.buyer")}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t("list.columns.amount")}</th>
                    <th className="py-2 font-medium">{t("list.columns.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3">
                        <Link href={`/dashboard/invoices/${invoice.id}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                          {invoice.number}
                        </Link>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{formatIsoDate(invoice.issueDate)}</td>
                      <td className="py-2 pr-3">{invoice.buyerName}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatCents(invoice.grossCents, invoice.currency)}</td>
                      <td className="py-2 text-muted-foreground">{statusLabel(invoice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function SellerMissingNotice({ missing, canEditCompanyProfile }: { missing: SellerMissingField[]; canEditCompanyProfile: boolean }) {
  const t = useTranslations("Invoicing.seller");
  return (
    <div role="status" className="flex flex-col gap-1 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-foreground">
      <p className="font-medium">{t("missingHeading")}</p>
      <p>{missing.map((field) => t(`missing.${field}`)).join(", ")}</p>
      {canEditCompanyProfile ? (
        <Link href="/dashboard/settings/company" className="self-start font-medium text-primary underline underline-offset-4">
          {t("editProfile")}
        </Link>
      ) : (
        <p className="text-muted-foreground">{t("askAdmin")}</p>
      )}
    </div>
  );
}
