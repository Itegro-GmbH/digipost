// Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). The three shapes
// the export's workbook is written from. Both are already LOCALIZED and already resolved -
// the German labels, the generated name, and the ZIP path are decided before a row reaches
// the workbook writer, so that writer never needs translations or business rules of its own.

export type ClosingDocumentSheetRow = {
  /** `D-001`, this document's own number inside this workbook - what the "Buchungen" and
   * "Offene Posten" sheets point at (`core/cross-references.ts`). */
  reference: string;
  /** The effective date (decisions/0058/0060/0061), as a real date so Excel sorts and
   * filters it as one. */
  date: Date;
  /** The generated name (decisions/0059-generated-document-names.md), date half included. */
  name: string;
  counterparty: string;
  /** The document kind, translated ("Eingangsrechnung"). */
  kind: string;
  /** "Eingang"/"Ausgang"/"Unbekannt". */
  direction: string;
  /** In the document's own currency, as a real number so Excel can sum the column. `null`
   * when the document carries no amount at all (an empty cell, never a `0`). */
  amount: number | null;
  currency: string;
  invoiceNumber: string;
  /** The "Erledigung", translated: the effective payment status, except that a payment booked
   * after the Stichtag says so ("Zahlung nach Stichtag") and a clearing-account settlement
   * says how it was settled (`core/open-items.ts`). */
  settlement: string;
  /** "Zahlung(en)": every confirmed payment with the amount this document claims of it,
   * `B-003: 10,00 EUR`, or named by date when it is not a row of "Buchungen"
   * (`core/open-items.ts`'s `paymentsCell`); empty when there is none. */
  payments: string;
  /** The path of this document's own file inside the ZIP, exactly as the entry is written:
   * `ausgangsrechnungen/...` for a document the workspace issued, `belege/...` otherwise. */
  file: string;
};

export type ClosingTransactionSheetRow = {
  /** `B-001`. */
  reference: string;
  date: Date;
  account: string;
  /** Signed, in the transaction's currency, as a real number. */
  amount: number;
  currency: string;
  counterparty: string;
  purpose: string;
  /** WHICH documents settle this booking, the mirror of `matchedTransactions` above. */
  matchedDocuments: string;
  /** "zugeordnet" / "kein Beleg nötig" / "offen", already translated. */
  status: string;
};

/** One row of the "Offene Posten" sheet: a document of the period that was still unpaid, in
 * either direction, on the period's last day (`core/open-items.ts`). */
export type ClosingOpenItemSheetRow = {
  /** "Verbindlichkeit" / "Forderung", already translated. */
  type: string;
  /** The document's `D-001` on the "Belege" sheet. */
  documentReference: string;
  documentDate: Date;
  /** The generated document name, the same string the "Belege" sheet shows. */
  document: string;
  counterparty: string;
  documentAmount: number | null;
  /** What was open on the Stichtag, as a real number. */
  openAmount: number;
  currency: string;
  /** How it was settled since: `19.09.2026: 50,00 EUR`, plus what is still open today. */
  settledBy: string;
};
