// Best-effort ZUGFeRD/Factur-X CII invoice field extraction (decisions/0020-universal-intake.md,
// decisions/0022-intake-wiring.md). No fixture file exists for this (F1a's own fixtures are
// camt.053/CSV/TSV only), so this test builds a minimal synthetic CII document directly -
// enough structure to exercise every field this reader knows how to extract.
import { describe, expect, it } from "vitest";

import { extractZugferdInvoiceFields } from "../core/zugferd-extraction";

const MINIMAL_CII_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocument>
    <ram:ID>4711</ram:ID>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>Telekom Deutschland GmbH</ram:Name>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Muster GmbH</ram:Name>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>DE89370400440532013000</ram:IBANID>
        </ram:PayeePartyCreditorFinancialAccount>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">20260415</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:GrandTotalAmount>83.68</ram:GrandTotalAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

/** A realistic EN 16931 (ZUGFeRD 2.x "EN 16931" profile) domestic invoice with two VAT rates,
 * a delivery date, a billing period, a tax-number and a VAT-id registration on the seller,
 * and the tax total repeated in an accounting currency (BT-111). */
const MIXED_RATE_CII_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>RE-2026-0315</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20260331</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>107.88</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>Muster Druckerei GmbH</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>10115</ram:PostcodeCode>
          <ram:CityName>Berlin</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">27/123/45678</ram:ID></ram:SpecifiedTaxRegistration>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE123456789</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Itegro GmbH</ram:Name>
        <ram:PostalTradeAddress><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE987654321</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime><udt:DateTimeString format="102">20260315</udt:DateTimeString></ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:TaxCurrencyCode>USD</ram:TaxCurrencyCode>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>20.50</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>107.88</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>3.50</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>50.00</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:BillingSpecifiedPeriod>
        <ram:StartDateTime><udt:DateTimeString format="102">20260301</udt:DateTimeString></ram:StartDateTime>
        <ram:EndDateTime><udt:DateTimeString format="102">20260331</udt:DateTimeString></ram:EndDateTime>
      </ram:BillingSpecifiedPeriod>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime><udt:DateTimeString format="102">20260414</udt:DateTimeString></ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>157.88</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>157.88</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">24.00</ram:TaxTotalAmount>
        <ram:TaxTotalAmount currencyID="USD">26.10</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>181.88</ram:GrandTotalAmount>
        <ram:DuePayableAmount>181.88</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

/** A cross-border service invoice from an Irish supplier: category `AE` ("VAT reverse
 * charge"), rate 0, with the exemption reason EN 16931 requires for it. */
const REVERSE_CHARGE_CII_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocument>
    <ram:ID>ADS-2026-0630</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>Werbeplattform Ireland Ltd</ram:Name>
        <ram:PostalTradeAddress><ram:CityName>Dublin</ram:CityName><ram:CountryID>IE</ram:CountryID></ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">IE9692928F</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Itegro GmbH</ram:Name>
        <ram:PostalTradeAddress><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE987654321</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>0.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:ExemptionReason>Reverse charge</ram:ExemptionReason>
        <ram:BasisAmount>96.57</ram:BasisAmount>
        <ram:CategoryCode>AE</ram:CategoryCode>
        <ram:RateApplicablePercent>0</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>96.57</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>96.57</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">0.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>96.57</ram:GrandTotalAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

describe("extractZugferdInvoiceFields", () => {
  it("extracts invoice number, amount, currency, due date, IBAN, and both party names", () => {
    const result = extractZugferdInvoiceFields(MINIMAL_CII_INVOICE);
    expect(result).toEqual({
      invoiceNumber: "4711",
      totalAmountCents: 8368,
      currency: "EUR",
      dueDate: "2026-04-15",
      paymentIban: "DE89370400440532013000",
      sellerName: "Telekom Deutschland GmbH",
      buyerName: "Muster GmbH",
      sellerVatId: null,
      sellerCountry: null,
      buyerVatId: null,
      buyerCountry: null,
      taxBreakdown: null,
      netTotalCents: null,
      taxTotalCents: null,
      passThroughCents: null,
      reverseCharge: null,
      serviceDate: null,
      servicePeriodFrom: null,
      servicePeriodTo: null,
    });
  });

  // decisions/0080-ledger-double-entry-bookkeeping.md, phase 2.
  it("extracts one breakdown entry per tax category, the net/tax totals, the service period, and both parties' VAT ids", () => {
    const result = extractZugferdInvoiceFields(MIXED_RATE_CII_INVOICE);
    expect(result).toMatchObject({
      invoiceNumber: "RE-2026-0315",
      totalAmountCents: 18188,
      taxBreakdown: [
        { ratePercent: 19, netCents: 10788, taxCents: 2050 },
        { ratePercent: 7, netCents: 5000, taxCents: 350 },
      ],
      netTotalCents: 15788,
      // The invoice currency's TaxTotalAmount, not the USD accounting-currency one.
      taxTotalCents: 2400,
      passThroughCents: null,
      reverseCharge: false,
      serviceDate: "2026-03-15",
      servicePeriodFrom: "2026-03-01",
      servicePeriodTo: "2026-03-31",
      // `schemeID="VA"` only: the `FC` registration is the national tax number.
      sellerVatId: "DE123456789",
      sellerCountry: "DE",
      buyerVatId: "DE987654321",
      buyerCountry: "DE",
    });
  });

  it("flags reverse charge for an AE category and keeps its zero rate", () => {
    const result = extractZugferdInvoiceFields(REVERSE_CHARGE_CII_INVOICE);
    expect(result).toMatchObject({
      totalAmountCents: 9657,
      taxBreakdown: [{ ratePercent: 0, netCents: 9657, taxCents: 0 }],
      netTotalCents: 9657,
      taxTotalCents: 0,
      reverseCharge: true,
      sellerVatId: "IE9692928F",
      sellerCountry: "IE",
      buyerCountry: "DE",
    });
  });

  it("returns null for a document with no recognizable CII root", () => {
    expect(extractZugferdInvoiceFields("<Document><Foo>bar</Foo></Document>")).toBeNull();
  });

  it("returns null (never throws) for a malformed-but-not-malicious XML", () => {
    expect(extractZugferdInvoiceFields("<rsm:CrossIndustryInvoice><unterminated")).toBeNull();
  });

  it("throws UnsafeXmlError for a DOCTYPE-declaring attachment (XXE protection, never silently parsed)", () => {
    const malicious = `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rsm:CrossIndustryInvoice>&xxe;</rsm:CrossIndustryInvoice>`;
    expect(() => extractZugferdInvoiceFields(malicious)).toThrow();
  });

  it("returns null when the document has a CII root but none of the known fields", () => {
    const empty = `<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"></rsm:CrossIndustryInvoice>`;
    expect(extractZugferdInvoiceFields(empty)).toBeNull();
  });
});
