# Writing invoices: ZUGFeRD via @itegro/einvoice, gapless numbers, append-only (GoBD)

Document type: decision
Lifecycle: active
Owner: src/modules/invoicing
Scope: `/dashboard/invoices/**`, `GET /api/invoices/[id]/file`, `GET /api/invoices/drafts/[id]/preview`,
`GET /api/invoices/export`, the tables `invoice_drafts`, `invoice_number_sequences`, `invoices`,
`invoice_events` (migrations 0026 and 0027), `DocumentUseCases.createForIssuedInvoice`, and the
invoice confirmation of `WorkspaceUseCases.deleteWorkspace`
Canonical responsibility: Active source for how Digipost issues and cancels its users' own
invoices, how they are numbered, and why an issued invoice can never be changed
Maintenance triggers:
- A user decision listed under "Decision" changes
- `@itegro/einvoice` is upgraded (rendering, rule sets, the input model)
- The number format, the issue-date rule, or the cancellation type code changes
- A new write path touches `invoices` or `invoice_events`
- German VAT or GoBD requirements for invoices change
Last verified: 2026-11-05, initial version, against `src/modules/invoicing/**`,
`src/persistence/use-cases/invoices-use-cases.ts`, `src/persistence/schema/invoices.ts`,
`src/persistence/sql/invoices_append_only/invoices_append_only.sql`, migrations
`0026_lucky_zarek.sql` and `0027_invoices_append_only.sql`, and the tests named under
"Verification"

## Status

Accepted. Builds on decisions/0015-documents-and-quotas.md (quota semantics),
decisions/0027-hardening-and-deletion.md (workspace deletion is one cascading `DELETE`),
decisions/0069-a-credit-note-is-money-coming-back.md (a negative outgoing total is money going
back out) and decisions/0004-three-database-roles.md (the runtime role's grants).

## Context

Digipost reads the mail a business receives, including its own outgoing invoices once they come
back as scans or PDFs. Users asked to WRITE their invoices in Digipost as well, as e-invoices
(in Germany every business must be able to receive B2B e-invoices since 2025, and issuing them
becomes mandatory in 2027 and 2028), with numbers that start
with the year, and in a way that satisfies the GoBD: an issued invoice is a booking document that
must not be changed or removed afterwards (immutability, traceability), only corrected by a new
document. Itegro maintains its own e-invoice library, `@itegro/einvoice` (npm, Apache-2.0), which
turns structured data into a ZUGFeRD/Factur-X PDF/A-3B with the CII XML embedded, computes every
amount itself to the cent, and validates the XML against the official Schematron rules in-process.

## Decision

User decisions, 2026-11-05:

1. **Every member may write invoices**, not only the admin. A new permission bundle
   `invoices.manage` (`src/platform/access`) is part of both roles.
2. **Numbers are `<year>-<sequence>`**, the sequence zero-padded to four digits (`2026-0001`) so
   they sort as text, restarting at 1 every calendar year. A fifth digit simply follows
   (`2026-10000`).
3. **Deleting a workspace stays possible** even with issued invoices, once the admin confirmed
   they downloaded every one (the danger zone offers the ZIP of all of them right there).
4. **Only full cancellation** ("Vollstorno") for now; a correction is a cancellation plus a new
   invoice.
5. **Every issued invoice also lands in the inbox** as an outgoing document, and counts against
   the document quota like an upload.
6. **ZUGFeRD is enough**: profile EN 16931, no XRechnung.

Design decisions that follow from them:

- **Drafts are not records.** A draft (`invoice_drafts`) has no number, was never sent, and may be
  edited or deleted freely. Its content is one jsonb document validated by Zod on every write. A
  draft may be saved incomplete; whether it is a valid invoice is decided by our own checks
  (`checkDraft`, `DP-INV-*`) plus the library's (`BR-*`), shown at "Prüfen", and again,
  authoritatively, at "Festschreiben".
- **The issue date is the day of finalizing** (Europe/Berlin), never chosen. It also decides the
  number's year, so numbers and dates always ascend together. The delivery date or service period
  (section 14 (4) no. 6 UStG) is chosen in the draft; the due date is the issue date plus the
  draft's payment term in days.
- **One write path for issuing**, used by finalizing and cancelling alike, in ONE transaction:
  lock the workspace row, take the next number (`insert ... on conflict do update ... returning`
  on `invoice_number_sequences`, whose row then stays locked until commit), render the PDF/XML
  with that number, store both under `workspaces/<id>/invoices/<invoiceId>/`, create the inbox
  document (`DocumentUseCases.createForIssuedInvoice`, inside the same transaction: authoritative
  quota check, its own copy of the PDF, usage counted, payment matching scheduled), insert the
  invoice and its `issued` event, and delete the draft. Any failure rolls everything back, the
  number returns to the range (no gap, no duplicate), and the objects already written are
  deleted again. The PDF is rendered while the workspace row is locked, because the number on it
  is only final at commit; that holds back a concurrent upload in the same workspace for the
  render time, accepted over either alternative (numbering after rendering leaves gaps or prints
  numbers that never commit).
- **Append-only, enforced by the database.** `invoices` and `invoice_events` have no update or
  delete method in the repository contract, and migration 0027 adds a trigger that refuses every
  UPDATE and TRUNCATE and every DELETE, for every role including the owner, plus a `revoke update,
  delete, truncate` from `app_runtime` on both tables. The only DELETE that passes is the one a
  workspace deletion cascades, recognized by its effect (the row's workspace no longer exists in
  that transaction), not by a session flag anyone could set. Postgres runs a foreign key's cascade
  with the referencing table owner's privileges, so the revoke does not block it.
- **No foreign keys that could turn into an UPDATE.** `invoices` keeps `createdByUserId`,
  `contactId` and `documentId` as plain values with a snapshot of what the invoice needs (the
  actor's e-mail, the buyer's data inside the stored input). An `on delete set null` would be an
  UPDATE the trigger refuses, which would block deleting that user, contact or inbox document.
  `cancels_invoice_id` references `invoices` with `no action` (checked at the end of the
  statement, so the workspace cascade can remove both rows).
- **The stored input is the record.** `einvoice_input` holds the complete input the files were
  rendered from; the library renders it byte-identically again (verified by a test). Together
  with the SHA-256 of the PDF and the XML (checked, and logged on a mismatch, on every download)
  this proves the archived files are unaltered.
- **Cancellation = a correction invoice (type code 384, "Rechnungskorrektur")** with every
  quantity negated and the original as its preceding invoice (BT-25/BT-26), built from the
  original's own stored input, so the totals are exactly the negated original to the cent. It
  takes its own number from the same range. Type 381 ("Gutschrift") is deliberately not used:
  in German VAT law a "Gutschrift" is a self-billed invoice (section 14 (2) UStG), and the
  library titles a 381 PDF that way. At most one cancellation per invoice (a partial unique
  index, behind the use case's own check); a cancellation cannot be cancelled.
- **The inbox document**: `kind: "outgoing_invoice"`, `direction: "outgoing"`, `status: "done"`,
  every field taken from the invoice, no OCR and no model call. Its buyer is linked as the
  customer contact after commit (best effort). A cancellation's total is negative
  (decisions/0069). When the cancelled invoice's document is still `open`/`overdue`, both
  documents are set to `settled` (nothing is owed either way); when it was paid, the cancellation
  stays `open`, and matching pairs it with the refund. Deleting the inbox document never touches
  the archived invoice.
- **Seller data comes from the company profile** ("Firmendaten"): address and either a VAT id or
  a tax number are required (section 14 (4) no. 2 UStG); the editor and the list say what is
  missing. The payment IBAN is one of the profile's own IBANs.
- **VAT**: 19 %, 7 % or 0 % per line. A 0 % line needs one invoice-level reason: small business
  (section 19 UStG, category E), reverse charge (category AE, needs the buyer's VAT id) or another
  exemption with its legal reason (category E). One reason per invoice because EN 16931 allows one
  exemption reason per VAT category.
- **The Factur-X Schematron rule sets are not installed.** Their licence forbids redistribution;
  `npx einvoice-setup-facturx` would download them at install time, which needs network access in
  CI and the build. Without them the XML is still validated against EN 16931, which is complete for
  this profile; the library's `IF-WARN-100` is expected and ignored.
- **Deployment**: `next.config.ts` keeps the package external (`serverExternalPackages`) and
  includes its fonts and rule sets in the trace of every route that renders or validates
  (`outputFileTracingIncludes` for `/dashboard/invoices/**` and `/api/invoices/**`): the
  library computes those paths at runtime. The first render in a fresh function loads the rule
  sets (a few seconds, about 200 MB); Vercel's default function memory suffices.

## Consequences

- An issued invoice can only ever be cancelled, never edited, by anyone, including through a
  hand-written query on the runtime connection. A mistake found after "Festschreiben" costs a
  cancellation and a new invoice, which is exactly what the GoBD expects; the editor's
  confirmation says so.
- Workspace deletion now has a second confirmation when invoices exist
  (`WORKSPACE_ERROR.invoicesNotArchived`). The retention duty (8 years, section 147 AO) stays with
  the business after that; Digipost does not keep a copy of a deleted workspace.
- `AGENTS.md`'s "Nothing is auto-deleted except one thing" is unchanged: invoices are deleted
  only by a human deleting the whole workspace.
- An issued invoice counts as a document (decisions/0015): the monthly limit counts it, deleting
  its inbox document frees the total limit, and a workspace over its limit cannot issue until it
  has room (`quota_*_exceeded`, checked before rendering and again in the transaction).
- The invoices themselves are not sent anywhere by Digipost (no e-mail sending yet), so no new
  sub-processor is involved. The PDF/XML live in the same object storage as every document.
- Not built yet, deliberately: sending invoices by e-mail, recurring invoices, partial
  cancellations and credit notes for single lines, XRechnung, an object lock on the storage
  bucket (the database guarantees immutability of the record and the hash proves the files, but
  the bucket itself does not refuse a delete).

## Verification

- `src/modules/invoicing/tests/*.test.ts`: numbering and Berlin issue dates, the draft-to-input
  mapping and the cancellation input, our own checks, violation locations, i18n coverage, and the
  real library (totals to the cent, determinism, the cancellation's negated totals, the inbox's own
  ZUGFeRD reader reading an issued invoice back).
- `src/persistence/tests/invoices-use-cases.test.ts`: numbering, rollback and cleanup on a failed
  render or a quota error, the double finalize, cancellation rules, workspace scoping, the archive.
- `src/persistence/tests/invoices-repository.db.test.ts` (real Postgres): the gapless range under
  rollback and concurrency, the unique and check constraints, `app_runtime` refused UPDATE/DELETE,
  the owner refused UPDATE/DELETE/TRUNCATE by the trigger, and the workspace cascade allowed.
- `src/persistence/tests/workspaces-repository.db.test.ts`: the four tables joined the cascade
  test (decisions/0027's "Cascade verification").
- `src/persistence/tests/workspaces-use-cases.test.ts`: deletion refused without, and allowed with,
  the invoice confirmation.
