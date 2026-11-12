// @vitest-environment jsdom
// "Konten" (decisions/0080 UI concept B, screen A): groups with subtotals, the two views and the
// status chips, every amount a link to the Kontenblatt.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import de from "@/i18n/messages/de.json";
import { buildBalanceGroups, type BalanceRow, type LedgerAccountView } from "@/modules/ledger";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { BalanceListView } from "../ui/balance-list";

function account(number: string, name: string, kind: LedgerAccountView["kind"], group: LedgerAccountView["group"], openItems = false): LedgerAccountView {
  return { id: number, number, name, kind, group, openItems, ownerType: null, ownerBankAccountId: null, ownerContactId: null, ownerPlatform: null, ownerPersonName: null, description: `Hilfe zu ${name}`, archived: false };
}
const ACCOUNTS = [account("1800", "Finom", "asset", "bank"), account("1461", "Meta", "asset", "open_items", true), account("2900", "Gezeichnetes Kapital", "equity", "equity"), account("6600", "Werbekosten", "expense", "costs")];
function row(number: string, debit: number, credit: number): BalanceRow {
  const a = ACCOUNTS.find((candidate) => candidate.number === number)!;
  return { accountId: a.id, number, name: a.name, kind: a.kind, group: a.group, openItems: a.openItems, openingCents: 0, debitCents: debit, creditCents: credit, closingCents: debit - credit };
}
const ROWS = [row("1800", 1250100, 10000), row("1461", 10000, 9996), row("2900", 0, 1250100), row("6600", 9996, 0)];
const TOTALS = { openingCents: 0, debitCents: 1280096, creditCents: 1280096, closingCents: 0 };

function renderList(mode: "einfach" | "soll-haben", totals = TOTALS) {
  return render(
    <NextIntlClientProvider locale="de" messages={{ Ledger: de.Ledger }} timeZone="Europe/Berlin">
      <BalanceListView
        groups={buildBalanceGroups(ROWS, ACCOUNTS, { showEmpty: false })}
        totals={totals}
        statuses={{ "1800": { kind: "bank_diff", since: "2026-08-19" }, "1461": { kind: "items_explained" } }}
        mode={mode}
        sheetQuery="?von=2026-01-01&bis=2026-12-31"
      />
    </NextIntlClientProvider>,
  );
}

afterEach(cleanup);

describe("BalanceListView", () => {
  it("groups the accounts in chart order with a subtotal per group", () => {
    const { container } = renderList("einfach");
    expect([...container.querySelectorAll("details[data-group]")].map((element) => element.getAttribute("data-group"))).toEqual(["bank", "open_items", "costs", "equity"]);
    const equity = container.querySelector('details[data-group="equity"]') as HTMLElement;
    expect(within(equity).getByText("Summe Eigenkapital")).toBeTruthy();
    expect(within(equity).getAllByText(/12\.501,00/).length).toBeGreaterThan(0);
  });

  it("shows rein, raus and Stand in the plain view, positive for share capital", () => {
    renderList("einfach");
    expect(screen.getAllByRole("columnheader", { name: "Rein" }).length).toBe(4);
    expect(screen.queryByRole("columnheader", { name: "Soll" })).toBeNull();
    const capital = screen.getByRole("link", { name: /Gezeichnetes Kapital/ }).closest("tr")!;
    expect(within(capital).getByRole("link", { name: /^Stand: 12\.501,00/ })).toBeTruthy();
  });

  it("shows EB, Soll, Haben and Saldo with S or H in the expert view", () => {
    renderList("soll-haben");
    expect(screen.getAllByRole("columnheader", { name: "Soll" }).length).toBe(4);
    const capital = screen.getByRole("link", { name: /Gezeichnetes Kapital/ }).closest("tr")!;
    expect(within(capital).getByRole("link", { name: /^Saldo: 12\.501,00\s€ H/ })).toBeTruthy();
  });

  it("links every amount to the account sheet of the same period", () => {
    renderList("einfach");
    const bank = screen.getByRole("link", { name: /Finom/ }).closest("tr")!;
    for (const link of within(bank).getAllByRole("link")) expect(link.getAttribute("href")).toBe("/dashboard/buchhaltung/konten/1800?von=2026-01-01&bis=2026-12-31");
  });

  it("shows the status chips: bank divergence with its date, explained open items", () => {
    renderList("einfach");
    expect(screen.getByText("Abweichung seit 19.08.2026")).toBeTruthy();
    expect(screen.getByText("Erklärt")).toBeTruthy();
  });

  it("explains each account behind a question mark", () => {
    renderList("einfach");
    expect(screen.getByText("Hilfe zu Meta")).toBeTruthy();
    expect(screen.getByLabelText("Was wird auf Meta gebucht?")).toBeTruthy();
  });

  it("confirms that Soll equals Haben, and says so when it does not", () => {
    renderList("einfach");
    expect(screen.getByRole("status").textContent).toMatch(/Summe Soll 12\.800,96\s€ = Summe Haben 12\.800,96\s€/);
    cleanup();
    renderList("einfach", { ...TOTALS, creditCents: 1280000 });
    expect(screen.getByRole("status").textContent).toMatch(/Differenz 0,96/);
  });
});
