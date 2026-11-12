// @vitest-environment jsdom
// The document page's "Buchhaltung" card (decisions/0080 UI): state, sentence and link.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import de from "@/i18n/messages/de.json";
import type { LedgerDocumentStatus } from "@/modules/ledger";

import { DocumentLedgerCard } from "../ui/document-ledger-card";

function renderCard(status: LedgerDocumentStatus, canManage = true) {
  return render(
    <NextIntlClientProvider locale="de" messages={{ Ledger: de.Ledger }} timeZone="Europe/Berlin">
      <DocumentLedgerCard status={status} documentId="doc-1" canManage={canManage} />
    </NextIntlClientProvider>,
  );
}

afterEach(cleanup);

describe("DocumentLedgerCard", () => {
  it("offers to create an entry when there is none", () => {
    renderCard({ state: "none", entries: [] });
    expect(screen.getByText("Keine Buchung")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Buchung anlegen" }).getAttribute("href")).toBe("/dashboard/buchhaltung/buchung/neu?beleg=doc-1");
    cleanup();
    renderCard({ state: "none", entries: [] }, false);
    expect(screen.queryByRole("link", { name: "Buchung anlegen" })).toBeNull();
  });

  it("shows the entry's sentence, the lock and the link", () => {
    renderCard({
      state: "locked",
      entries: [
        {
          id: "e1",
          status: "booked",
          dismissed: false,
          bookingDate: "2026-08-03",
          totalCents: 150,
          summary: { key: "summaries.expensePaidByBank", params: { amount: 1.5, account: "Internetkosten", counter: "Finom" } },
          lockedBy: { id: "f", kind: "vat_return", periodFrom: "2026-07-01", periodTo: "2026-09-30" },
        },
      ],
    });
    expect(screen.getByText("Gesperrt")).toBeTruthy();
    expect(screen.getByText(/für Internetkosten, bezahlt über Finom\./)).toBeTruthy();
    expect(screen.getByText(/Gesperrt durch USt-VA 3\. Quartal 2026/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Buchung ansehen" }).getAttribute("href")).toBe("/dashboard/buchhaltung/buchung/e1");
  });
});
