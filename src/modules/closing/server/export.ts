import "server-only";

/**
 * Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). Assembles the
 * export: reads the period's two row sets, decides every document's file name inside the
 * archive ONCE (so the workbook's "Datei" column and the actual entry are the same string by
 * construction), writes `uebersicht.xlsx`, and returns the streaming body.
 *
 * Every German word arrives as a label from the caller (the route handler, which owns
 * next-intl) - this file formats, it does not translate.
 */
import type { ClosingDocumentRow, ClosingTransactionRow, DocumentDirection } from "@/persistence/repositories/contracts";

import { buildClosingCrossReferences, type ClosingReferenceLabels } from "../core/cross-references";
import { assignBelegFileNames, fileExtensionFor, OVERVIEW_FILE_NAME } from "../core/file-names";
import { closingDocumentName, closingDocumentNameSource, type ClosingNameLabels } from "../core/document-name";
import {
  buildClosingOpenItems,
  CLOSING_SETTLEMENT_TIMINGS,
  OPEN_ITEM_TYPES,
  paymentsCell,
  settlementTiming,
  type ClosingDatedPayment,
  type ClosingOpenItem,
  type ClosingPaymentAmount,
  type ClosingPaymentLabels,
} from "../core/open-items";
import type { ClosingPeriod } from "../core/period";
import type { ClosingDocumentSheetRow, ClosingOpenItemSheetRow, ClosingTransactionSheetRow } from "../core/types";

import { createClosingArchiveStream, type ClosingArchiveEntry } from "./export-archive";
import { buildClosingOverviewWorkbook, type ClosingSheetColumn } from "./export-workbook";
import { createClosingDocumentFileReader, getClosingExportData } from "./read-models";

export type ClosingExportLabels = {
  documentsSheetName: string;
  transactionsSheetName: string;
  openItemsSheetName: string;
  documentColumns: Record<keyof ClosingDocumentSheetRow, string>;
  transactionColumns: Record<keyof ClosingTransactionSheetRow, string>;
  openItemColumns: Record<keyof ClosingOpenItemSheetRow, string>;
  /** How a confirmed document with no "Nr." in this workbook is named on the "Buchungen"
   * sheet (`core/cross-references.ts`). */
  reference: ClosingReferenceLabels;
  /** How each payment is named in the "Belege" sheet's "Zahlung(en)" cell
   * (`core/open-items.ts`). */
  payment: ClosingPaymentLabels;
  /** The "Erledigung" values this export adds to `paymentStatus` below. */
  settlement: { afterPeriod: string; partlyAfterPeriod: string; settledViaClearing: string };
  /** "Verbindlichkeit" / "Forderung". */
  openItemType: { payable: string; receivable: string };
  /** The "Offene Posten" sheet's "Ausgeglichen" cell: one part per payment after the
   * Stichtag, plus the part still open today. */
  openItem: { paidOn: (payment: ClosingDatedPayment) => string; stillOpen: (amount: ClosingPaymentAmount) => string };
  /** `DocumentKinds.<kind>`. */
  documentKind: (kind: string) => string;
  /** `Inbox.directionValues.<direction>`; `null` has no label and stays an empty cell. */
  direction: (direction: DocumentDirection) => string;
  /** `Payments.statusValues.<status>`. */
  paymentStatus: (status: string) => string;
  /** The "Buchungen" sheet's own three-valued status column. */
  transactionStatus: { matched: string; noDocumentNeeded: string; open: string };
  /** Everything the generated document name needs (decisions/0059). */
  name: ClosingNameLabels;
};

// The key order of each record below is the sheet's column order.
const DOCUMENT_COLUMN_WIDTHS: Record<keyof ClosingDocumentSheetRow, number> = {
  reference: 8,
  date: 12,
  name: 40,
  counterparty: 30,
  kind: 20,
  direction: 12,
  amount: 14,
  currency: 10,
  invoiceNumber: 20,
  settlement: 26,
  payments: 40,
  file: 50,
};

const TRANSACTION_COLUMN_WIDTHS: Record<keyof ClosingTransactionSheetRow, number> = {
  reference: 8,
  date: 12,
  account: 24,
  amount: 14,
  currency: 10,
  counterparty: 30,
  purpose: 50,
  matchedDocuments: 28,
  status: 20,
};

const OPEN_ITEM_COLUMN_WIDTHS: Record<keyof ClosingOpenItemSheetRow, number> = {
  type: 16,
  documentReference: 8,
  documentDate: 12,
  document: 40,
  counterparty: 30,
  documentAmount: 14,
  openAmount: 16,
  currency: 10,
  settledBy: 40,
};

/** An ISO `YYYY-MM-DD` as a real date. Noon UTC, not midnight: a cell read back in a
 * timezone behind UTC would otherwise show the previous day. */
function isoToDate(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

function documentColumnType(key: keyof ClosingDocumentSheetRow): ClosingSheetColumn<ClosingDocumentSheetRow>["type"] {
  if (key === "date") return "date";
  if (key === "amount") return "number";
  return "text";
}

function transactionColumnType(key: keyof ClosingTransactionSheetRow): ClosingSheetColumn<ClosingTransactionSheetRow>["type"] {
  if (key === "date") return "date";
  if (key === "amount") return "number";
  return "text";
}

function openItemColumnType(key: keyof ClosingOpenItemSheetRow): ClosingSheetColumn<ClosingOpenItemSheetRow>["type"] {
  if (key === "documentDate") return "date";
  if (key === "documentAmount" || key === "openAmount") return "number";
  return "text";
}

function documentColumns(labels: ClosingExportLabels): ClosingSheetColumn<ClosingDocumentSheetRow>[] {
  return (Object.keys(DOCUMENT_COLUMN_WIDTHS) as (keyof ClosingDocumentSheetRow)[]).map((key) => ({
    header: labels.documentColumns[key],
    width: DOCUMENT_COLUMN_WIDTHS[key],
    type: documentColumnType(key),
    value: (row) => row[key],
  }));
}

function transactionColumns(labels: ClosingExportLabels): ClosingSheetColumn<ClosingTransactionSheetRow>[] {
  return (Object.keys(TRANSACTION_COLUMN_WIDTHS) as (keyof ClosingTransactionSheetRow)[]).map((key) => ({
    header: labels.transactionColumns[key],
    width: TRANSACTION_COLUMN_WIDTHS[key],
    type: transactionColumnType(key),
    value: (row) => row[key],
  }));
}

function openItemColumns(labels: ClosingExportLabels): ClosingSheetColumn<ClosingOpenItemSheetRow>[] {
  return (Object.keys(OPEN_ITEM_COLUMN_WIDTHS) as (keyof ClosingOpenItemSheetRow)[]).map((key) => ({
    header: labels.openItemColumns[key],
    width: OPEN_ITEM_COLUMN_WIDTHS[key],
    type: openItemColumnType(key),
    value: (row) => row[key],
  }));
}

/** The "Erledigung": a payment after the Stichtag says so first, because that is exactly
 * what the effective status ("Bezahlt") hides; a clearing-account settlement says how it was
 * settled; everything else is the payment status as the rest of the product shows it. */
function settlementLabel(document: ClosingDocumentRow, period: ClosingPeriod, labels: ClosingExportLabels): string {
  const timing = settlementTiming(document, period);
  if (timing === CLOSING_SETTLEMENT_TIMINGS.afterPeriod) return labels.settlement.afterPeriod;
  if (timing === CLOSING_SETTLEMENT_TIMINGS.partlyAfterPeriod) return labels.settlement.partlyAfterPeriod;
  if (document.paymentStatus === "settled") return labels.settlement.settledViaClearing;
  return labels.paymentStatus(document.paymentStatus);
}

function toDocumentSheetRow(
  document: ClosingDocumentRow,
  reference: string,
  name: string,
  settlement: string,
  payments: string,
  file: string,
  labels: ClosingExportLabels,
): ClosingDocumentSheetRow {
  return {
    reference,
    date: isoToDate(document.effectiveDate),
    // The generated name (decisions/0059), decided once per document and shared with the
    // "Zuordnungen" sheet so one document is never called two different things.
    name,
    counterparty: document.counterpartyName ?? document.sender ?? "",
    kind: labels.documentKind(document.kind),
    direction: document.direction ? labels.direction(document.direction) : "",
    amount: document.totalAmountCents === null ? null : document.totalAmountCents / 100,
    currency: document.totalAmountCents === null ? "" : (document.currency ?? "EUR"),
    invoiceNumber: document.invoiceNumber ?? "",
    settlement,
    payments,
    file,
  };
}

/** "zugeordnet" wins over "kein Beleg nötig": a transaction that actually has a confirmed
 * document is settled, whatever anyone marked earlier. */
function transactionStatus(transaction: ClosingTransactionRow, labels: ClosingExportLabels): string {
  if (transaction.confirmedDocuments.length > 0) return labels.transactionStatus.matched;
  if (transaction.noDocumentNeeded) return labels.transactionStatus.noDocumentNeeded;
  return labels.transactionStatus.open;
}

function toTransactionSheetRow(
  transaction: ClosingTransactionRow,
  reference: string,
  matchedDocuments: string,
  labels: ClosingExportLabels,
): ClosingTransactionSheetRow {
  return {
    reference,
    date: isoToDate(transaction.bookingDate),
    account: transaction.accountName,
    amount: transaction.amountCents / 100,
    currency: transaction.currency,
    counterparty: transaction.counterpartyName ?? "",
    purpose: transaction.remittanceText ?? "",
    matchedDocuments,
    status: transactionStatus(transaction, labels),
  };
}

function toOpenItemSheetRow(
  item: ClosingOpenItem,
  document: ClosingDocumentRow,
  reference: string,
  name: string,
  labels: ClosingExportLabels,
): ClosingOpenItemSheetRow {
  const settledBy = item.paidAfterPeriod.map((payment) => labels.openItem.paidOn(payment));
  if (item.stillOpenCents > 0) settledBy.push(labels.openItem.stillOpen({ amountCents: item.stillOpenCents, currency: item.currency }));
  return {
    type: item.type === OPEN_ITEM_TYPES.payable ? labels.openItemType.payable : labels.openItemType.receivable,
    documentReference: reference,
    documentDate: isoToDate(document.effectiveDate),
    document: name,
    counterparty: document.counterpartyName ?? document.sender ?? "",
    documentAmount: document.totalAmountCents === null ? null : document.totalAmountCents / 100,
    openAmount: item.openAtPeriodEndCents / 100,
    currency: item.currency,
    settledBy: settledBy.join(", "),
  };
}

/** `abschluss-2026-01.zip` / `abschluss-2026.zip`. */
export function closingExportFileName(period: ClosingPeriod): string {
  return `abschluss-${period.value}.zip`;
}

export type ClosingExport = {
  fileName: string;
  body: ReadableStream<Uint8Array>;
};

export async function createClosingExport(workspaceId: string, period: ClosingPeriod, labels: ClosingExportLabels): Promise<ClosingExport> {
  const { documents, transactions } = await getClosingExportData(workspaceId, period);

  // One decision, two consumers: the sheet's "Datei" column and the archive entry below are
  // both read out of this same map, so they cannot drift apart (decisions/0066). The folder
  // is part of that one decision too (`ausgangsrechnungen/` for a document the workspace
  // issued itself, `belege/` for everything else).
  const filesById = assignBelegFileNames(
    documents.map((document) => ({
      id: document.id,
      direction: document.direction,
      effectiveDate: document.effectiveDate,
      name: closingDocumentNameSource(document, labels.name),
      // A searchable PDF, when one exists, is always a PDF whatever the original was; only
      // the fallback keeps the original upload's own media type (a statement stays .xml or
      // .mt940, an app-store report .csv).
      extension: document.searchablePdfKey ? "pdf" : fileExtensionFor(document.mimeType, document.originalFileName),
    })),
  );

  // Likewise one decision, three consumers: the "Zahlung(en)" cells, the "Buchungen" sheet's
  // cross references and the "Offene Posten" sheet all read their numbers out of this one
  // result, so a "Nr." can never mean two different rows (decisions/0066).
  const crossReferences = buildClosingCrossReferences({
    period: { from: period.from, to: period.to },
    documents,
    transactions,
    labels: labels.reference,
  });
  const documentNames = new Map(documents.map((document) => [document.id, closingDocumentName(document, labels.name)]));
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const openItems = buildClosingOpenItems(documents, period);

  const overview = await buildClosingOverviewWorkbook(
    {
      name: labels.documentsSheetName,
      columns: documentColumns(labels),
      rows: documents.map((document) =>
        toDocumentSheetRow(
          document,
          crossReferences.documentReferences.get(document.id) ?? "",
          documentNames.get(document.id) ?? "",
          settlementLabel(document, period, labels),
          paymentsCell(document, period, crossReferences.transactionReferences, labels.payment),
          filesById.get(document.id) ?? "",
          labels,
        ),
      ),
    },
    {
      name: labels.transactionsSheetName,
      columns: transactionColumns(labels),
      rows: transactions.map((transaction) =>
        toTransactionSheetRow(
          transaction,
          crossReferences.transactionReferences.get(transaction.id) ?? "",
          crossReferences.documentsOfTransaction.get(transaction.id) ?? "",
          labels,
        ),
      ),
    },
    {
      name: labels.openItemsSheetName,
      columns: openItemColumns(labels),
      rows: openItems.map((item) =>
        toOpenItemSheetRow(
          item,
          documentsById.get(item.documentId)!,
          crossReferences.documentReferences.get(item.documentId) ?? "",
          documentNames.get(item.documentId) ?? "",
          labels,
        ),
      ),
    },
  );

  // Captured before the response starts streaming - see `createClosingDocumentFileReader`.
  const readDocumentFile = createClosingDocumentFileReader();

  async function* entries(): AsyncIterable<ClosingArchiveEntry> {
    yield { name: OVERVIEW_FILE_NAME, bytes: overview };
    for (const document of documents) {
      const name = filesById.get(document.id);
      if (!name) continue;
      const bytes = await readDocumentFile(workspaceId, document.id);
      // A document whose object has gone missing from storage is skipped rather than
      // failing the whole export - the workbook row still names it, and the advisor can see
      // which file is absent. Nothing else in this product deletes an object behind a row,
      // so this is a corruption guard, not an expected path.
      if (!bytes) continue;
      yield { name, bytes };
    }
  }

  return { fileName: closingExportFileName(period), body: createClosingArchiveStream(entries) };
}
