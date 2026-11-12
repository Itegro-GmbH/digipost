// @vitest-environment jsdom
// "Abgleich Steuerberaterin" (decisions/0080 acceptance test): per account Digipost, the tax
// advisor and the difference; a differing account opens to Digipost's own lines; the upload
// sends the CSV text and the period.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import de from "@/i18n/messages/de.json";
import type { AccountSheetRow, AdvisorComparisonRow } from "@/modules/ledger";

const uploadMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("../actions", () => ({
  uploadAdvisorBalancesAction: (input: unknown) => uploadMock(input),
  deleteAdvisorUploadAction: (input: unknown) => deleteMock(input),
}));
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock, refresh: vi.fn() }) }));

import { AdvisorComparisonTable, AdvisorUploadForm, AdvisorUploadsList } from "../ui/advisor-comparison";

const ROWS: AdvisorComparisonRow[] = [
  { accountNumber: "1406", name: "Abziehbare Vorsteuer 19 %", oursCents: 23110, theirsCents: 23253, differenceCents: -143 },
  { accountNumber: "1800", name: "Finom", oursCents: 841207, theirsCents: 846207, differenceCents: -5000 },
  { accountNumber: "2900", name: "Gezeichnetes Kapital", oursCents: -1250100, theirsCents: -1250100, differenceCents: 0 },
];
const SHEET_LINE: AccountSheetRow = {
  lineId: "l1",
  entryId: "e1",
  bookingDate: "2026-08-19",
  text: "Google Ads Abbuchung",
  amountCents: -5000,
  runningBalanceCents: 841207,
  counterAccountNumbers: ["1462"],
  taxCode: null,
  taxRole: null,
  documentId: null,
  transactionId: "t1",
  proposed: false,
};

function wrap(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="de" messages={{ Ledger: de.Ledger }} timeZone="Europe/Berlin">
      {node}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  uploadMock.mockResolvedValue({ status: "success", data: { id: "u-1" } });
  deleteMock.mockResolvedValue({ status: "success", data: undefined });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdvisorComparisonTable", () => {
  it("shows both balances with S or H and the difference per account", () => {
    wrap(<AdvisorComparisonTable rows={ROWS} sheetLines={{ "1800": [SHEET_LINE] }} sheetQuery="?von=2026-07-01&bis=2026-09-30" />);
    const capital = screen.getByText("Gezeichnetes Kapital").closest('[role="row"]') as HTMLElement;
    expect(within(capital).getAllByText(/12\.501,00\s€ H/)).toHaveLength(2);
    expect(within(capital).getByLabelText("Stimmt überein")).toBeTruthy();
    expect(capital.closest("details")).toBeNull();
  });

  it("opens a differing account to Digipost's own lines and its Kontenblatt", () => {
    const { container } = wrap(<AdvisorComparisonTable rows={ROWS} sheetLines={{ "1800": [SHEET_LINE] }} sheetQuery="?von=2026-07-01&bis=2026-09-30" />);
    const bank = container.querySelector('details[data-account="1800"]') as HTMLElement;
    expect(within(bank).getByText(/-50,00/)).toBeTruthy();
    expect(within(bank).getByRole("link", { name: "Google Ads Abbuchung" }).getAttribute("href")).toBe("/dashboard/buchhaltung/buchung/e1");
    expect(within(bank).getByRole("link", { name: "Kontenblatt öffnen" }).getAttribute("href")).toBe("/dashboard/buchhaltung/konten/1800?von=2026-07-01&bis=2026-09-30");
    const tax = container.querySelector('details[data-account="1406"]') as HTMLElement;
    expect(within(tax).getByText(de.Ledger.advisor.noLines)).toBeTruthy();
  });
});

describe("AdvisorUploadForm", () => {
  it("sends the file's text with the period and opens the comparison", async () => {
    wrap(<AdvisorUploadForm defaultFrom="2026-07-01" defaultTo="2026-09-30" />);
    const submit = screen.getByRole("button", { name: "Hochladen und vergleichen" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    const file = new File(["Konto;Beschriftung;Saldo\n1800;Bank;100,00 S\n"], "SuSa_Q3.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Datei"), { target: { files: [file] } });
    await act(async () => fireEvent.click(submit));
    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    expect(uploadMock).toHaveBeenCalledWith({ periodFrom: "2026-07-01", periodTo: "2026-09-30", fileName: "SuSa_Q3.csv", csvText: "Konto;Beschriftung;Saldo\n1800;Bank;100,00 S\n" });
    expect(pushMock).toHaveBeenCalledWith("/dashboard/buchhaltung/auswertungen/abgleich?upload=u-1");
  });

  it("explains an unreadable file", async () => {
    uploadMock.mockResolvedValue({ status: "error", errorCode: "advisor_file_invalid" });
    wrap(<AdvisorUploadForm defaultFrom="2026-07-01" defaultTo="2026-09-30" />);
    fireEvent.change(screen.getByLabelText("Datei"), { target: { files: [new File(["x"], "a.csv")] } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Hochladen und vergleichen" })));
    expect((await screen.findByRole("alert")).textContent).toBe(de.Ledger.errors.advisor_file_invalid);
  });
});

describe("AdvisorUploadsList", () => {
  it("deletes an upload after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    wrap(<AdvisorUploadsList uploads={[{ id: "u-1", periodFrom: "2026-07-01", periodTo: "2026-09-30", fileName: "SuSa_Q3.csv", uploadedAt: "2026-10-05T08:00:00.000Z", lineCount: 34 }]} selectedId="u-1" canManage />);
    expect(screen.getByText("3. Quartal 2026")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Löschen" })));
    expect(deleteMock).toHaveBeenCalledWith({ uploadId: "u-1" });
    expect(pushMock).toHaveBeenCalledWith("/dashboard/buchhaltung/auswertungen/abgleich");
  });
});
