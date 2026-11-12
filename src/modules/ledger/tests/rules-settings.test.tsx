// @vitest-environment jsdom
// "Einstellungen > Regeln" (decisions/0080): the rule form needs a contact or a pattern and an
// account, sends the whole rule; deactivating keeps the rule, deleting needs a confirmation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import de from "@/i18n/messages/de.json";
import type { BookingRuleView, LedgerAccountView } from "@/modules/ledger";

const createMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("../actions", () => ({
  createBookingRuleAction: (input: unknown) => createMock(input),
  updateBookingRuleAction: (input: unknown) => updateMock(input),
  deleteBookingRuleAction: (input: unknown) => deleteMock(input),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { RulesSettings } from "../ui/rules-settings";

function account(number: string, name: string, group: LedgerAccountView["group"], openItems = false): LedgerAccountView {
  return { id: number, number, name, kind: "expense", group, openItems, ownerType: null, ownerBankAccountId: null, ownerContactId: null, ownerPlatform: null, ownerPersonName: null, description: null, archived: false };
}
const ACCOUNTS = [account("1800", "Bank", "bank"), account("1461", "Meta", "open_items", true), account("2900", "Gezeichnetes Kapital", "equity"), account("6810", "Internetkosten", "costs")];
const RULE: BookingRuleView = { id: "r1", contactId: "c-ionos", counterpartyPattern: null, direction: "outgoing", accountNumber: "6810", taxCode: "vst19", paymentAccountNumber: null, noDocument: false, active: true, hits: 4, learnedFromEntryId: "e1" };

function renderRules(rules: BookingRuleView[] = [RULE]) {
  return render(
    <NextIntlClientProvider locale="de" messages={{ Ledger: de.Ledger }} timeZone="Europe/Berlin">
      <RulesSettings rules={rules} accounts={ACCOUNTS} contacts={[{ id: "c-ionos", name: "IONOS" }]} canManage />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  for (const mock of [createMock, updateMock, deleteMock]) mock.mockResolvedValue({ status: "success", data: {} });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RulesSettings", () => {
  it("lists a rule with contact, account, tax code, hits and status", () => {
    renderRules();
    const row = screen.getByRole("link", { name: "IONOS" }).closest("tr")!;
    expect(within(row).getByText("Internetkosten")).toBeTruthy();
    expect(within(row).getByText("Vorsteuer 19 %")).toBeTruthy();
    expect(within(row).getByText("4")).toBeTruthy();
    expect(within(row).getByText("Aktiv")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Gelernt aus einer Buchung" }).getAttribute("href")).toBe("/dashboard/buchhaltung/buchung/e1");
  });

  it("needs a contact or a pattern and an account before creating", async () => {
    renderRules([]);
    fireEvent.click(screen.getByRole("button", { name: "Neue Regel" }));
    const form = screen.getByRole("form", { name: "Neue Regel" });
    const submit = within(form).getByRole("button", { name: "Regel anlegen" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(form).getByLabelText("Gegenpartei enthält"), { target: { value: "Stammeinlage" } });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(form).getByLabelText("Konto"), { target: { value: "2900" } });
    fireEvent.change(within(form).getByLabelText("Richtung"), { target: { value: "incoming" } });
    fireEvent.change(within(form).getByLabelText("Steuer"), { target: { value: "not_taxable" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: /Ohne Beleg buchen/ }));
    expect(submit.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(submit));
    expect(createMock).toHaveBeenCalledWith({
      contactId: null,
      counterpartyPattern: "Stammeinlage",
      direction: "incoming",
      accountNumber: "2900",
      taxCode: "not_taxable",
      paymentAccountNumber: null,
      noDocument: true,
      active: true,
      learnedFromEntryId: null,
    });
  });

  it("edits a rule with its current values", async () => {
    renderRules();
    fireEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    const form = screen.getByRole("form", { name: "Regel bearbeiten" });
    expect(within(form).getByLabelText("Kontakt")).toHaveProperty("value", "c-ionos");
    fireEvent.change(within(form).getByLabelText("Gegenkonto"), { target: { value: "1461" } });
    await act(async () => fireEvent.click(within(form).getByRole("button", { name: "Speichern" })));
    expect(updateMock).toHaveBeenCalledWith({ ruleId: "r1", rule: expect.objectContaining({ contactId: "c-ionos", accountNumber: "6810", paymentAccountNumber: "1461", learnedFromEntryId: "e1" }) });
  });

  it("deactivates without deleting", async () => {
    renderRules();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Deaktivieren" })));
    expect(updateMock).toHaveBeenCalledWith({ ruleId: "r1", rule: expect.objectContaining({ active: false }) });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("deletes only after the inline confirmation", async () => {
    renderRules();
    fireEvent.click(screen.getByRole("button", { name: "Regel löschen" }));
    expect(deleteMock).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Löschen" })));
    expect(deleteMock).toHaveBeenCalledWith({ ruleId: "r1" });
  });
});
