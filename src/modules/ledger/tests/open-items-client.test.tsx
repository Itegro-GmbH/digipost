// @vitest-environment jsdom
// "Offene Posten" (decisions/0080 UI concept B, screen D): "Ausgleichen" only at exactly zero,
// "Rest erklären" only with a note, a suggestion applied in one click, a match undone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import de from "@/i18n/messages/de.json";

const matchMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("../actions", () => ({
  createOpenItemMatchAction: (input: unknown) => matchMock(input),
  deleteOpenItemMatchAction: (input: unknown) => deleteMock(input),
}));
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: refreshMock }) }));

import { OpenItemsClient, type OpenItemLineView } from "../ui/open-items-client";

const L = (lineId: string, text: string, amountCents: number): OpenItemLineView => ({ lineId, entryId: `e-${lineId}`, bookingDate: "2026-08-12", text, amountCents, documentId: null });
// Google Ads: 10 + 50 + 36,57 charged, one invoice 96,57.
const LINES = [L("l1", "Abbuchung", 1000), L("l2", "Abbuchung", 5000), L("l3", "Rechnung 4711", -9657), L("l4", "Abbuchung", 3657)];

function renderClient(props: Partial<React.ComponentProps<typeof OpenItemsClient>> = {}) {
  return render(
    <NextIntlClientProvider locale="de" messages={{ Ledger: de.Ledger }} timeZone="Europe/Berlin">
      <OpenItemsClient
        accountNumber="1462"
        accountType="prepaid"
        balanceCents={0}
        status="open"
        unmatched={LINES}
        matches={[{ id: "m1", kind: "explained", note: "Restguthaben Meta", sumCents: 4, lines: [L("x1", "Aufladung", 4)] }]}
        suggestions={[{ reason: "subset_sum", lineIds: ["l1", "l2", "l3", "l4"], amountCents: 9657 }]}
        canManage
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

const box = (name: RegExp) => screen.getByRole("checkbox", { name });

beforeEach(() => {
  matchMock.mockResolvedValue({ status: "success", data: { matchId: "new" } });
  deleteMock.mockResolvedValue({ status: "success", data: undefined });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OpenItemsClient", () => {
  it("enables Ausgleichen only when the selection sums to exactly zero", async () => {
    renderClient();
    const match = screen.getByRole("button", { name: "Ausgleichen" });
    expect(match.hasAttribute("disabled")).toBe(true);
    fireEvent.click(box(/Rechnung 4711/));
    fireEvent.click(box(/Abbuchung über 10,00/));
    fireEvent.click(box(/Abbuchung über 50,00/));
    expect(screen.getByTestId("open-items-sum").textContent).toMatch(/-36,57/);
    expect(match.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Noch 36,57\s€ bis null/)).toBeTruthy();
    fireEvent.click(box(/Abbuchung über 36,57/));
    expect(screen.getByTestId("open-items-sum").textContent).toMatch(/0,00/);
    expect(match.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(match));
    expect(matchMock).toHaveBeenCalledWith({ accountNumber: "1462", kind: "match", lineIds: ["l1", "l2", "l3", "l4"] });
    expect(refreshMock).toHaveBeenCalled();
  });

  it("needs a note to explain a remainder", async () => {
    renderClient();
    fireEvent.click(box(/Abbuchung über 10,00/));
    fireEvent.click(screen.getByRole("button", { name: "Rest erklären" }));
    const save = screen.getByRole("button", { name: "Erklärung speichern" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Warum bleibt dieser Betrag?"), { target: { value: "   " } });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Warum bleibt dieser Betrag?"), { target: { value: "Guthaben bei Google" } });
    expect(save.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(save));
    expect(matchMock).toHaveBeenCalledWith({ accountNumber: "1462", kind: "explained", lineIds: ["l1"], note: "Guthaben bei Google" });
  });

  it("applies a suggestion in one click", async () => {
    renderClient();
    expect(screen.getByText("Diese 4 Posten gleichen sich aus")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Übernehmen" })));
    expect(matchMock).toHaveBeenCalledWith({ accountNumber: "1462", kind: "match", lineIds: ["l1", "l2", "l3", "l4"] });
  });

  it("hides a suggestion whose lines are no longer open", () => {
    renderClient({ suggestions: [{ reason: "same_document", lineIds: ["l1", "gone"], amountCents: 1000 }] });
    expect(screen.queryByRole("button", { name: "Übernehmen" })).toBeNull();
  });

  it("shows a refused match as an error and keeps the selection", async () => {
    matchMock.mockResolvedValue({ status: "error", errorCode: "line_already_matched" });
    renderClient();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Übernehmen" })));
    expect(screen.getByRole("alert").textContent).toBe(de.Ledger.errors.line_already_matched);
  });

  it("undoes an existing match", async () => {
    renderClient();
    expect(screen.getByText("Restguthaben Meta")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ausgleich aufheben" })));
    expect(deleteMock).toHaveBeenCalledWith({ matchId: "m1" });
  });

  it("is read-only without finance.manage", () => {
    renderClient({ canManage: false });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ausgleichen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Übernehmen" })).toBeNull();
  });

  it("explains what the account is for", () => {
    renderClient();
    expect(screen.getByText(de.Ledger.openItems.types.prepaid.title)).toBeTruthy();
  });
});
