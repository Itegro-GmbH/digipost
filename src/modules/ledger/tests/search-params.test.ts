// The URL filters of "Zu prüfen" and the journal (decisions/0062: empty or malformed means absent).
import { describe, expect, it } from "vitest";

import {
  isQueueFiltered,
  JOURNAL_PAGE_SIZE,
  journalFilterFor,
  journalSearch,
  listEntriesFilterSchema,
  parseJournalSearchParams,
  parseQueueSearchParams,
} from "@/modules/ledger";

describe("queue filters", () => {
  it("reads von, bis, herkunft and nur=warnungen", () => {
    expect(parseQueueSearchParams({ von: "2026-07-01", bis: "2026-09-30", herkunft: "ai", nur: "warnungen" })).toEqual({
      von: "2026-07-01",
      bis: "2026-09-30",
      herkunft: "ai",
      nurWarnungen: true,
    });
  });

  it("drops what it cannot read and swaps a reversed range", () => {
    const values = parseQueueSearchParams({ von: "2026-09-30", bis: "2026-07-01", herkunft: "magic", nur: "" });
    expect(values).toEqual({ von: "2026-07-01", bis: "2026-09-30", herkunft: "", nurWarnungen: false });
    expect(parseQueueSearchParams({ von: "2026-02-30" }).von).toBe("");
    expect(isQueueFiltered(parseQueueSearchParams({}))).toBe(false);
    expect(isQueueFiltered(parseQueueSearchParams({ herkunft: "rule" }))).toBe(true);
  });
});

describe("journal filters", () => {
  it("reads every filter", () => {
    const handover = "0f9a5c1e-3b0f-4e0e-9d6a-2b4c8f1d7e55";
    expect(parseJournalSearchParams({ von: "2026-06-01", status: "booked", herkunft: "rule", konto: "6810", seit: handover, anzahl: "400" })).toEqual({
      von: "2026-06-01",
      bis: "",
      status: "booked",
      herkunft: "rule",
      konto: "6810",
      seit: handover,
      limit: 400,
    });
  });

  it("falls back to defaults for malformed values", () => {
    expect(parseJournalSearchParams({ status: "everything", konto: "abc", seit: "x", anzahl: "-3" })).toMatchObject({ status: "", konto: "", seit: "", limit: JOURNAL_PAGE_SIZE });
    expect(parseJournalSearchParams({ anzahl: "999999" }).limit).toBe(2000);
  });

  it("maps to the use case's filter: dismissed only for Verworfen, one extra row for Mehr laden", () => {
    const values = parseJournalSearchParams({ status: "dismissed", konto: "1800" });
    const filter = journalFilterFor(values, null);
    expect(filter).toEqual({ accountNumber: "1800", dismissed: "only", limit: JOURNAL_PAGE_SIZE + 1 });
    expect(listEntriesFilterSchema.safeParse(filter).success).toBe(true);

    const since = journalFilterFor(parseJournalSearchParams({ status: "proposed", von: "2026-07-01", bis: "2026-07-31" }), "2026-08-04T10:00:00.000Z");
    expect(since).toMatchObject({ from: "2026-07-01", to: "2026-07-31", status: "proposed", dismissed: "exclude", changedSince: "2026-08-04T10:00:00.000Z" });
    expect(listEntriesFilterSchema.safeParse(since).success).toBe(true);
  });

  it("writes the search string back without empty values", () => {
    const values = parseJournalSearchParams({ von: "2026-07-01", herkunft: "ai" });
    expect(journalSearch(values)).toBe("?von=2026-07-01&herkunft=ai");
    expect(journalSearch(values, { limit: 400 })).toBe("?von=2026-07-01&herkunft=ai&anzahl=400");
    expect(journalSearch(parseJournalSearchParams({}))).toBe("");
  });
});
