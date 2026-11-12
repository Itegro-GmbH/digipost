// @vitest-environment jsdom
// The journal's filters are a plain GET form: what the URL says is what the fields show, and
// "Geändert seit Übergabe" exists only once there is a handover to compare with.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import de from "@/i18n/messages/de.json";
import { parseJournalSearchParams, type HandoverView, type LedgerAccountView } from "@/modules/ledger";

import { JournalFilters } from "../ui/journal-filters";

const ACCOUNTS = [{ number: "6810", name: "Internetkosten" }, { number: "1800", name: "Finom Main" }] as LedgerAccountView[];
const HANDOVER: HandoverView = { id: "0f9a5c1e-3b0f-4e0e-9d6a-2b4c8f1d7e55", periodFrom: "2026-07-01", periodTo: "2026-09-30", note: null, createdAt: "2026-10-04T09:00:00.000Z", changesSince: 3 };

function renderFilters(search: Record<string, string>, handovers: HandoverView[] = []) {
  return render(
    <NextIntlClientProvider locale="de" messages={{ Ledger: de.Ledger }} timeZone="Europe/Berlin">
      <JournalFilters values={parseJournalSearchParams(search)} accounts={ACCOUNTS} handovers={handovers} />
    </NextIntlClientProvider>,
  );
}

afterEach(cleanup);

const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement).value;

describe("JournalFilters", () => {
  it("shows the filters from the URL in a GET form", () => {
    const { container } = renderFilters({ von: "2026-07-01", bis: "2026-07-31", status: "proposed", herkunft: "ai", konto: "6810" });
    expect(container.querySelector("form")?.getAttribute("method")).toBe("get");
    expect(value("Von")).toBe("2026-07-01");
    expect(value("Bis")).toBe("2026-07-31");
    expect(value("Status")).toBe("proposed");
    expect(value("Herkunft")).toBe("ai");
    expect(value("Konto")).toBe("6810");
    expect(screen.getByRole("link", { name: "Zurücksetzen" }).getAttribute("href")).toBe("/dashboard/buchhaltung/journal");
  });

  it("names the URL parameters the page reads", () => {
    renderFilters({});
    expect(screen.getByLabelText("Von").getAttribute("name")).toBe("von");
    expect(screen.getByLabelText("Status").getAttribute("name")).toBe("status");
    expect(screen.getByLabelText("Herkunft").getAttribute("name")).toBe("herkunft");
    expect(screen.getByLabelText("Konto").getAttribute("name")).toBe("konto");
    expect(screen.getByRole("option", { name: "Verworfen" })).toBeTruthy();
  });

  it("offers Geändert seit Übergabe only with a handover", () => {
    renderFilters({});
    expect(screen.queryByLabelText("Geändert seit Übergabe")).toBeNull();
    cleanup();
    renderFilters({ seit: HANDOVER.id }, [HANDOVER]);
    expect(value("Geändert seit Übergabe")).toBe(HANDOVER.id);
    expect(screen.getByRole("option", { name: /Übergabe vom 04\.10\.2026 \(3\. Quartal 2026\)/ })).toBeTruthy();
  });
});
