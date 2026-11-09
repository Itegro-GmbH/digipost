// Stable error codes (AGENTS.md "Code": `as const` sets, never raw text). `ui/*.tsx` maps them
// to `Invoicing.errors` in `de.json`. Mirrors `src/persistence/use-cases/invoices-use-cases.ts`'s
// `INVOICE_ERROR`, the two document quota codes a finalization can hit, `invalid_input` (a Zod
// parse failure in `actions.ts`), the `WorkspaceAccessErrorCode`s `requirePermission` returns,
// and `unknown`.
export const INVOICE_ACTION_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "company_profile_incomplete",
  "invoice_invalid",
  "already_cancelled",
  "not_cancellable",
  "quota_total_exceeded",
  "quota_monthly_exceeded",
  "unauthenticated",
  "no_workspace",
  "forbidden",
  "unknown",
] as const;
export type InvoiceActionErrorCode = (typeof INVOICE_ACTION_ERROR_CODES)[number];
