"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@/shared/ui-primitives";

import { deleteInvoiceDraftAction, finalizeInvoiceDraftAction, saveInvoiceDraftAction } from "../actions";
import type { InvoiceActionErrorCode } from "../core/error-codes";
import {
  LINE_UNITS,
  LINE_VAT_RATES,
  TAX_EXEMPTIONS,
  type InvoiceContactOption,
  type InvoiceDraftContent,
  type InvoiceDraftLine,
  type InvoiceSellerSummary,
  type InvoiceTotalsCents,
  type InvoiceViolation,
  type TaxExemption,
} from "../core/types";
import { locateViolation } from "../core/violation-fields";
import { formatCents, SELECT_CLASSES, TEXTAREA_CLASSES } from "./format";
import { SellerMissingNotice } from "./invoices-page-client";

const EMPTY_LINE: InvoiceDraftLine = { name: "", description: "", quantity: "1", unit: "C62", unitPrice: "", vatRate: "19" };

type Check = { violations: InvoiceViolation[]; totals: InvoiceTotalsCents | null };

/**
 * The draft editor (`/dashboard/invoices/drafts/[id]`, decisions/0079-outgoing-invoices.md). A
 * draft is saved as it is, complete or not; "Prüfen" shows what is still missing (our checks
 * and the e-invoice library's, located on the editor's own fields), "Vorschau" the PDF with an
 * "ENTWURF" watermark, and "Festschreiben" turns it into a numbered invoice after a
 * confirmation, because that step cannot be undone: the issue date is today, the number is the
 * next one of the year, and a mistake afterwards can only be corrected by a cancellation.
 */
export function InvoiceDraftEditor({
  draftId,
  initialContent,
  initialCheck,
  seller,
  contacts,
  canEditCompanyProfile,
}: {
  draftId: string;
  initialContent: InvoiceDraftContent;
  initialCheck: Check;
  seller: InvoiceSellerSummary;
  contacts: InvoiceContactOption[];
  canEditCompanyProfile: boolean;
}) {
  const t = useTranslations("Invoicing.editor");
  const tErrors = useTranslations("Invoicing.errors");
  const tViolations = useTranslations("Invoicing.violations");
  const router = useRouter();
  const [content, setContent] = useState<InvoiceDraftContent>(initialContent);
  const [check, setCheck] = useState<Check>(initialCheck);
  const [dirty, setDirty] = useState(false);
  const [errorCode, setErrorCode] = useState<InvoiceActionErrorCode>();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const hasZeroRate = content.lines.some((line) => line.vatRate === "0");
  const canFinalize = seller.missing.length === 0 && check.violations.length === 0 && !dirty;

  function update(patch: Partial<InvoiceDraftContent>) {
    setContent((current) => ({ ...current, ...patch }));
    setDirty(true);
  }
  function updateBuyer(patch: Partial<InvoiceDraftContent["buyer"]>) {
    setContent((current) => ({ ...current, buyer: { ...current.buyer, ...patch } }));
    setDirty(true);
  }
  function updateLine(index: number, patch: Partial<InvoiceDraftLine>) {
    setContent((current) => ({ ...current, lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) }));
    setDirty(true);
  }

  function pickContact(contactId: string) {
    const contact = contacts.find((option) => option.id === contactId);
    if (!contact) {
      update({ contactId: null });
      return;
    }
    setContent((current) => ({
      ...current,
      contactId: contact.id,
      buyer: {
        ...current.buyer,
        name: contact.name,
        addressLine1: contact.addressLine1 ?? "",
        addressLine2: contact.addressLine2 ?? "",
        postalCode: contact.postalCode ?? "",
        city: contact.city ?? "",
        country: contact.country ?? "DE",
        vatId: contact.vatId ?? "",
        email: contact.email ?? "",
      },
    }));
    setDirty(true);
  }

  /** Saves, and on success hands the fresh check result to `then`. */
  function save(then?: (check: Check) => void) {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await saveInvoiceDraftAction({ draftId, content });
      if (result.status === "success") {
        setCheck({ violations: result.data.violations, totals: result.data.totals });
        setDirty(false);
        then?.(result.data);
        return;
      }
      if (result.status === "invalid") {
        setCheck((current) => ({ ...current, violations: result.violations }));
        return;
      }
      setErrorCode(result.errorCode);
    });
  }

  function finalize() {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await finalizeInvoiceDraftAction({ draftId });
      if (result.status === "success") {
        router.push(`/dashboard/invoices/${result.data.invoiceId}`);
        return;
      }
      setConfirming(false);
      if (result.status === "invalid") {
        setCheck((current) => ({ ...current, violations: result.violations }));
        return;
      }
      setErrorCode(result.errorCode);
    });
  }

  function remove() {
    if (!window.confirm(t("deleteConfirm"))) return;
    startTransition(async () => {
      const result = await deleteInvoiceDraftAction({ draftId });
      if (result.status === "success") {
        router.push("/dashboard/invoices");
        return;
      }
      setErrorCode(result.status === "error" ? result.errorCode : "unknown");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
          <p className="text-sm text-muted-foreground">{t("description", { seller: seller.name })}</p>
        </div>
        <Button type="button" variant="outline" onClick={remove} disabled={pending}>
          {t("delete")}
        </Button>
      </div>

      {seller.missing.length > 0 ? <SellerMissingNotice missing={seller.missing} canEditCompanyProfile={canEditCompanyProfile} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("buyer.heading")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {contacts.length > 0 ? (
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="invoice-contact">{t("buyer.pickContact")}</Label>
              <select id="invoice-contact" className={SELECT_CLASSES} value={content.contactId ?? ""} onChange={(event) => pickContact(event.target.value)}>
                <option value="">{t("buyer.noContact")}</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {[contact.name, contact.city].filter(Boolean).join(", ")}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <TextField id="buyer-name" label={t("buyer.name")} value={content.buyer.name} onChange={(name) => updateBuyer({ name })} maxLength={200} />
          <TextField id="buyer-vat" label={t("buyer.vatId")} value={content.buyer.vatId} onChange={(vatId) => updateBuyer({ vatId })} maxLength={30} />
          <TextField id="buyer-line1" label={t("buyer.addressLine1")} value={content.buyer.addressLine1} onChange={(addressLine1) => updateBuyer({ addressLine1 })} maxLength={200} />
          <TextField id="buyer-line2" label={t("buyer.addressLine2")} value={content.buyer.addressLine2} onChange={(addressLine2) => updateBuyer({ addressLine2 })} maxLength={200} />
          <TextField id="buyer-postal" label={t("buyer.postalCode")} value={content.buyer.postalCode} onChange={(postalCode) => updateBuyer({ postalCode })} maxLength={20} />
          <TextField id="buyer-city" label={t("buyer.city")} value={content.buyer.city} onChange={(city) => updateBuyer({ city })} maxLength={100} />
          <TextField id="buyer-country" label={t("buyer.country")} value={content.buyer.country} onChange={(country) => updateBuyer({ country: country.toUpperCase() })} maxLength={2} />
          <TextField id="buyer-email" label={t("buyer.email")} type="email" value={content.buyer.email} onChange={(email) => updateBuyer({ email })} maxLength={320} />
          <TextField id="buyer-order" label={t("buyer.orderReference")} value={content.buyer.orderReference} onChange={(orderReference) => updateBuyer({ orderReference })} maxLength={100} />
          <TextField id="buyer-reference" label={t("buyer.buyerReference")} value={content.buyer.buyerReference} onChange={(buyerReference) => updateBuyer({ buyerReference })} maxLength={100} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("lines.heading")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {content.lines.map((line, index) => (
            <fieldset key={index} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-6">
              <legend className="px-1 text-sm font-semibold text-foreground">{t("lines.position", { number: index + 1 })}</legend>
              <div className="sm:col-span-6">
                <TextField id={`line-${index}-name`} label={t("lines.name")} value={line.name} onChange={(name) => updateLine(index, { name })} maxLength={200} />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-6">
                <Label htmlFor={`line-${index}-description`}>{t("lines.description")}</Label>
                <textarea
                  id={`line-${index}-description`}
                  className={TEXTAREA_CLASSES}
                  value={line.description}
                  maxLength={1000}
                  onChange={(event) => updateLine(index, { description: event.target.value })}
                />
              </div>
              <TextField id={`line-${index}-quantity`} label={t("lines.quantity")} inputMode="decimal" value={line.quantity} onChange={(quantity) => updateLine(index, { quantity })} maxLength={14} />
              <div className="flex flex-col gap-1">
                <Label htmlFor={`line-${index}-unit`}>{t("lines.unit")}</Label>
                <select id={`line-${index}-unit`} className={SELECT_CLASSES} value={line.unit} onChange={(event) => updateLine(index, { unit: event.target.value as InvoiceDraftLine["unit"] })}>
                  {LINE_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {t(`units.${unit}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <TextField id={`line-${index}-price`} label={t("lines.unitPrice")} inputMode="decimal" value={line.unitPrice} onChange={(unitPrice) => updateLine(index, { unitPrice })} maxLength={14} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`line-${index}-vat`}>{t("lines.vatRate")}</Label>
                <select id={`line-${index}-vat`} className={SELECT_CLASSES} value={line.vatRate} onChange={(event) => updateLine(index, { vatRate: event.target.value as InvoiceDraftLine["vatRate"] })}>
                  {LINE_VAT_RATES.map((rate) => (
                    <option key={rate} value={rate}>
                      {t(`vatRates.${rate}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={content.lines.length <= 1}
                  onClick={() => update({ lines: content.lines.filter((_, i) => i !== index) })}
                >
                  {t("lines.remove")}
                </Button>
              </div>
            </fieldset>
          ))}
          <Button type="button" variant="outline" className="self-start" onClick={() => update({ lines: [...content.lines, { ...EMPTY_LINE }] })}>
            {t("lines.add")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("terms.heading")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <TextField id="delivery-date" type="date" label={t("terms.deliveryDate")} value={content.deliveryDate} onChange={(deliveryDate) => update({ deliveryDate })} />
          <div className="grid grid-cols-2 gap-3">
            <TextField id="period-start" type="date" label={t("terms.periodStart")} value={content.periodStart} onChange={(periodStart) => update({ periodStart })} />
            <TextField id="period-end" type="date" label={t("terms.periodEnd")} value={content.periodEnd} onChange={(periodEnd) => update({ periodEnd })} />
          </div>
          <TextField
            id="payment-days"
            type="number"
            label={t("terms.paymentTermDays")}
            value={String(content.paymentTermDays)}
            onChange={(value) => update({ paymentTermDays: Math.max(0, Math.min(365, Number.parseInt(value, 10) || 0)) })}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="payment-iban">{t("terms.paymentIban")}</Label>
            <select id="payment-iban" className={SELECT_CLASSES} value={content.paymentIban} onChange={(event) => update({ paymentIban: event.target.value })}>
              <option value="">{t("terms.noIban")}</option>
              {seller.ibans.map((iban) => (
                <option key={iban} value={iban}>
                  {iban}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="tax-exemption">{t("terms.taxExemption")}</Label>
            <select
              id="tax-exemption"
              className={SELECT_CLASSES}
              value={content.taxExemption ?? ""}
              onChange={(event) => update({ taxExemption: (event.target.value || null) as TaxExemption | null })}
            >
              <option value="">{hasZeroRate ? t("terms.chooseExemption") : t("terms.noExemption")}</option>
              {TAX_EXEMPTIONS.map((exemption) => (
                <option key={exemption} value={exemption}>
                  {t(`exemptions.${exemption}`)}
                </option>
              ))}
            </select>
          </div>
          {content.taxExemption === "exempt" ? (
            <TextField id="exemption-reason" label={t("terms.exemptionReason")} value={content.exemptionReason} onChange={(exemptionReason) => update({ exemptionReason })} maxLength={300} />
          ) : null}
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor="invoice-notes">{t("terms.notes")}</Label>
            <textarea id="invoice-notes" className={TEXTAREA_CLASSES} value={content.notes} maxLength={2000} onChange={(event) => update({ notes: event.target.value })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("check.heading")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {check.totals ? (
            <dl className="grid max-w-xs grid-cols-2 gap-1 text-sm">
              <dt className="text-muted-foreground">{t("check.net")}</dt>
              <dd className="text-right tabular-nums">{formatCents(check.totals.netCents)}</dd>
              <dt className="text-muted-foreground">{t("check.vat")}</dt>
              <dd className="text-right tabular-nums">{formatCents(check.totals.vatCents)}</dd>
              <dt className="font-medium">{t("check.gross")}</dt>
              <dd className="text-right font-medium tabular-nums">{formatCents(check.totals.grossCents)}</dd>
            </dl>
          ) : null}
          {dirty ? <p className="text-sm text-muted-foreground">{t("check.unsaved")}</p> : null}
          {check.violations.length === 0 && !dirty ? <p className="text-sm text-foreground">{t("check.valid")}</p> : null}
          {check.violations.length > 0 ? (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-destructive">
              {check.violations.map((violation, index) => {
                const located = locateViolation(violation);
                return (
                  <li key={`${violation.rule}-${violation.path}-${index}`}>
                    {tViolations(located.field, { line: (located.lineIndex ?? 0) + 1 })} <span className="text-xs text-muted-foreground">({violation.rule})</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {errorCode ? (
            <p role="alert" className="text-sm text-destructive">
              {tErrors(errorCode)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => save()} disabled={pending}>
              {t("save")}
            </Button>
            {/* A plain link, not `window.open` after the save: a popup blocker refuses a window
                opened outside the click itself. The preview always shows the SAVED draft. */}
            {dirty ? (
              <Button type="button" variant="outline" disabled title={t("previewNeedsSave")}>
                {t("preview")}
              </Button>
            ) : (
              <a
                href={`/api/invoices/drafts/${draftId}/preview`}
                target="_blank"
                rel="noopener"
                className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted"
              >
                {t("preview")}
              </a>
            )}
            <Button type="button" onClick={() => setConfirming(true)} disabled={pending || !canFinalize}>
              {t("finalize")}
            </Button>
          </div>
          {!canFinalize && !dirty && seller.missing.length === 0 && check.violations.length > 0 ? (
            <p className="text-sm text-muted-foreground">{t("finalizeBlocked")}</p>
          ) : null}
          {confirming ? (
            <div role="alertdialog" aria-labelledby="finalize-confirm-heading" className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3">
              <p id="finalize-confirm-heading" className="text-sm font-medium text-foreground">
                {t("finalizeConfirmHeading")}
              </p>
              <p className="text-sm text-muted-foreground">{t("finalizeConfirmText")}</p>
              <div className="flex gap-2">
                <Button type="button" onClick={finalize} disabled={pending} aria-busy={pending}>
                  {pending ? t("finalizePending") : t("finalizeConfirm")}
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
                  {t("cancel")}
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  maxLength,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  maxLength?: number;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} maxLength={maxLength} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
