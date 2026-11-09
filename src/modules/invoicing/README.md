# src/modules/invoicing

Document type: reference
Lifecycle: active
Owner: src/modules/invoicing
Scope: Writing invoices: drafts, "Festschreiben" into a numbered ZUGFeRD invoice, the full
cancellation ("Stornorechnung"), the archive download, and the `/dashboard/invoices/**` pages
Canonical responsibility: Issuing a workspace's own invoices, numbering them without gaps, and
keeping every issued one unchanged (GoBD)
Maintenance triggers:
- The number format, the issue-date rule, or the cancellation type code changes
- `@itegro/einvoice` is upgraded, or its input model changes
- A new VAT treatment, unit, or draft field is added (`de.json`'s `Invoicing`)
- A new write path touches `invoices` or `invoice_events`
Last verified: 2026-11-05, decisions/0079-outgoing-invoices.md (initial implementation)

## Purpose

Every member writes invoices here (`invoices.manage`, both roles). A draft is edited freely; "Prüfen"
shows what is still missing, "Vorschau" the PDF with an "ENTWURF" watermark, and "Festschreiben"
issues it: today's date, the next number of the year (`2026-0001`), a ZUGFeRD PDF/A-3B with the
CII XML embedded, archived together with the XML and an inbox document. From then on the invoice
can only be cancelled, by a new numbered correction invoice. See
decisions/0079-outgoing-invoices.md for every decision behind this.

## Layout

- `core/types.ts`: the closed value sets (invoice types, event kinds, VAT rates, tax exemptions,
  units, missing seller fields) and the view shapes.
- `core/numbering.ts`: `formatInvoiceNumber`, `issueDateFor` (Europe/Berlin), `addDays`.
- `core/schemas.ts`: the draft content's Zod schema (shape only: a draft may be incomplete), the
  action inputs, `emptyDraftContent`.
- `core/einvoice-input.ts`: `buildInvoiceInput` (draft plus company profile to the library's
  `InvoiceInput`), `buildCancellationInput` (the stored input of an issued invoice to its full
  cancellation, type 384, quantities negated), `checkDraft` (our own `DP-INV-*` checks),
  `missingSellerFields`. Type-only imports from `@itegro/einvoice`.
- `core/ports.ts`: the `InvoiceRenderer` port and `InvoiceValidationError`.
- `core/violation-fields.ts`: maps a violation's input path to the editor field it concerns, so
  the UI explains it in German instead of showing the library's English message.
- `core/file-names.ts`, `core/error-codes.ts`.
- `server/einvoice-renderer.ts`: the one adapter of the port, on `@itegro/einvoice` (`check`
  without rendering, `render` with Schematron validation). The only runtime import of the library.
- `server/read-models.ts`: the page projections. `server/archive.ts`: the ZIP of every issued
  invoice, streamed through `src/modules/closing`'s archive writer.
- `ui/`: the list (`invoices-page-client.tsx`), the editor (`invoice-draft-editor.tsx`), the
  read-only detail with "Stornieren" (`invoice-detail-client.tsx`).
- `actions.ts`: create/save/delete a draft, finalize, cancel; each behind
  `requirePermission(PERMISSIONS.invoicesManage)` and scoped to the caller's own workspace.

## Public interfaces

- `index.ts` (neutral): the pure domain above, used by `src/persistence/use-cases/invoices-use-cases.ts`
  and `src/persistence/schema/invoices.ts`.
- `server.ts`: the read models, `createInvoiceArchive`/`invoiceArchiveFileName` (for
  `GET /api/invoices/export`), `getInvoiceRenderer` (bound by the composition root),
  `countIssuedInvoicesProjection` (the workspace deletion's danger zone).
- `client.ts`: `InvoicesPageClient`, `InvoiceDraftEditor`, `InvoiceDetailClient`.
- `actions.ts`: `createInvoiceDraftAction`, `saveInvoiceDraftAction`, `deleteInvoiceDraftAction`,
  `finalizeInvoiceDraftAction`, `cancelInvoiceAction`.
- Routes: `GET /api/invoices/[id]/file?format=pdf|xml` (archived files),
  `GET /api/invoices/drafts/[id]/preview` (watermarked preview, nothing stored),
  `GET /api/invoices/export` (ZIP of all).

## Data

Tables `invoice_drafts`, `invoice_number_sequences`, `invoices`, `invoice_events`
(`src/persistence/schema/invoices.ts`, migration `0026_lucky_zarek.sql`), written only by
`src/persistence/repositories/drizzle/invoices-repository.ts`. All four cascade from
`workspaces.id`. `invoices` and `invoice_events` are append-only: the repository contract has no
update or delete for them, and migration `0027_invoices_append_only.sql`
(source `src/persistence/sql/invoices_append_only/`) adds a trigger refusing every UPDATE,
TRUNCATE and DELETE except a workspace deletion's cascade, and revokes UPDATE/DELETE/TRUNCATE
from `app_runtime`. Files: `workspaces/<id>/invoices/<invoiceId>/invoice.pdf` and `factur-x.xml`
(`invoiceFileKey`, `src/platform/object-storage`), separate from the inbox document's own copy.

The inbox document is created by `src/modules/documents` (`DocumentUseCases.createForIssuedInvoice`,
inside the issuing transaction), never written here.

## Tests

`tests/` (unit: numbering, the input mapping and cancellation, the checks, violation locations,
schemas, i18n coverage, and the real renderer), `src/persistence/tests/invoices-use-cases.test.ts`
(the use cases with fakes), `src/persistence/tests/invoices-repository.db.test.ts` (number range,
constraints, append-only against real Postgres).
