// Maps a violation's input path (the e-invoice library's, or our own `DP-*` checks') onto
// the editor field it concerns, so the UI can say WHERE something is wrong in German without
// ever showing the library's English message as copy (decisions/0013-german-ui-language.md).
import type { InvoiceViolation } from "./types";

export const VIOLATION_FIELDS = [
  "lines",
  "line_name",
  "line_quantity",
  "line_price",
  "line_vat",
  "line_other",
  "buyer_name",
  "buyer_address",
  "buyer_vat_id",
  "buyer_email",
  "seller",
  "payment",
  "delivery",
  "tax_exemption",
  "exemption_reason",
  "other",
] as const;
export type ViolationField = (typeof VIOLATION_FIELDS)[number];

export type LocatedViolation = { field: ViolationField; lineIndex: number | null; rule: string };

const LINE_PATH = /^lines\[(\d+)\](?:\.(\w+))?/;

function lineField(attribute: string | undefined): ViolationField {
  switch (attribute) {
    case "name":
    case "description":
      return "line_name";
    case "quantity":
    case "unit":
      return "line_quantity";
    case "unitPrice":
    case "priceBaseQuantity":
      return "line_price";
    case "vat":
      return "line_vat";
    default:
      return "line_other";
  }
}

export function locateViolation(violation: InvoiceViolation): LocatedViolation {
  const { path, rule } = violation;
  const line = LINE_PATH.exec(path);
  if (line) return { field: lineField(line[2]), lineIndex: Number(line[1]), rule };
  if (path === "lines") return { field: "lines", lineIndex: null, rule };
  if (path === "buyer.name") return { field: "buyer_name", lineIndex: null, rule };
  if (path.startsWith("buyer.address")) return { field: "buyer_address", lineIndex: null, rule };
  if (path.startsWith("buyer.vatId") || path.startsWith("buyer.legalRegistration")) return { field: "buyer_vat_id", lineIndex: null, rule };
  if (path.startsWith("buyer.contact") || path.startsWith("buyer.electronicAddress")) return { field: "buyer_email", lineIndex: null, rule };
  if (path.startsWith("seller")) return { field: "seller", lineIndex: null, rule };
  if (path.startsWith("payment")) return { field: "payment", lineIndex: null, rule };
  if (path.startsWith("delivery") || path.startsWith("period")) return { field: "delivery", lineIndex: null, rule };
  if (path === "taxExemption" || path.startsWith("vat")) return { field: "tax_exemption", lineIndex: null, rule };
  if (path === "exemptionReason") return { field: "exemption_reason", lineIndex: null, rule };
  return { field: "other", lineIndex: null, rule };
}
