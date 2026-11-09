import { describe, expect, it } from "vitest";

import { emptyDraftContent, invoiceDraftContentSchema, parseStoredDraftContent } from "@/modules/invoicing";

describe("invoiceDraftContentSchema", () => {
  it("accepts the empty draft: a draft may be saved incomplete", () => {
    expect(invoiceDraftContentSchema.safeParse(emptyDraftContent()).success).toBe(true);
  });

  it("normalizes a German decimal comma to a dot", () => {
    const content = emptyDraftContent();
    content.lines[0]!.unitPrice = "95,50";
    const parsed = invoiceDraftContentSchema.parse(content);
    expect(parsed.lines[0]!.unitPrice).toBe("95.50");
  });

  it.each(["abc", "1.23456", "-5"])("rejects the price %s", (unitPrice) => {
    const content = emptyDraftContent();
    content.lines[0]!.unitPrice = unitPrice;
    expect(invoiceDraftContentSchema.safeParse(content).success).toBe(false);
  });

  it("strips an unknown key, so nothing unvalidated reaches the stored draft", () => {
    expect(invoiceDraftContentSchema.parse({ ...emptyDraftContent(), number: "2026-0001" })).not.toHaveProperty("number");
  });
});

describe("parseStoredDraftContent", () => {
  it("falls back to the empty draft for a shape it no longer understands", () => {
    expect(parseStoredDraftContent({ lines: "nope" })).toEqual(emptyDraftContent());
  });
});
