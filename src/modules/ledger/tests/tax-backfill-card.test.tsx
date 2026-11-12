// @vitest-environment jsdom
// "Einstellungen > Allgemein": "Steuerdaten alter Belege nachträglich erkennen" says how many
// older documents lack tax data, queues them through the documents owner's action, and says how
// many are being read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import de from "@/i18n/messages/de.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { TaxBackfillCard, type TaxBackfillAction } from "../ui/tax-backfill-card";

function renderCard(props: { candidates: number; canManage?: boolean; action: TaxBackfillAction }) {
  return render(
    <NextIntlClientProvider locale="de" messages={{ Ledger: de.Ledger }} timeZone="Europe/Berlin">
      <TaxBackfillCard candidates={props.candidates} maxPerRequest={100} canManage={props.canManage ?? true} action={props.action} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("TaxBackfillCard", () => {
  it("explains what is sent, shows the candidates, and reports how many are being read", async () => {
    const action = vi.fn<TaxBackfillAction>().mockResolvedValue({ status: "success", data: { queued: 100, remaining: 23 } });
    renderCard({ candidates: 123, action });
    expect(screen.getByText(/bis zu 100 Rechnungen einmal an die KI/)).toBeTruthy();
    expect(screen.getByText("123 ältere Belege ohne Steuerdaten.")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Steuerdaten nachträglich erkennen" }));
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("100 Belege werden nachträglich ausgelesen. Danach bleiben 23 Belege für einen weiteren Durchgang.");
  });

  it("is disabled with nothing to read, and shows no button without finance.manage", () => {
    const action = vi.fn<TaxBackfillAction>();
    renderCard({ candidates: 0, action });
    expect(screen.getByText("Keine älteren Belege ohne Steuerdaten.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Steuerdaten nachträglich erkennen" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderCard({ candidates: 5, canManage: false, action });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says when it failed", async () => {
    renderCard({ candidates: 2, action: vi.fn<TaxBackfillAction>().mockResolvedValue({ status: "error", errorCode: "forbidden" }) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Steuerdaten nachträglich erkennen" }));
    });
    expect(screen.getByRole("status").textContent).toBe("Das hat nicht geklappt. Bitte versuchen Sie es erneut.");
  });
});
