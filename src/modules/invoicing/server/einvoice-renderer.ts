import "server-only";

// The `InvoiceRenderer` port's one real adapter (decisions/0079-outgoing-invoices.md), on top
// of `@itegro/einvoice`: cent-exact calculation, the EN 16931 rule checks, the CII XML (checked
// against the official Schematron rules in-process) and the PDF/A-3B with that XML embedded
// (ZUGFeRD). No network access, no credentials. The library is deterministic: the same input
// renders a byte-identical PDF, which is what makes the stored input a complete record.
//
// Loaded lazily (`import()` on first use), never at module load: the composition root imports
// this file for every request, and the library pulls in SaxonJS, react-pdf and pdf-lib, which
// would otherwise slow down every route's cold start, not only the invoicing ones.
import type { InvoiceInput, Violation } from "@itegro/einvoice";

import { InvoiceValidationError, type InvoiceRenderer } from "../core/ports";
import type { InvoiceTotalsCents, InvoiceViolation } from "../core/types";

/** The library's money type is decimal.js; amounts here are always 2-decimal results. */
type DecimalLike = { times(value: number): { toNumber(): number } };

function toCents(value: DecimalLike): number {
  return Math.round(value.times(100).toNumber());
}

function toViolations(violations: readonly Violation[]): InvoiceViolation[] {
  return violations.map((violation) => ({ rule: violation.rule, path: violation.path, message: violation.message }));
}

type Einvoice = typeof import("@itegro/einvoice");
let library: Promise<Einvoice> | undefined;

function loadLibrary(): Promise<Einvoice> {
  library ??= import("@itegro/einvoice");
  return library;
}

function totalsOf(lib: Einvoice, input: InvoiceInput): InvoiceTotalsCents {
  const { totals } = lib.calculate(lib.normalize(input));
  return { netCents: toCents(totals.taxExclusiveAmount), vatCents: toCents(totals.taxTotal), grossCents: toCents(totals.taxInclusiveAmount) };
}

export function createEinvoiceRenderer(): InvoiceRenderer {
  return {
    async check(input) {
      const lib = await loadLibrary();
      try {
        const calculated = lib.calculate(lib.normalize(input));
        const { violations } = lib.validate(calculated);
        const { totals } = calculated;
        return {
          violations: toViolations(violations),
          totals: { netCents: toCents(totals.taxExclusiveAmount), vatCents: toCents(totals.taxTotal), grossCents: toCents(totals.taxInclusiveAmount) },
        };
      } catch (err) {
        if (err instanceof lib.InvoiceError) return { violations: toViolations(err.violations), totals: null };
        throw err;
      }
    },

    async render(input, options) {
      const lib = await loadLibrary();
      try {
        // The Factur-X Schematron rule sets are not installed (their licence forbids
        // redistribution, decisions/0079): the XML is still checked against EN 16931, which is
        // complete for this profile, and the library's `IF-WARN-100` saying so is expected.
        const result = await lib.generate(input, {
          template: { template: "classic" },
          ...(options?.watermark ? { watermark: options.watermark } : {}),
        });
        return { pdf: result.pdf, xml: result.xml, pageCount: result.meta.pages, totals: totalsOf(lib, input) };
      } catch (err) {
        if (err instanceof lib.InvoiceError) throw new InvoiceValidationError(toViolations(err.violations));
        throw err;
      }
    },
  };
}

let renderer: InvoiceRenderer | undefined;

/** Lazy singleton, the same shape as `getObjectStorage()`: the composition root binds it. */
export function getInvoiceRenderer(): InvoiceRenderer {
  renderer ??= createEinvoiceRenderer();
  return renderer;
}
