// @vitest-environment jsdom
// "Zeiträume und Meldungen" (decisions/0080 UI concept C, screens H and I): the filing confirm
// card needs the explicit checkbox, names how many entries it locks, warns (never blocks) on a
// Zahllast that differs from the preview, creates the draft and submits it; a submitted period
// offers the correction guide; the handover is a marker with a note.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import de from "@/i18n/messages/de.json";
import type { FilingView } from "@/modules/ledger";

const createFilingMock = vi.fn();
const submitFilingMock = vi.fn();
const correctionMock = vi.fn();
const handoverMock = vi.fn();
vi.mock("../actions", () => ({
  createFilingAction: (input: unknown) => createFilingMock(input),
  submitFilingAction: (input: unknown) => submitFilingMock(input),
  createCorrectionFilingAction: (input: unknown) => correctionMock(input),
  createHandoverAction: (input: unknown) => handoverMock(input),
}));
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: refreshMock }) }));

import { PeriodsClient, type FilingPeriodView } from "../ui/periods-client";

const SUBMITTED: FilingView = { id: "f-q2", kind: "vat_return", status: "submitted", periodFrom: "2026-04-01", periodTo: "2026-06-30", submittedOn: "2026-07-08", amountCents: 1240, correctsFilingId: null, note: null, createdAt: "2026-07-08T09:00:00.000Z" };

function period(overrides: Partial<FilingPeriodView>): FilingPeriodView {
  return {
    key: "2026-Q3",
    kind: "vat_return",
    from: "2026-07-01",
    to: "2026-09-30",
    status: "ready",
    bookedCount: 52,
    proposedCount: 2,
    previewPayableCents: -2371,
    handover: null,
    submitted: null,
    original: null,
    draft: null,
    ...overrides,
  };
}
const ANNUAL = period({ key: "2026", kind: "annual_statement", from: "2026-01-01", to: "2026-12-31", status: null, bookedCount: 140, proposedCount: 3, previewPayableCents: null });

function renderPeriods(periods: FilingPeriodView[]) {
  return render(
    <NextIntlClientProvider locale="de" messages={{ Ledger: de.Ledger }} timeZone="Europe/Berlin">
      <PeriodsClient periods={periods} annual={ANNUAL} today="2026-11-12" canManage />
    </NextIntlClientProvider>,
  );
}

function row(key: string) {
  return document.querySelector(`li[data-period="${key}"]`) as HTMLElement;
}

beforeEach(() => {
  createFilingMock.mockResolvedValue({ status: "success", data: { id: "draft-1" } });
  submitFilingMock.mockResolvedValue({ status: "success", data: { id: "draft-1" } });
  correctionMock.mockResolvedValue({ status: "success", data: { id: "corr-1" } });
  handoverMock.mockResolvedValue({ status: "success", data: { id: "h-1" } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the filing confirm card", () => {
  it("names how many entries it locks and needs the checkbox", async () => {
    renderPeriods([period({})]);
    fireEvent.click(within(row("2026-Q3")).getByRole("button", { name: "Als eingereicht markieren" }));
    const card = screen.getByRole("alertdialog");
    expect(within(card).getByTestId("filing-lock-count").textContent).toBe("52 gebuchte Buchungen aus 3. Quartal 2026 werden gesperrt.");
    expect(within(card).getByText(/2 Vorschläge sind noch nicht gebucht/)).toBeTruthy();
    const submit = within(card).getByRole("button", { name: "Als eingereicht markieren" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(card).getByRole("checkbox", { name: "Ich habe die Meldung beim Finanzamt abgegeben." }));
    expect(submit.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(submit));
    expect(createFilingMock).toHaveBeenCalledWith({ kind: "vat_return", periodFrom: "2026-07-01", periodTo: "2026-09-30", status: "draft" });
    expect(submitFilingMock).toHaveBeenCalledWith({ filingId: "draft-1", submittedOn: "2026-11-12", amountCents: null });
    expect(refreshMock).toHaveBeenCalled();
  });

  it("warns when the Zahllast on the protocol differs from the preview, without blocking", async () => {
    renderPeriods([period({})]);
    fireEvent.click(within(row("2026-Q3")).getByRole("button", { name: "Als eingereicht markieren" }));
    const card = screen.getByRole("alertdialog");
    expect(within(card).getByLabelText("Ergebnis laut Protokoll")).toHaveProperty("value", "refund");
    fireEvent.change(within(card).getByLabelText("Betrag (optional)"), { target: { value: "23,71" } });
    expect(within(card).queryByText(/weicht um/)).toBeNull();
    fireEvent.change(within(card).getByLabelText("Betrag (optional)"), { target: { value: "25,14" } });
    expect(within(card).getByText(/weicht um 1,43/)).toBeTruthy();
    fireEvent.change(within(card).getByLabelText("Eingereicht am"), { target: { value: "2026-10-10" } });
    fireEvent.click(within(card).getByRole("checkbox"));
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Als eingereicht markieren" })));
    expect(submitFilingMock).toHaveBeenCalledWith({ filingId: "draft-1", submittedOn: "2026-10-10", amountCents: -2514 });
  });

  it("submits a waiting draft without creating another one, and shows a refusal", async () => {
    submitFilingMock.mockResolvedValue({ status: "error", errorCode: "filing_not_draft" });
    renderPeriods([period({ draft: { ...SUBMITTED, id: "d-9", status: "draft", periodFrom: "2026-07-01", periodTo: "2026-09-30", submittedOn: null } })]);
    fireEvent.click(within(row("2026-Q3")).getByRole("button", { name: "Als eingereicht markieren" }));
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Als eingereicht markieren" })));
    expect(createFilingMock).not.toHaveBeenCalled();
    expect(submitFilingMock).toHaveBeenCalledWith(expect.objectContaining({ filingId: "d-9" }));
    expect(screen.getByRole("alert").textContent).toBe(de.Ledger.errors.filing_not_draft);
  });

  it("a failed submission keeps the draft it created: the retry submits it instead of creating a second one", async () => {
    submitFilingMock.mockResolvedValueOnce({ status: "error", errorCode: "unknown" });
    renderPeriods([period({})]);
    fireEvent.click(within(row("2026-Q3")).getByRole("button", { name: "Als eingereicht markieren" }));
    const card = screen.getByRole("alertdialog");
    fireEvent.click(within(card).getByRole("checkbox"));
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Als eingereicht markieren" })));
    expect(screen.getByRole("alert")).toBeTruthy();
    await act(async () => fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Als eingereicht markieren" })));
    expect(createFilingMock).toHaveBeenCalledTimes(1);
    expect(submitFilingMock).toHaveBeenCalledTimes(2);
    expect(submitFilingMock).toHaveBeenLastCalledWith(expect.objectContaining({ filingId: "draft-1" }));
  });

  it("asks for the annual statement without a Zahllast", () => {
    renderPeriods([]);
    fireEvent.click(within(row("2026")).getByRole("button", { name: "Als eingereicht markieren" }));
    const card = screen.getByRole("alertdialog");
    expect(within(card).queryByLabelText("Betrag (optional)")).toBeNull();
    expect(within(card).getByTestId("filing-lock-count").textContent).toMatch(/^140 gebuchte Buchungen/);
    expect(within(card).getByRole("checkbox", { name: "Der Jahresabschluss ist beim Finanzamt abgegeben." })).toBeTruthy();
  });
});

describe("a submitted period", () => {
  it("shows the lock and offers the correction guide with both paths", async () => {
    renderPeriods([period({ key: "2026-Q2", from: "2026-04-01", to: "2026-06-30", status: "submitted", submitted: SUBMITTED, original: SUBMITTED })]);
    const q2 = row("2026-Q2");
    expect(within(q2).getByText(/Eingereicht am/)).toBeTruthy();
    expect(within(q2).getByText(/^Zahllast laut Protokoll: 12,40/)).toBeTruthy();
    expect(within(q2).queryByRole("button", { name: "Als eingereicht markieren" })).toBeNull();
    fireEvent.click(within(q2).getByRole("button", { name: "Berichtigte Meldung anlegen" }));
    const guide = within(q2).getByRole("region", { name: "Eingereichten Zeitraum korrigieren" });
    expect(within(guide).getByText("Korrektur im nächsten offenen Zeitraum")).toBeTruthy();
    expect(within(guide).getByRole("link", { name: "Buchungen dieses Zeitraums ansehen" }).getAttribute("href")).toBe("/dashboard/buchhaltung/journal?von=2026-04-01&bis=2026-06-30&status=booked");
    await act(async () => fireEvent.click(within(guide).getByRole("button", { name: "Berichtigte Meldung anlegen" })));
    expect(correctionMock).toHaveBeenCalledWith({ filingId: "f-q2" });
  });
});

describe("the handover", () => {
  it("records a marker with a note and links the changes since", async () => {
    renderPeriods([
      period({}),
      period({ key: "2026-Q2", from: "2026-04-01", to: "2026-06-30", status: "handed_over", handover: { id: "h-0", createdAt: "2026-07-04T10:00:00.000Z", changesSince: 3, note: null } }),
    ]);
    const q2Link = within(row("2026-Q2")).getByRole("link", { name: "3 Änderungen seit der Übergabe" });
    expect(q2Link.getAttribute("href")).toBe("/dashboard/buchhaltung/journal?von=2026-04-01&bis=2026-06-30&seit=h-0");
    fireEvent.click(within(row("2026-Q3")).getByRole("button", { name: "An Steuerberaterin übergeben" }));
    fireEvent.change(screen.getByLabelText("Notiz zur Übergabe (optional)"), { target: { value: "Per E-Mail" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Übergabe festhalten" })));
    expect(handoverMock).toHaveBeenCalledWith({ periodFrom: "2026-07-01", periodTo: "2026-09-30", note: "Per E-Mail" });
  });
});
