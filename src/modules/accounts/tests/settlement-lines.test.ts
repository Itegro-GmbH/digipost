// Owner: src/modules/accounts (F4, decisions/0026-platform-settlements.md). Exercises
// `buildSettlementLineDrafts` against F1a's real Stripe/Apple fixtures, routed through the
// SAME pipeline the real import uses: `sampleTabular` -> the fake `IntakeClassifier` (its own
// header-signature table already recognizes both fixtures, `@/modules/intake/core/fake-intake-classifier.ts`)
// -> `validateMapping` -> `buildSettlementLineDrafts`. This is deliberately an end-to-end
// exercise of the whole normalization chain, not a table of hand-built `NormalizedSettlementLine`
// objects, so a drift in any earlier step (the fake classifier's own mapping, `validateMapping`'s
// settlement-line branch) would break this test too.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseCsvSync } from "csv-parse/sync";
import { describe, expect, it } from "vitest";

import {
  createFakeIntakeClassifier,
  parseApplePaymentSummary,
  parseGooglePlayEarnings,
  sampleTabular,
  validateMapping,
  type DelimiterChar,
  type NormalizedSettlementLine,
} from "@/modules/intake";

import { buildSettlementLineDrafts, settlementFeeEffectCents } from "../core/settlement-lines";

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../intake/tests/fixtures/${name}`, import.meta.url)), "utf8");
}

async function settlementLinesFor(fixtureName: string, delimiter: DelimiterChar): Promise<NormalizedSettlementLine[]> {
  const text = readFixture(fixtureName);
  const sample = sampleTabular(text, { delimiter });
  const records = parseCsvSync(text, { delimiter, relax_column_count: true, skip_empty_lines: true, bom: true }) as string[][];
  const rows = records.slice(1);

  const classifier = createFakeIntakeClassifier();
  const classification = await classifier.classify({ kind: "tabular", sample });
  if (!classification.columnMapping) throw new Error(`fake classifier did not recognize ${fixtureName}`);

  const result = validateMapping(sample, rows, classification.columnMapping, classification.amountSign);
  if (!result.ok || result.kind !== "settlement_lines") throw new Error(`expected settlement_lines for ${fixtureName}, got ${JSON.stringify(result)}`);
  return result.lines;
}

describe("buildSettlementLineDrafts - Stripe payout report", () => {
  it("splits each charge row into a revenue line and a fee line, and each refund row into a refund line", async () => {
    const lines = await settlementLinesFor("stripe-payout.csv", ",");
    const drafts = buildSettlementLineDrafts(lines);

    const revenue = drafts.filter((d) => d.type === "revenue");
    const fee = drafts.filter((d) => d.type === "fee");
    const refund = drafts.filter((d) => d.type === "refund");
    const payout = drafts.filter((d) => d.type === "payout");

    // 5 rows: 4 charges (gross >= 0) + 1 refund (gross < 0).
    expect(revenue).toHaveLength(4);
    expect(refund).toHaveLength(1);
    // Every row has a non-zero fee except the refund row (fee 0.00 in the fixture).
    expect(fee).toHaveLength(4);
    // Two distinct `automatic_payout_id`s in the fixture.
    expect(payout).toHaveLength(2);
  });

  it("derives a positive credit for a revenue line and a negative debit for a fee/refund line", async () => {
    const lines = await settlementLinesFor("stripe-payout.csv", ",");
    const drafts = buildSettlementLineDrafts(lines);

    const firstRevenue = drafts.find((d) => d.type === "revenue" && d.chargeId === "ch_1AbCdEfGh001");
    expect(firstRevenue).toMatchObject({ transactionAmountCents: 9900, remittanceText: "RE-2026-1001" });

    const matchingFee = drafts.find((d) => d.type === "fee" && d.chargeId === "ch_1AbCdEfGh001");
    expect(matchingFee).toMatchObject({ transactionAmountCents: -317 });

    const refund = drafts.find((d) => d.type === "refund");
    expect(refund).toMatchObject({ transactionAmountCents: -4900 });
  });

  it("synthesizes one payout draft per distinct payoutId, summing that group's net amounts as a debit", async () => {
    const lines = await settlementLinesFor("stripe-payout.csv", ",");
    const drafts = buildSettlementLineDrafts(lines);
    const payouts = drafts.filter((d) => d.type === "payout").sort((a, b) => a.payoutId!.localeCompare(b.payoutId!));

    // Payout 1: rows 1+2, net 9583 + 4728 = 14311 -> a debit of -14311.
    expect(payouts[0]).toMatchObject({ payoutId: "po_1AbCdEfGhPayout01", transactionAmountCents: -14311 });
    // Payout 2: rows 3+4+5, net -4900 + 24302 + 2785 = 22187 -> a debit of -22187.
    expect(payouts[1]).toMatchObject({ payoutId: "po_1AbCdEfGhPayout02", transactionAmountCents: -22187 });
  });

  it("gives every draft a deterministic externalLineId, stable across a reimport of the identical file", async () => {
    const lines = await settlementLinesFor("stripe-payout.csv", ",");
    const once = buildSettlementLineDrafts(lines).map((d) => d.externalLineId);
    const again = buildSettlementLineDrafts(lines).map((d) => d.externalLineId);
    expect(again).toEqual(once);
    expect(new Set(once).size).toBe(once.length); // no two drafts collide
  });
});

describe("buildSettlementLineDrafts - Apple financial report", () => {
  it("reads a 'Sales or Return' indicator row as a refund (negative), never a revenue line", async () => {
    const lines = await settlementLinesFor("apple-financial-report.tsv", "\t");
    const drafts = buildSettlementLineDrafts(lines);

    const refund = drafts.filter((d) => d.type === "refund");
    const revenue = drafts.filter((d) => d.type === "revenue");
    // 4 rows: 3 sales (S) + 1 return (R).
    expect(revenue).toHaveLength(3);
    expect(refund).toHaveLength(1);
    expect(refund[0]!.transactionAmountCents).toBeLessThan(0);
  });

  it("never synthesizes a payout draft when the report has no payoutId column at all", async () => {
    const lines = await settlementLinesFor("apple-financial-report.tsv", "\t");
    const drafts = buildSettlementLineDrafts(lines);
    expect(drafts.some((d) => d.type === "payout")).toBe(false);
  });
});

// decisions/0048-app-store-reports.md: the real Apple payment-summary/Google Play earnings
// fixtures, routed through the two new DETERMINISTIC readers (no classifier involved at all -
// that is the whole point of these two formats) straight into `buildSettlementLineDrafts`,
// exactly the path `AccountsUseCases.importFromDocument` actually takes.
function readIntakeFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../intake/tests/fixtures/${name}`, import.meta.url)), "utf8");
}

describe("buildSettlementLineDrafts - Apple payment summary (real report)", () => {
  it("produces one revenue draft per region, no fee drafts, and no synthesized payout draft", () => {
    const parsed = parseApplePaymentSummary(readIntakeFixture("apple-payment-summary.csv"));
    const drafts = buildSettlementLineDrafts(parsed.lines);

    expect(drafts.filter((d) => d.type === "revenue")).toHaveLength(4);
    expect(drafts.filter((d) => d.type === "fee")).toHaveLength(0);
    expect(drafts.filter((d) => d.type === "payout")).toHaveLength(0);
    const revenueSum = drafts.filter((d) => d.type === "revenue").reduce((sum, d) => sum + d.transactionAmountCents, 0);
    expect(revenueSum).toBe(parsed.payoutAmountCents);
  });
});

describe("buildSettlementLineDrafts - Google Play earnings (real report)", () => {
  it("produces one revenue draft per Charge and one fee draft per Google fee, no payout draft", () => {
    const parsed = parseGooglePlayEarnings(readIntakeFixture("google-play-earnings.csv"));
    const drafts = buildSettlementLineDrafts(parsed.lines);

    expect(drafts.filter((d) => d.type === "revenue")).toHaveLength(4);
    expect(drafts.filter((d) => d.type === "fee")).toHaveLength(4);
    expect(drafts.filter((d) => d.type === "payout")).toHaveLength(0);

    const netSum = drafts.reduce((sum, d) => sum + d.transactionAmountCents, 0);
    expect(netSum).toBe(parsed.netAmountCents);
  });
});

// A "Google fee refund" (+10,71 for "Yearly (Planties)" in the owner's July 2026 report) was
// stored as revenue, overstating revenue and fees by the same amount. It is a fee line now whose
// transaction CREDITS the clearing account; a charge refund stays a refund.
describe("buildSettlementLineDrafts - Google Play fee refunds", () => {
  const parsed = parseGooglePlayEarnings(readIntakeFixture("google-play-earnings-all-row-types.csv"));
  const drafts = buildSettlementLineDrafts(parsed.lines);
  const byType = (type: string) => drafts.filter((d) => d.type === type).map((d) => [d.externalLineId, d.transactionAmountCents, d.feeCents, d.netCents]);

  it("books the refunded fee as a fee line with a positive amount", () => {
    expect(byType("fee")).toEqual([
      ["fee:row2", -146, -146, -146],
      ["fee:row4", 75, 75, 75],
    ]);
  });

  it("keeps charges as revenue and the charge refund and the withheld tax as refunds", () => {
    expect(byType("revenue")).toEqual([["revenue:row1", 973, null, 973]]);
    expect(byType("refund")).toEqual([
      ["refund:row3", -503, null, -503],
      ["refund:row5", -197, null, -197],
    ]);
  });

  it("still adds up to the report's own net", () => {
    expect(drafts.reduce((sum, d) => sum + d.transactionAmountCents, 0)).toBe(parsed.netAmountCents);
  });
});

describe("settlementFeeEffectCents", () => {
  it("deducts a fee stated as a positive magnitude next to its sale (Stripe)", () => {
    expect(settlementFeeEffectCents({ grossCents: 1000, feeCents: 30, netCents: 970 })).toBe(-30);
  });

  it("moves the account by a fee-only row's own signed net (Google fee and fee refund)", () => {
    expect(settlementFeeEffectCents({ grossCents: null, feeCents: -146, netCents: -146 })).toBe(-146);
    expect(settlementFeeEffectCents({ grossCents: null, feeCents: 1071, netCents: 1071 })).toBe(1071);
  });

  it("falls back to a deduction when a fee-only row's net is not the fee itself", () => {
    expect(settlementFeeEffectCents({ grossCents: null, feeCents: 30, netCents: 970 })).toBe(-30);
    expect(settlementFeeEffectCents({ grossCents: null, feeCents: 30, netCents: null })).toBe(-30);
  });
});
