// Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). The link between
// a document and a booking, made readable: who is "D-001", who is "B-012", which of them
// belong together, and how a confirmed counterpart that has no row in this workbook at all is
// named instead of silently dropped.
//
// The document side's own cell ("Zahlung(en)") is not built here: it names each payment with
// its amount and its timing against the period end, which is `core/open-items.ts`'s job.
// This file only numbers the rows and fills the "Buchungen" sheet's "Zugeordnete Belege".
//
// Pure and synchronous: no I/O, no locale. Every German word arrives as a label from the
// caller, exactly like the rest of this module's core.
//
// Why a counterpart can be missing from the workbook:
//   1. it lies OUTSIDE the exported period - a January booking settling a December invoice is
//      an ordinary, correct pairing, and the December invoice is simply not in this export;
//   2. it lies inside the period but is not a row of this workbook anyway - today only a
//      transaction on a clearing account, which the "Buchungen" sheet deliberately omits (an
//      in-app purchase per 0,79 EUR sale would bury the real bank movements, see
//      `accounts-repository.ts`'s `listForPeriod`).
// Those two are different statements, so they get two different labels. A bare empty cell,
// which is what a plain reference lookup would produce, would be the one wrong answer: it
// would read as "nothing is assigned here".

/** `D-001` on the "Dokumente" sheet. */
export const DOCUMENT_REFERENCE_PREFIX = "D";
/** `B-001` on the "Buchungen" sheet. */
export const TRANSACTION_REFERENCE_PREFIX = "B";

/** Zero-padded to three digits, which covers a small business's year without ever truncating
 * a bigger one: row 1000 is simply `D-1000`. */
export function closingReference(prefix: string, rowIndex: number): string {
  return `${prefix}-${String(rowIndex + 1).padStart(3, "0")}`;
}

/** How several references share one cell. */
const REFERENCE_SEPARATOR = ", ";

export type CrossReferenceCounterpart = {
  /** ISO `YYYY-MM-DD`: the transaction's booking date, or the document's effective date. */
  isoDate: string;
  /** `null` only for a document that carries no amount at all. */
  amountCents: number | null;
  currency: string | null;
};

/** The two ways a counterpart with no "Nr." in this workbook is named. Both are given the
 * counterpart's own date and amount, which is all the advisor needs to find it. */
export type ClosingReferenceLabels = {
  /** Its own date lies outside the exported period. */
  outsidePeriod: (counterpart: CrossReferenceCounterpart) => string;
  /** Its date lies inside the period, but it is not a row of this workbook. */
  notListed: (counterpart: CrossReferenceCounterpart) => string;
};

export type CrossReferenceLinkedDocument = {
  id: string;
  effectiveDate: string;
  amountCents: number | null;
  currency: string | null;
  allocatedAmountCents: number;
};

/** The subset of `ClosingDocumentRow` this file reads - a structural subset on purpose, so
 * the whole thing stays testable with a one-line literal. */
export type CrossReferenceDocument = {
  id: string;
};

/** The subset of `ClosingTransactionRow` this file reads. */
export type CrossReferenceTransaction = {
  id: string;
  bookingDate: string;
  amountCents: number;
  currency: string;
  confirmedDocuments: CrossReferenceLinkedDocument[];
};

export type ClosingCrossReferences = {
  /** Document id -> `D-001`, for every document this workbook lists. */
  documentReferences: Map<string, string>;
  /** Transaction id -> `B-001`, for every transaction this workbook lists. */
  transactionReferences: Map<string, string>;
  /** Transaction id -> the "Zugeordnete Belege" cell: `D-004, D-007`, a label for a
   * counterpart with no row here, or `""` when the booking has no confirmed document at all. */
  documentsOfTransaction: Map<string, string>;
};

export type ClosingPeriodBounds = { from: string; to: string };

function isInPeriod(isoDate: string, period: ClosingPeriodBounds): boolean {
  return isoDate >= period.from && isoDate <= period.to;
}

function describe(counterpart: CrossReferenceCounterpart, period: ClosingPeriodBounds, labels: ClosingReferenceLabels): string {
  return isInPeriod(counterpart.isoDate, period) ? labels.notListed(counterpart) : labels.outsidePeriod(counterpart);
}

export function buildClosingCrossReferences(input: {
  period: ClosingPeriodBounds;
  documents: CrossReferenceDocument[];
  transactions: CrossReferenceTransaction[];
  labels: ClosingReferenceLabels;
}): ClosingCrossReferences {
  const { period, documents, transactions, labels } = input;

  const documentReferences = new Map(documents.map((document, index) => [document.id, closingReference(DOCUMENT_REFERENCE_PREFIX, index)]));
  const transactionReferences = new Map(
    transactions.map((transaction, index) => [transaction.id, closingReference(TRANSACTION_REFERENCE_PREFIX, index)]),
  );

  const documentsOfTransaction = new Map<string, string>();
  for (const transaction of transactions) {
    const cells = transaction.confirmedDocuments.map(
      (link) =>
        documentReferences.get(link.id) ??
        describe({ isoDate: link.effectiveDate, amountCents: link.amountCents, currency: link.currency }, period, labels),
    );
    documentsOfTransaction.set(transaction.id, cells.join(REFERENCE_SEPARATOR));
  }

  return { documentReferences, transactionReferences, documentsOfTransaction };
}
