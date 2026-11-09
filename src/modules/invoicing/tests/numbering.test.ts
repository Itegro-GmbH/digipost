import { describe, expect, it } from "vitest";

import { addDays, formatInvoiceNumber, issueDateFor, yearOfIsoDate } from "@/modules/invoicing";

describe("formatInvoiceNumber (decisions/0079-outgoing-invoices.md)", () => {
  it("starts with the year, then a dash, then the zero-padded sequence", () => {
    expect(formatInvoiceNumber(2026, 1)).toBe("2026-0001");
    expect(formatInvoiceNumber(2026, 42)).toBe("2026-0042");
  });

  it("keeps counting past four digits", () => {
    expect(formatInvoiceNumber(2026, 12345)).toBe("2026-12345");
  });

  it("sorts as text in issue order within a year", () => {
    const numbers = [1, 2, 10, 100, 999].map((sequence) => formatInvoiceNumber(2026, sequence));
    expect([...numbers].sort()).toEqual(numbers);
  });

  it.each([0, -1, 1.5])("rejects sequence %s", (sequence) => {
    expect(() => formatInvoiceNumber(2026, sequence)).toThrow(RangeError);
  });
});

describe("issueDateFor", () => {
  it("uses German local time: 00:30 on 1 January in Berlin is already the new year", () => {
    expect(issueDateFor(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
    expect(yearOfIsoDate(issueDateFor(new Date("2026-12-31T23:30:00Z")))).toBe(2027);
  });

  it("is still the old day late in the evening UTC in summer", () => {
    expect(issueDateFor(new Date("2026-07-14T21:59:00Z"))).toBe("2026-07-14");
    expect(issueDateFor(new Date("2026-07-14T22:00:00Z"))).toBe("2026-07-15");
  });
});

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-12-20", 14)).toBe("2027-01-03");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-05-01", 0)).toBe("2026-05-01");
  });
});
