// @vitest-environment jsdom
// "Zu prüfen" (decisions/0080 UI concept A): grouping by certainty, bulk booking that never
// picks up an AI or warned proposal on its own, and the keyboard map. The actions are mocked;
// they re-check `finance.manage` server-side (tests/actions.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import de from "@/i18n/messages/de.json";

const bookMock = vi.fn();
const bulkMock = vi.fn();
const dismissMock = vi.fn();
vi.mock("../actions", () => ({
  bookJournalEntryAction: (input: unknown) => bookMock(input),
  bulkBookJournalEntriesAction: (input: unknown) => bulkMock(input),
  dismissProposalAction: (input: unknown) => dismissMock(input),
}));

const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock, refresh: refreshMock }) }));

import type { JournalEntryListItem } from "../core/types";
import type { QueueProblem } from "../ui/queue-model";
import { ReviewQueueClient } from "../ui/review-queue-client";

function entry(id: string, overrides: Partial<JournalEntryListItem> = {}): JournalEntryListItem {
  return {
    id,
    bookingDate: "2026-09-03",
    documentDate: "2026-09-03",
    text: `Eintrag ${id}`,
    status: "proposed",
    origin: "template",
    dismissed: false,
    sourceKey: `doc:${id}`,
    originReason: "template:incoming_invoice",
    documentId: null,
    transactionId: null,
    totalCents: 150,
    differenceCents: 0,
    warnings: [],
    revision: 1,
    updatedAt: "2026-09-03T10:00:00.000Z",
    summary: { key: "summaries.expensePaidByBank", params: { amount: 1.5, account: "Internetkosten", counter: "Bank" } },
    lines: [
      { id: `${id}-1`, position: 1, accountId: "a", accountNumber: "6810", accountName: "Internetkosten", amountCents: 126, taxCode: "vst19", taxRole: "base", generatedFromLinePosition: null, documentId: null, text: null },
      { id: `${id}-2`, position: 2, accountId: "b", accountNumber: "1406", accountName: "Vorsteuer 19 %", amountCents: 24, taxCode: "vst19", taxRole: "tax", generatedFromLinePosition: 1, documentId: null, text: null },
      { id: `${id}-3`, position: 3, accountId: "c", accountNumber: "1800", accountName: "Bank", amountCents: -150, taxCode: null, taxRole: null, generatedFromLinePosition: null, documentId: null, text: null },
    ],
    ...overrides,
  };
}

const ENTRIES = [
  entry("ionos"),
  entry("meta", { origin: "rule", originReason: "rule:r1", totalCents: 1300 }),
  entry("notar", { origin: "ai", originReason: "Notarkosten sind Rechts- und Beratungskosten.", totalCents: 81583 }),
  entry("court", { warnings: ["possible_pass_through"], totalCents: 30500 }),
];

const PROBLEMS: QueueProblem[] = [{ kind: "transaction", id: "tx-1", date: "2026-08-19", title: "Google Ads", amountCents: -5000, dismissed: false }];

function renderQueue(props: Partial<React.ComponentProps<typeof ReviewQueueClient>> = {}) {
  return render(
    <NextIntlClientProvider locale="de" messages={{ Ledger: de.Ledger }} timeZone="Europe/Berlin">
      <ReviewQueueClient entries={ENTRIES} problems={PROBLEMS} canManage filtered={false} {...props} />
    </NextIntlClientProvider>,
  );
}

function section(name: RegExp) {
  return screen.getByRole("region", { name });
}

beforeEach(() => {
  bookMock.mockResolvedValue({ status: "success", data: undefined });
  bulkMock.mockImplementation(async ({ entryIds }: { entryIds: string[] }) => ({ status: "success", data: { booked: entryIds, failed: [] } }));
  dismissMock.mockResolvedValue({ status: "success", data: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReviewQueueClient", () => {
  it("groups template and rule proposals as safe, the AI and warned ones as to look at", () => {
    renderQueue();
    const safe = section(/Sicher/);
    expect(within(safe).getByText("Eintrag ionos")).toBeTruthy();
    expect(within(safe).getByText("Eintrag meta")).toBeTruthy();
    const review = section(/Bitte ansehen/);
    expect(within(review).getByText("Eintrag notar")).toBeTruthy();
    expect(within(review).getByText("Eintrag court")).toBeTruthy();
    expect(within(review).getByText("Durchlaufender Posten?")).toBeTruthy();
    // The deterministic sentence, rendered from the summary key.
    expect(screen.getAllByText(/für Internetkosten, bezahlt über Bank/).length).toBe(4);
    // The AI's reason sits behind "Warum?".
    expect(within(review).getByText("Notarkosten sind Rechts- und Beratungskosten.")).toBeTruthy();
    const problems = section(/Probleme/);
    expect(within(problems).getByRole("link", { name: "Buchung anlegen" }).getAttribute("href")).toBe("/dashboard/buchhaltung/buchung/neu?umsatz=tx-1");
  });

  it("selects only the safe proposals and books them in bulk with their sum", async () => {
    renderQueue();
    fireEvent.click(screen.getByRole("button", { name: "Alle sicheren auswählen (2)" }));
    const bookAll = screen.getByRole("button", { name: /2 Buchungen buchen/ });
    expect(bookAll.textContent).toContain("14,50");
    await act(async () => {
      fireEvent.click(bookAll);
    });
    expect(bulkMock).toHaveBeenCalledWith({ entryIds: ["ionos", "meta"] });
    expect(screen.queryByText("Eintrag ionos")).toBeNull();
    expect(screen.getByText("Eintrag notar")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("2 Buchungen gebucht");
  });

  it("shows a bulk failure on its row and keeps the row", async () => {
    bulkMock.mockResolvedValue({ status: "success", data: { booked: ["ionos"], failed: [{ entryId: "meta", errorCode: "locked" }] } });
    renderQueue();
    fireEvent.click(screen.getByRole("button", { name: "Alle sicheren auswählen (2)" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /2 Buchungen buchen/ }));
    });
    expect(screen.queryByText("Eintrag ionos")).toBeNull();
    expect(screen.getByText("Eintrag meta")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("gesperrt");
  });

  it("an AI proposal can still be ticked by hand", () => {
    renderQueue();
    fireEvent.click(screen.getByRole("checkbox", { name: "Eintrag notar auswählen" }));
    expect(screen.getByRole("button", { name: /1 Buchung buchen/ })).toBeTruthy();
    expect(screen.getByText(/Die Auswahl enthält Vorschläge/)).toBeTruthy();
  });

  it("moves with j and k and books the focused row with Enter", async () => {
    renderQueue();
    fireEvent.keyDown(document.body, { key: "j" });
    expect(document.activeElement?.getAttribute("data-queue-row")).toBe("ionos");
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    expect(document.activeElement?.getAttribute("data-queue-row")).toBe("notar");
    fireEvent.keyDown(document.activeElement!, { key: "k" });
    expect(document.activeElement?.getAttribute("data-queue-row")).toBe("meta");
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    });
    expect(bookMock).toHaveBeenCalledWith({ entryId: "meta" });
    expect(screen.queryByText("Eintrag meta")).toBeNull();
    expect(refreshMock).toHaveBeenCalled();
  });

  it("selects with x, edits with e, and ignores keys typed into a field", () => {
    renderQueue();
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.activeElement!, { key: "x" });
    expect((screen.getByRole("checkbox", { name: "Eintrag ionos auswählen" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "e" });
    expect(pushMock).toHaveBeenCalledWith("/dashboard/buchhaltung/buchung/ionos");

    const checkbox = screen.getByRole("checkbox", { name: "Eintrag meta auswählen" });
    fireEvent.keyDown(checkbox, { key: "j" });
    expect(document.activeElement?.getAttribute("data-queue-row")).toBe("ionos");
  });

  it("opens the keyboard help with ?", () => {
    renderQueue();
    fireEvent.keyDown(document.body, { key: "?" });
    expect(screen.getByRole("region", { name: "Tastenkürzel" })).toBeTruthy();
  });

  it("puts a failed booking back with its error", async () => {
    bookMock.mockResolvedValue({ status: "error", errorCode: "unbalanced" });
    renderQueue();
    await act(async () => {
      fireEvent.click(within(section(/Sicher/)).getAllByRole("button", { name: "Buchen" })[0]!);
    });
    expect(screen.getByText("Eintrag ionos")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Soll und Haben");
  });

  it("asks before dismissing", async () => {
    renderQueue();
    fireEvent.click(within(section(/Bitte ansehen/)).getAllByRole("button", { name: "Verwerfen" })[0]!);
    const dialog = screen.getByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Ja, verwerfen" }));
    });
    expect(dismissMock).toHaveBeenCalledWith({ entryId: "notar" });
  });

  it("says when everything is reviewed", () => {
    renderQueue({ entries: [], problems: [] });
    expect(screen.getByText("Alles geprüft")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Zur Übersicht" }).getAttribute("href")).toBe("/dashboard/buchhaltung");
  });

  it("offers no booking controls without finance.manage", () => {
    renderQueue({ canManage: false });
    expect(screen.queryByRole("button", { name: "Buchen" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
