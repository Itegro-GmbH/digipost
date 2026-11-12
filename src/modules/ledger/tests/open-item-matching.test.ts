// Matching open items (decisions/0080 phase 4): the automatic same-document matches and the
// suggested groups, on Itegro's Google Ads and Google Play cases.
import { describe, expect, it } from "vitest";

import { findAutoMatches, suggestMatchGroups, type OpenItemLine } from "@/modules/ledger";

const line = (lineId: string, amountCents: number, documentId: string | null = null, bookingDate = "2026-08-01", accountId = "acc-1462"): OpenItemLine => ({ lineId, accountId, amountCents, documentId, bookingDate });

describe("findAutoMatches", () => {
  it("matches an invoice and its payments of the same document when they sum to zero", () => {
    expect(findAutoMatches([line("invoice", -150, "doc"), line("payment", 150, "doc")])).toEqual([{ accountId: "acc-1462", documentId: "doc", lineIds: ["invoice", "payment"] }]);
    expect(findAutoMatches([line("invoice", -1000, "doc"), line("p1", 600, "doc"), line("p2", 400, "doc")])[0]?.lineIds).toEqual(["invoice", "p1", "p2"]);
  });

  it("leaves partial payments, lines without a document and one-sided groups alone", () => {
    expect(findAutoMatches([line("invoice", -150, "doc"), line("payment", 100, "doc")])).toEqual([]);
    expect(findAutoMatches([line("invoice", -150), line("payment", 150)])).toEqual([]);
    expect(findAutoMatches([line("a", 0, "doc"), line("b", 0, "doc")])).toEqual([]);
  });

  it("never matches across accounts", () => {
    expect(findAutoMatches([line("invoice", -150, "doc", "2026-08-01", "acc-a"), line("payment", 150, "doc", "2026-08-01", "acc-b")])).toEqual([]);
  });
});

describe("suggestMatchGroups", () => {
  it("Google Ads: 10 + 50 + 36,57 against one invoice of 96,57", () => {
    const suggestions = suggestMatchGroups([line("c1", 1000, null, "2026-08-05"), line("c2", 5000, null, "2026-08-19"), line("invoice", -9657, "gads", "2026-08-31"), line("c3", 3657, null, "2026-09-02"), line("other", 4242, null, "2026-09-03")]);
    expect(suggestions).toEqual([{ accountId: "acc-1462", reason: "subset_sum", lineIds: ["c1", "c2", "c3", "invoice"], amountCents: 9657 }]);
  });

  it("lists same-document groups first and uses each line at most once", () => {
    const suggestions = suggestMatchGroups([line("inv", -150, "doc"), line("pay", 150, "doc"), line("x", -200), line("y", 200), line("z", 200)]);
    expect(suggestions.map((suggestion) => suggestion.reason)).toEqual(["same_document", "subset_sum"]);
    expect(new Set(suggestions.flatMap((suggestion) => suggestion.lineIds)).size).toBe(suggestions.flatMap((suggestion) => suggestion.lineIds).length);
  });

  it("does not combine more lines than allowed", () => {
    const parts = [1, 2, 3, 4, 5].map((n) => line(`p${n}`, 100));
    expect(suggestMatchGroups([line("big", -500), ...parts])).toEqual([]);
    expect(suggestMatchGroups([line("big", -500), ...parts], { maxSize: 5 })).toHaveLength(1);
  });
});
