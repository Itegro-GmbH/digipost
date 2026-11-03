import { inflateRawSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import type { ClosingDocumentRow, ClosingTransactionRow } from "@/persistence/repositories/contracts";

import { parseClosingPeriod } from "../core/period";
import type { ClosingExportLabels } from "../server/export";

const documents: ClosingDocumentRow[] = [
  {
    id: "a1b2c3d4-0000-0000-0000-000000000001",
    effectiveDate: "2026-01-15",
    originalFileName: "Rn_42_Bauwerk Generalbau München.pdf",
    mimeType: "application/pdf",
    searchablePdfKey: "workspaces/w/documents/a/searchable.pdf",
    kind: "incoming_invoice",
    platform: null,
    direction: "incoming",
    documentDate: "2026-01-15",
    sender: null,
    counterpartyName: "Bauwerk Generalbau GmbH",
    reportPeriod: null,
    statementLastBooking: null,
    invoiceNumber: "RE-42",
    totalAmountCents: 119000,
    currency: "EUR",
    paymentStatus: "open",
    // Settled by a booking that is IN the period (`cc...`, below) and by one that is not
    // (a December booking, which has no row and so no "Nr." in this workbook).
    confirmedTransactions: [
      { id: "cc000000-0000-0000-0000-000000000003", bookingDate: "2026-01-18", amountCents: -119000, currency: "EUR", allocatedAmountCents: 119000 },
      { id: "ee000000-0000-0000-0000-000000000009", bookingDate: "2025-12-14", amountCents: -2300, currency: "EUR", allocatedAmountCents: 2300 },
    ],
  },
  {
    id: "bb77ee10-0000-0000-0000-000000000002",
    effectiveDate: "2026-01-20",
    originalFileName: "camt053.xml",
    mimeType: "application/xml",
    // Never OCR'd, so no searchable PDF: the original XML is what the export keeps.
    searchablePdfKey: null,
    kind: "bank_statement",
    platform: null,
    direction: null,
    documentDate: null,
    sender: null,
    counterpartyName: null,
    reportPeriod: null,
    statementLastBooking: "2026-01-20",
    invoiceNumber: null,
    totalAmountCents: null,
    currency: null,
    paymentStatus: "not_applicable",
    confirmedTransactions: [],
  },
  // decisions/0066: evidence the workspace ISSUED, which lands in its own folder.
  {
    id: "cafe0001-0000-0000-0000-000000000005",
    effectiveDate: "2026-01-25",
    originalFileName: "ausgangsrechnung-7.pdf",
    mimeType: "application/pdf",
    searchablePdfKey: null,
    kind: "outgoing_invoice",
    platform: null,
    direction: "outgoing",
    documentDate: "2026-01-25",
    sender: null,
    counterpartyName: "Kunde AG",
    reportPeriod: null,
    statementLastBooking: null,
    invoiceNumber: "AR-7",
    totalAmountCents: 50000,
    currency: "EUR",
    paymentStatus: "paid",
    // The customer paid on 3 February: still owed to the workspace on the January Stichtag.
    confirmedTransactions: [
      { id: "aa000000-0000-0000-0000-000000000012", bookingDate: "2026-02-03", amountCents: 50000, currency: "EUR", allocatedAmountCents: 50000 },
    ],
  },
  // An incoming invoice paid after the Stichtag: still owed BY the workspace on 31 January.
  {
    id: "dddd0004-0000-0000-0000-000000000013",
    effectiveDate: "2026-01-28",
    originalFileName: "stadtwerke.pdf",
    mimeType: "application/pdf",
    searchablePdfKey: null,
    kind: "incoming_invoice",
    platform: null,
    direction: "incoming",
    documentDate: "2026-01-28",
    sender: null,
    counterpartyName: "Stadtwerke",
    reportPeriod: null,
    statementLastBooking: null,
    invoiceNumber: "SW-1",
    totalAmountCents: 8000,
    currency: "EUR",
    paymentStatus: "paid",
    confirmedTransactions: [
      { id: "bb000000-0000-0000-0000-000000000014", bookingDate: "2026-02-10", amountCents: -8000, currency: "EUR", allocatedAmountCents: 8000 },
    ],
  },
];

const transactions: ClosingTransactionRow[] = [
  {
    id: "cc000000-0000-0000-0000-000000000003",
    bookingDate: "2026-01-18",
    accountName: "Geschäftskonto",
    amountCents: -119000,
    currency: "EUR",
    counterpartyName: "Bauwerk Generalbau GmbH",
    remittanceText: "RE-42",
    noDocumentNeeded: false,
    confirmedDocuments: [
      { id: "a1b2c3d4-0000-0000-0000-000000000001", effectiveDate: "2026-01-15", amountCents: 119000, currency: "EUR", allocatedAmountCents: 119000 },
    ],
  },
  {
    id: "dd000000-0000-0000-0000-000000000004",
    bookingDate: "2026-01-19",
    accountName: "Geschäftskonto",
    amountCents: -450,
    currency: "EUR",
    counterpartyName: "Bank",
    remittanceText: "Kontoführung",
    noDocumentNeeded: true,
    confirmedDocuments: [],
  },
  // Settled by a document from BEFORE the period: the invoice has no "Nr." here either.
  {
    id: "ff000000-0000-0000-0000-000000000010",
    bookingDate: "2026-01-29",
    accountName: "Geschäftskonto",
    amountCents: -2300,
    currency: "EUR",
    counterpartyName: "Stadtwerke",
    remittanceText: "Abschlag Dezember",
    noDocumentNeeded: false,
    confirmedDocuments: [
      { id: "99999999-0000-0000-0000-000000000011", effectiveDate: "2025-12-14", amountCents: 2300, currency: "EUR", allocatedAmountCents: 2300 },
    ],
  },
];

const fileBytes = new Map<string, Uint8Array>([
  [documents[0]!.id, new TextEncoder().encode("%PDF-1.7 rechnung")],
  [documents[1]!.id, new TextEncoder().encode("<Document/>")],
  [documents[2]!.id, new TextEncoder().encode("%PDF-1.7 ausgangsrechnung")],
  [documents[3]!.id, new TextEncoder().encode("%PDF-1.7 stadtwerke")],
]);

vi.mock("../server/read-models", () => ({
  getClosingExportData: async () => ({ documents, transactions }),
  createClosingDocumentFileReader: () => async (_workspaceId: string, documentId: string) => fileBytes.get(documentId) ?? null,
}));

const labels: ClosingExportLabels = {
  documentsSheetName: "Belege",
  transactionsSheetName: "Buchungen",
  openItemsSheetName: "Offene Posten",
  documentColumns: {
    reference: "Nr.",
    date: "Datum",
    name: "Name",
    counterparty: "Gegenpartei",
    kind: "Art",
    direction: "Richtung",
    amount: "Betrag",
    currency: "Währung",
    invoiceNumber: "Rechnungsnummer",
    settlement: "Erledigung",
    payments: "Zahlung(en)",
    file: "Datei",
  },
  transactionColumns: {
    reference: "Nr.",
    date: "Datum",
    account: "Konto",
    amount: "Betrag",
    currency: "Währung",
    counterparty: "Gegenpartei",
    purpose: "Verwendungszweck",
    matchedDocuments: "Zugeordnete Belege",
    status: "Status",
  },
  openItemColumns: {
    type: "Art",
    documentReference: "Beleg-Nr.",
    documentDate: "Belegdatum",
    document: "Beleg",
    counterparty: "Gegenpartei",
    documentAmount: "Belegbetrag",
    openAmount: "Offen zum Stichtag",
    currency: "Währung",
    settledBy: "Ausgeglichen",
  },
  // The real route formats these with `Intl`; the test only needs them distinguishable.
  reference: {
    outsidePeriod: ({ isoDate, amountCents }) => `außerhalb des Zeitraums (${isoDate}, ${amountCents ?? "-"})`,
    notListed: ({ isoDate, amountCents }) => `nicht in dieser Übersicht (${isoDate}, ${amountCents ?? "-"})`,
  },
  payment: {
    listed: (reference, { amountCents }) => `${reference}: ${amountCents}`,
    beforePeriod: ({ isoDate, amountCents }) => `vor dem Zeitraum (${isoDate}, ${amountCents})`,
    afterPeriod: ({ isoDate, amountCents }) => `nach Stichtag (${isoDate}, ${amountCents})`,
    notListed: ({ isoDate, amountCents }) => `nicht in dieser Übersicht (${isoDate}, ${amountCents})`,
  },
  settlement: { afterPeriod: "Zahlung nach Stichtag", partlyAfterPeriod: "Teils nach Stichtag bezahlt", settledViaClearing: "Über Verrechnungskonto erledigt" },
  openItemType: { payable: "Verbindlichkeit", receivable: "Forderung" },
  openItem: {
    paidOn: ({ isoDate, amountCents }) => `${isoDate}: ${amountCents}`,
    stillOpen: ({ amountCents }) => `noch offen: ${amountCents}`,
  },
  transactionStatus: { matched: "zugeordnet", noDocumentNeeded: "kein Beleg nötig", open: "offen" },
  documentKind: (kind) => kind,
  direction: (direction) => direction,
  paymentStatus: (status) => status,
  name: {
    platformLabel: (platform) => platform,
    bankStatementLabel: "Kontoauszug",
    receivedOnLabel: (formattedDate) => `Eingang ${formattedDate}`,
    formatDate: (isoDate) => isoDate.split("-").reverse().join("."),
    formatMonth: (isoMonth) => isoMonth,
  },
};

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe("createClosingExport", () => {
  it("names the archive after the period", async () => {
    const { createClosingExport } = await import("../server/export");
    const month = await createClosingExport("w1", parseClosingPeriod("2026-01")!, labels);
    expect(month.fileName).toBe("abschluss-2026-01.zip");
    await collect(month.body);

    const year = await createClosingExport("w1", parseClosingPeriod("2026")!, labels);
    expect(year.fileName).toBe("abschluss-2026.zip");
    await collect(year.body);
  });

  it("writes every document's own file, with the extension its media type calls for", async () => {
    const { createClosingExport } = await import("../server/export");
    const { body } = await createClosingExport("w1", parseClosingPeriod("2026-01")!, labels);
    const zip = await collect(body);

    expect(zip.includes("uebersicht.xlsx")).toBe(true);
    // A searchable PDF exists for the invoice, so it is a .pdf; the statement was never
    // OCR'd and keeps its own .xml (decisions/0066: not everything is a PDF).
    expect(zip.includes("belege/2026-01-15_Bauwerk-Generalbau_a1b2c3d4.pdf")).toBe(true);
    expect(zip.includes("belege/2026-01-20_Kontoauszug_bb77ee10.xml")).toBe(true);
    // Evidence the workspace issued itself is in its own folder, not among the receipts.
    expect(zip.includes("ausgangsrechnungen/2026-01-25_Kunde_cafe0001.pdf")).toBe(true);
    expect(zip.includes("belege/2026-01-25_Kunde_cafe0001.pdf")).toBe(false);
  });

  it("writes the exact same path into the workbook's 'Datei' column as into the archive", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const { createClosingExport } = await import("../server/export");
    const { body } = await createClosingExport("w1", parseClosingPeriod("2026-01")!, labels);
    const zip = await collect(body);

    const entries = readZipEntries(zip);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(entries.get("uebersicht.xlsx")! as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet("Belege")!;

    const headers = sheet.getRow(1).values as (string | undefined)[];
    const fileColumn = headers.indexOf("Datei");
    expect(fileColumn).toBeGreaterThan(0);

    const archivePaths = [...entries.keys()].filter((name) => name !== "uebersicht.xlsx").sort();
    const cellPaths: string[] = [];
    for (let row = 2; row <= sheet.rowCount; row += 1) cellPaths.push(String(sheet.getRow(row).getCell(fileColumn).value));

    expect(cellPaths.sort()).toEqual(archivePaths);
    // And the rows themselves carry the generated name and a real number, not a string.
    expect(sheet.getRow(2).getCell(headers.indexOf("Name")).value).toBe("Bauwerk Generalbau, 15.01.2026");
    expect(sheet.getRow(2).getCell(headers.indexOf("Betrag")).value).toBe(1190);
    expect(sheet.getRow(3).getCell(headers.indexOf("Name")).value).toBe("Kontoauszug, 20.01.2026");
  });

  it("gives every row a Nr. and names every payment with its amount", async () => {
    const sheets = await exportedWorkbook();
    const documentsSheet = readSheet(sheets, "Belege");
    const transactionsSheet = readSheet(sheets, "Buchungen");

    expect(documentsSheet.rows.map((row) => row["Nr."])).toEqual(["D-001", "D-002", "D-003", "D-004"]);
    expect(transactionsSheet.rows.map((row) => row["Nr."])).toEqual(["B-001", "B-002", "B-003"]);

    // The invoice is settled by a booking of this period AND by one from December, which has
    // no row here: it is named by its date rather than dropped, each with its own amount.
    expect(documentsSheet.rows[0]!["Zahlung(en)"]).toBe("B-001: 119000, vor dem Zeitraum (2025-12-14, 2300)");
    expect(documentsSheet.rows[0]!.Erledigung).toBe("open");
    // Nothing assigned is an empty cell, never a 0 that reads like an amount.
    expect(documentsSheet.rows[1]!["Zahlung(en)"]).toBe("");
    // Paid after the Stichtag: the effective status alone ("paid") would hide exactly that.
    expect(documentsSheet.rows[2]!["Zahlung(en)"]).toBe("nach Stichtag (2026-02-03, 50000)");
    expect(documentsSheet.rows[2]!.Erledigung).toBe("Zahlung nach Stichtag");

    expect(transactionsSheet.rows[0]!["Zugeordnete Belege"]).toBe("D-001");
    expect(transactionsSheet.rows[0]!.Status).toBe("zugeordnet");
    expect(transactionsSheet.rows[2]!["Zugeordnete Belege"]).toBe("außerhalb des Zeitraums (2025-12-14, 2300)");

    // Every "Nr." a cell points at resolves to a row of the sheet it names.
    const documentNumbers = new Set(documentsSheet.rows.map((row) => row["Nr."]));
    const transactionNumbers = new Set(transactionsSheet.rows.map((row) => row["Nr."]));
    for (const cell of documentsSheet.rows.map((row) => row["Zahlung(en)"])) {
      for (const reference of cell.split(", ").map((part) => part.split(":")[0]!).filter((part) => /^B-\d+$/.test(part))) {
        expect(transactionNumbers.has(reference)).toBe(true);
      }
    }
    for (const cell of transactionsSheet.rows.map((row) => row["Zugeordnete Belege"])) {
      for (const reference of cell.split(", ").filter((part) => /^D-\d+$/.test(part))) expect(documentNumbers.has(reference)).toBe(true);
    }
  });

  it("writes an Offene Posten sheet with what was still owed on the Stichtag, payables first", async () => {
    const sheets = await exportedWorkbook();
    const openItems = readSheet(sheets, "Offene Posten");

    expect(sheets.worksheets.map((sheet) => sheet.name)).toEqual(["Belege", "Buchungen", "Offene Posten"]);
    expect(openItems.headers).toEqual([
      "Art",
      "Beleg-Nr.",
      "Belegdatum",
      "Beleg",
      "Gegenpartei",
      "Belegbetrag",
      "Offen zum Stichtag",
      "Währung",
      "Ausgeglichen",
    ]);

    // The open invoice D-001 is fully allocated and the bank statement D-002 owes nothing:
    // only the two documents paid after the Stichtag are left.
    expect(openItems.rows).toHaveLength(2);
    expect(openItems.rows[0]).toMatchObject({
      Art: "Verbindlichkeit",
      "Beleg-Nr.": "D-004",
      Gegenpartei: "Stadtwerke",
      Belegbetrag: 80,
      "Offen zum Stichtag": 80,
      Währung: "EUR",
      Ausgeglichen: "2026-02-10: 8000",
    });
    expect(openItems.rows[1]).toMatchObject({
      Art: "Forderung",
      "Beleg-Nr.": "D-003",
      Beleg: "Kunde, 25.01.2026",
      "Offen zum Stichtag": 500,
      Ausgeglichen: "2026-02-03: 50000",
    });
    // A real date, not a string.
    expect(openItems.raw.getRow(2).getCell(3).value).toBeInstanceOf(Date);
  });
});

/** The archive's `uebersicht.xlsx`, read back out of the stream the export produced. */
async function exportedWorkbook(): Promise<import("exceljs").Workbook> {
  const ExcelJS = (await import("exceljs")).default;
  const { createClosingExport } = await import("../server/export");
  const { body } = await createClosingExport("w1", parseClosingPeriod("2026-01")!, labels);
  const entries = readZipEntries(await collect(body));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(entries.get("uebersicht.xlsx")! as unknown as ArrayBuffer);
  return workbook;
}

type ReadSheet = { headers: string[]; rows: Record<string, string>[]; raw: import("exceljs").Worksheet };

/** One sheet as plain header-keyed rows - every cell as the string Excel would show, except
 * that a real number stays a number so a formatting regression cannot pass unnoticed. */
function readSheet(workbook: import("exceljs").Workbook, name: string): ReadSheet {
  const sheet = workbook.getWorksheet(name)!;
  const headers = (sheet.getRow(1).values as (string | undefined)[]).slice(1).map((header) => String(header));
  const rows: Record<string, string>[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const entry: Record<string, string> = {};
    headers.forEach((header, index) => {
      const value = row.getCell(index + 1).value;
      entry[header] = (value === null || value === undefined ? "" : value) as string;
    });
    rows.push(entry);
  }
  return { headers, rows, raw: sheet };
}

/**
 * A minimal ZIP reader for this test only: archiver streams, so the local headers carry no
 * sizes (bit 3, data descriptors) and the central directory is the only place that does.
 * This walks the central directory, then inflates each entry from its local header offset.
 */
function readZipEntries(zip: Buffer): Map<string, Buffer> {
  const CENTRAL_SIGNATURE = 0x02014b50;
  const entries = new Map<string, Buffer>();

  for (let at = 0; at + 46 <= zip.length; at += 1) {
    if (zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) continue;
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");

    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));

    at += 45 + nameLength + extraLength + commentLength;
  }

  return entries;
}
