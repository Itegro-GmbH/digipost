// Every code and value the invoicing UI can show resolves to German copy in `de.json`.
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";
import { INVOICE_ACTION_ERROR_CODES, LINE_UNITS, LINE_VAT_RATES, SELLER_MISSING_FIELDS, TAX_EXEMPTIONS, INVOICE_EVENT_KINDS } from "@/modules/invoicing";

describe("Invoicing messages", () => {
  const messages = de.Invoicing as unknown as Record<string, Record<string, Record<string, unknown>>>;

  it.each(INVOICE_ACTION_ERROR_CODES)("errors.%s resolves", (code) => {
    expect(typeof (messages.errors as Record<string, unknown>)[code]).toBe("string");
  });
  it.each(LINE_UNITS)("editor.units.%s resolves", (unit) => {
    expect(typeof messages.editor!.units![unit]).toBe("string");
  });
  it.each(LINE_VAT_RATES)("editor.vatRates.%s resolves", (rate) => {
    expect(typeof messages.editor!.vatRates![rate]).toBe("string");
  });
  it.each(TAX_EXEMPTIONS)("editor.exemptions.%s resolves", (exemption) => {
    expect(typeof messages.editor!.exemptions![exemption]).toBe("string");
  });
  it.each(SELLER_MISSING_FIELDS)("seller.missing.%s resolves", (field) => {
    expect(typeof messages.seller!.missing![field]).toBe("string");
  });
  it.each(INVOICE_EVENT_KINDS)("detail.events.%s resolves", (kind) => {
    expect(typeof messages.detail!.events![kind]).toBe("string");
  });
});
