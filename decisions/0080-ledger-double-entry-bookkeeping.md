# An own ledger: double-entry bookkeeping with open-item accounts, editable until filed

Document type: decision
Lifecycle: active
Owner: src/modules/ledger
Scope: The general ledger (chart of accounts, journal entries and their lines, tax codes,
open-item accounts and their matches, booking rules, filings), how booking proposals are made
from documents, transactions and settlement reports, what stays editable and what is locked,
and the controls the ledger runs. Not the export to the tax advisor (a later decision)
Canonical responsibility: Active source for how Digipost keeps its own books and why a booking
stays editable until it reaches the tax office
Maintenance triggers:
- A user decision listed under "Decision" changes
- A phase below is implemented (update its status and the owner README)
- The lock rule (what a filing freezes) changes
- The existing clearing accounts (decisions/0026, decisions/0068) are migrated onto the ledger
- The export format to the tax advisor is decided
Last verified: 2026-11-12, fixes after the acceptance replay and an independent review: the 2970
carry-forward, the commissionaire-only settlement template, bank-transaction rules by remittance
text and money direction, the correcting filing taken when booking into a locked period, and
concurrent writers (migration `0033_flippant_mercury.sql`), against `src/modules/ledger/core/`,
`src/persistence/use-cases/ledger-use-cases.ts` and `src/modules/ledger/README.md`. Previously
2026-11-12, phases 1 to 6 implemented including the UI (status updated), against
`src/app/(app)/dashboard/buchhaltung/**`, `src/modules/ledger/ui/` and
`src/modules/ledger/README.md`'s "UI". Previously 2026-11-12, phase 3 implemented (the proposal engine with rules and the AI
advisor, plus the automatic matches of phase 4), against `src/modules/ledger/core/proposals.ts`,
`src/persistence/use-cases/ledger-use-cases.ts` and migration `0032_icy_medusa.sql`. Previously
2026-11-12, phase 2 implemented (tax fields on `documents`,
`DocumentRepository.listForLedger`), against `src/persistence/schema/documents.ts` and
`src/modules/documents/core/tax-fields.ts`. Previously 2026-11-12, stage 1 implemented (core, persistence, use cases, actions): status,
"Model as implemented" and "Cascade verification" added, against `src/persistence/schema/ledger.ts`,
`src/persistence/sql/ledger_balanced_entries/`, `src/persistence/sql/ledger_filing_lock/` and
`src/persistence/tests/workspaces-repository.db.test.ts`. Previously 2026-11-12, initial proposal, against `src/persistence/schema/accounts.ts`,
`src/persistence/schema/payments.ts`, `src/persistence/schema/documents.ts`,
decisions/0026-platform-settlements.md, decisions/0066-abschluss-check-and-export.md,
decisions/0068-supplier-clearing-accounts.md, decisions/0079-outgoing-invoices.md, and the
reconciliation of the tax advisor's evaluations for June to September 2026

## Status

Accepted, being implemented: phases 1 to 6 are implemented, phase 7 (the export to the tax
advisor) is pending. Stage 1 is the ledger core in `src/modules/ledger`
and `src/persistence/use-cases/ledger-use-cases.ts`: the tables below, the SKR 04 seed, tax codes
and their expansion, entries with revisions, booking, open-item matches, booking rules, filings
and the lock, handovers, the tax advisor's balance lists, every report and control, and the
Server Actions. Phase 2 (the new extraction fields) is implemented: see "Documents need more
extracted fields" below. Phase 3 (proposals from documents, bank transactions, settlement reports
and outgoing invoices, with rules and the AI) is implemented, together with phase 4's automatic
and suggested open-item matches: see "Proposals as implemented (phase 3)" below. The UI for every
phase is implemented under `/dashboard/buchhaltung` (overview, review queue, editor, journal,
accounts with Kontenblatt and open-item matching, USt-VA preview, the comparison with the tax
advisor, periods with handover, filing and correction, settings for the chart and the rules;
`src/modules/ledger/README.md`, "UI"). Still open within phase 4: the existing clearing accounts
(decisions/0026, decisions/0068) are not migrated; both representations coexist (see
"Consequences"). Builds on decisions/0024-accounts-and-transactions.md,
decisions/0026-platform-settlements.md, decisions/0068-supplier-clearing-accounts.md,
decisions/0066-abschluss-check-and-export.md and decisions/0079-outgoing-invoices.md.

## Context

Today Itegro collects its documents in Digipost, matches them against the bank account,
exports a monthly overview and sends it to the tax advisor. She books everything again in
DATEV on SKR 04 accounts and sends evaluations back (BWA, Summen- und Saldenliste, USt-VA),
which then have to be checked against Digipost by hand. Checking June to September 2026 that
way found, among others: a bank debit of 50,00 EUR never booked (Google Ads, 19.08.), one Meta
invoice of 0,15 EUR missing from the Meta clearing account, input VAT taken on a notary's
pass-through costs, and VAT treated inconsistently across Finom, Apple and Google. Every one of
those is caught mechanically by a ledger that must agree with the bank to the cent.

Digipost has the real-world side already: documents with extracted fields, imported bank
transactions, document-to-transaction matching, settlement lines from Apple/Google reports,
and clearing accounts for platforms (decisions/0026) and for one supplier billed by threshold
(decisions/0068). What it lacks is the interpretation: journal entries with a debit and a
credit side on real ledger accounts. The clearing accounts work around that gap by writing
synthetic transactions onto pseudo bank accounts, and they exist only for the cases someone
wrote code for.

## Decision

User decisions, 2026-11-12:

1. **An internal controlling and bookkeeping tool, not a product feature.** It is built for
   Itegro's own books first and is not offered to customers. It is enabled per workspace and
   off by default.
2. **Real double-entry bookkeeping inside Digipost**: SKR 04 accounts, journal entries with
   balanced lines, tax codes, the books the tax advisor keeps, kept by us first.
3. **Clearing accounts are generic.** Any ledger account can carry open items (a supplier, a
   customer, a platform, a shareholder's expenses, a credit card, money in transit), created
   without new code, not only the ones for providers Itegro uses today.
4. **Everything stays editable until it reaches the tax office.** Corrections are normal and
   frequent. Only what is filed (a submitted USt-VA, an annual statement) is locked.
5. **The export to the tax advisor is decided later.**

Design decisions that follow from them:

### Two layers: sources and interpretation

The existing tables (`documents`, `transactions`, `settlement_lines`, `invoices`) stay the
sources and are never rewritten by the ledger. The ledger is a separate owner,
`src/modules/ledger`, whose tables only ever reference them. Every journal entry points to the
document and, where there is one, the transaction it explains. A bank transaction is a fact;
the ledger has to agree with it, never the other way round.

### Data model (sketch, final shapes come with each phase)

- `ledger_accounts`: number (SKR 04), name, kind (asset, liability, equity, revenue,
  expense), `open_items` flag, optional owner: a bank account (`accounts.id`, the 1800
  counterpart), a contact, a platform, or a person (a shareholder). Seeded from an SKR 04
  subset, extendable per workspace.
- `journal_entries`: booking date, document date, service date, text, status (`proposed`,
  `booked`), origin (`template`, `rule`, `ai`, `manual`), document id, transaction id,
  settlement line ids.
- `journal_lines`: account, signed amount in cents (debit positive, credit negative), tax
  code, optional open-item reference. The lines of one entry sum to zero; a booked entry that
  does not balance is rejected by the database, not only by the UI.
- `tax_codes`: input VAT 19 % and 7 %, reverse charge (§ 13b, produces both the 1407 and the
  3837 line), not taxable, tax exempt, pass-through (durchlaufender Posten), each mapped to
  the USt-VA field it feeds.
- `open_item_matches`: which lines of an open-item account settle each other (one to one, one
  to many, partial).
- `booking_rules`: contact (or counterparty pattern) to expense/revenue account, tax code and
  open-item account. Learned from confirmations.
- `journal_entry_revisions`: the full previous state of an entry on every change (who, when,
  why), so it is always visible what changed since the last state sent to the tax advisor.
- `filings`: a submitted USt-VA (period) or annual statement (year), with the date it was
  submitted. The lock below hangs off it.

Every table is workspace-owned and cascades from `workspaces.id` (decisions/0027). Reads need
`finance.read`, writes `finance.manage` (decisions/0024), like every other finance table.

### Open-item accounts replace special-case clearing

One mechanism covers every case where an invoice and its payment do not line up: the invoice
books against an open-item account, the payment books against the same account, and the two
lines are matched.

| Case | Open-item account | Flow |
| --- | --- | --- |
| Meta (prepaid credit) | Meta | Bank to Meta (top-up), invoices against Meta, the rest is credit |
| Google Ads (charged first, invoiced later) | Google Ads | Charges, then one invoice; must end at zero |
| Apple, Google Play | Receivable Apple / Google | Report books revenue and fees, the payout settles it |
| Expenses paid by a shareholder | Shareholder | Invoice against the shareholder, the refund settles it |
| Ordinary supplier / customer | Payables / receivables per contact | Invoice opens, payment settles |
| Later: card, PayPal, transfer between own accounts | One account each | Same |

What was open at a cut-off date is exactly what was unmatched on these accounts at that date,
which is the closing export's "Offene Posten" (decisions/0066) computed from the books instead
of from payment statuses. The existing platform and supplier clearing accounts (decisions/0026,
decisions/0068) keep working until phase 4 moves them onto open-item accounts; until then the
ledger books their synthetic transactions like any other movement on that clearing account.

### Proposals, from certain to uncertain

Every generated entry is `proposed` until a human books it:

1. Fixed templates per source event: incoming invoice, outgoing invoice (decisions/0079), bank
   transaction, settlement report line, payout.
2. A booking rule of the document's contact.
3. A no-document rule (today's `payment_no_document_rules`) extended by a target account, for
   example the share capital on 2900.
4. AI only for what none of the above covers: account and tax code with a short reason.
   Booking it offers to save it as a rule, so the same supplier needs no AI the next time.

Documents need more extracted fields for this: net and tax per rate, service date, the
supplier's VAT id and country, a reverse-charge note, and pass-through amounts.

Phase 2 as implemented (`src/modules/documents/README.md`, "Tax fields"): `documents` gained
`tax_breakdown` (jsonb, one `{ ratePercent, netCents, taxCents }` per printed rate),
`net_total_cents`, `tax_total_cents`, `pass_through_cents`, `reverse_charge`, `service_date`,
`service_period_from`/`service_period_to` and `tax_check` (`consistent`/`inconsistent`), all
nullable, existing documents stay `null`. The model returns printed text, code parses it; an
embedded ZUGFeRD XML wins field by field (category `AE` is reverse charge); a mismatch between
the printed figures is flagged, never corrected. The supplier's VAT id and country stay on the
linked contact (ZUGFeRD fills in what the model missed) instead of being copied onto the
document. The ledger reads everything through `DocumentRepository.listForLedger`.

### Editable until filed

- A proposed or booked entry can be edited, re-dated, re-assigned or deleted at any time. Each
  change writes a revision; nothing is overwritten silently.
- Submitting a filing locks every booked entry that feeds it (its booking date inside the
  filed period, or any entry once the annual statement is filed). A locked entry cannot be
  edited or deleted; the database enforces this, like `invoices` (decisions/0079).
- A correction after that is a new entry in an open period, or a corrected filing for the
  same period (a new `filings` row that references the one it corrects). Both are a deliberate
  action, never an edit of a locked entry.
- There is no monthly lock and no storno requirement before a filing.

### Controls

Run on demand and before anything is sent out:

- The bank account (1800) equals the real balance on every day, and every bank transaction is
  booked exactly once.
- Every open-item account is at zero or every open item has a document behind it.
- No booked document without an entry, no entry without a document unless a rule says so.
- A USt-VA preview per month or quarter.
- A comparison with the tax advisor's Summen- und Saldenliste per account, from an uploaded
  file.

### Model as implemented (stage 1)

The sketch above, with these changes:

- **Settings and the feature flag.** `ledger_settings` (one row per workspace, `enabled` default
  false, VAT period month or quarter, basis Soll or Ist, start date, chart `skr04`), owned by the
  ledger rather than a column on `workspaces`. Enabling seeds the chart idempotently and adds an
  account per bank `accounts` row (1800, 1810, ...), per platform clearing account (receivable
  1370 ff.) and per contact clearing account (1461 ff., named after the contact).
- **Tax codes are code constants**, not a `tax_codes` table: `vst19`, `vst7`, `rc13b`, `ust19`,
  `ust7`, `eu_not_taxable`, `not_taxable`, `tax_free`, `pass_through`, each with its tax accounts
  and USt-VA fields. Tax lines are generated from a base line and stored with `tax_role = 'tax'`.
- **Plain uuid references to the sources.** `document_id`, `transaction_id`, the owners of an
  account (bank account, contact), a rule's contact and every user id are plain values without a
  foreign key, like `invoices`: the lock refuses UPDATEs, so an `on delete set null` from a
  deleted document would either block that deletion or change a filed entry. The use case checks
  each id belongs to the caller's workspace. Ledger-internal references are composite foreign
  keys with `workspace_id`.
- **Revisions survive a deletion.** `journal_entry_revisions.entry_id` is set null when the entry
  is deleted; `entry_ref` keeps its id, and `booking_date` the date a handover's "changes since"
  counts by.
- **Matches** are `ledger_open_item_matches` (kind `match`, summing to zero, or `explained`, a
  remainder with a note) and `ledger_open_item_match_lines` (a line in at most one match).
- **Handovers** (`ledger_handovers`): "An Steuerberaterin übergeben" for a period; the changes
  since are the revisions written after it.
- **The tax advisor's balance lists** (`ledger_advisor_balances` and their lines): an uploaded
  DATEV Summen- und Saldenliste, compared per account with the ledger's closing balances.
- **Filings** carry a status (`draft`, `submitted`). The lock and the balance rule are two custom
  migrations (`src/persistence/sql/ledger_filing_lock/`, `src/persistence/sql/ledger_balanced_entries/`).
  The lock's correction path: a draft filing that corrects a submitted one of the same kind opens
  the entries tied to it (`journal_entries.filing_id`) until it is submitted itself. A submitted
  filing is frozen. A submitted USt-VA of a period does not open what an annual statement locks.
  Booking, creating or editing a booked entry in a locked period ties it to the one draft
  correction that opens the date by itself; with several, the user chooses.
- **Years carry their result into equity.** Revenue and expense accounts restart every calendar
  year. A Summen- und Saldenliste starting in a later year opens the earlier years' result on
  2970 "Gewinnvortrag vor Verwendung" (added to the SKR 04 seed), so its openings sum to zero and
  it matches the tax advisor's list, which carries the result there until the shareholders decide
  on it. No closing entry is written; the carry-forward is computed.
- **Concurrent writers.** Every write to an entry locks its row and updates it only at the
  revision it read; one revision number per entry is a unique index. The proposal engine never
  overwrites an entry a human touched in the meantime.

### Proposals as implemented (phase 3)

`src/modules/ledger/README.md` ("Proposal engine") lists every template with its exact accounts
and tax codes. The decisions taken while building it:

- **A pure engine over a snapshot.** `buildProposals` gets the sources, the chart, the active
  rules, the source keys a human decided on and the AI's validated answers, and returns drafts;
  `syncProposals` reads the snapshot through the owners' read methods
  (`TransactionRepository.listForLedger` and `SettlementLineRepository.listForLedger` were added
  for it, `DocumentRepository.listForLedger` gained the summary) and writes through
  `upsertProposal`. Proposals are idempotent by source key; a booked, edited or dismissed entry
  is never touched, and a decided key is not even recomputed (no AI question for it).
- **The line carries the open item.** `journal_lines.document_id` (plain uuid, like every
  reference out of the ledger): the invoice's line on an open-item account and its payment's
  lines name the same document, which is what makes an automatic match safe. Only that is matched
  without a human (same account, same document, sum zero); combinations are suggestions.
- **Order for a bank transaction:** confirmed documents (unless one of them has no open-item
  account, then the next steps decide), a paired clearing account (app-store payout, supplier
  charge), a no-document rule, the contact's own open-item account, a shareholder's account, a
  transfer between own accounts; otherwise no proposal, never a guess. A payment to a shareholder
  is recognized only through a person-owned account in the chart, and only after every explicit
  rule. A rule's pattern is looked for in the counterparty name and the remittance text (the
  share capital arrives as "Stammeinlage <Name>" from each shareholder). Only no-document rules
  book a bank transaction, and only in their direction, read as the side of the books: money in
  is the revenue side (`outgoing`), money out the expense side (`incoming`). A rule learned from
  a supplier's invoices therefore never books its refund.
- **The AI is the last resort for an incoming document's account**, behind a port
  (`LedgerBookingAdvisor`) bound like the payment arbiter (fake, Mistral, not configured). It
  gets the extracted fields and the chart, never the OCR text; its answer is validated in code
  and cached per document under a hash of the question and the advisor's version
  (`ledger_booking_advice`, decisions/0077's pattern). Without a usable answer the template
  default (6300) is proposed with `ai_unavailable`.
- **Rules count their hits** when a proposal they produced is booked (`originReason` is
  `rule:<id>`); "Als Regel speichern" creates or updates the rule of a contact or counterparty.
- **Triggers.** An action, and a `ledger-sync` job scheduled after every matching run and every
  settlement report (deduplicated by `scheduleNow`, decisions/0076), only while the ledger is on.
- **Platform fees**: Google Play fees default to `rc13b`, others to no tax code, until the tax
  advisor confirms the accounts and codes she prefers (see "Consequences").
- **The settlement template is for Apple and Google only.** Both app stores sell in their own
  name on the developer's account (commissionaire model, § 3 (11a) UStG), so the developer's
  revenue is a supply to the store in Ireland, booked on 4339. Stripe, PayPal, Amazon and other
  platforms collect for the seller, whose revenue is the sale to the end customer; their reports
  get no proposal and the sync names the problem `unsupported_platform_settlement` until that
  booking is decided.
- **A cancellation books its invoice negated**, group by group, so every revenue and tax account
  nets to zero whatever the cancellation's own rounding.

### Cascade verification

Every ledger table cascades from `workspaces.id`, so a workspace deletion removes the books in the
same single `DELETE` (decisions/0027-hardening-and-deletion.md, whose own list is not edited
because it is accepted). Both triggers let exactly that cascade through, recognized by the parent
workspace row already being gone. `src/persistence/tests/workspaces-repository.db.test.ts` inserts a
row into each of these, including a booked entry inside a submitted USt-VA period, and asserts
none is left:

- `ledger_settings`
- `ledger_accounts`
- `journal_entries`
- `journal_lines`
- `journal_entry_revisions`
- `ledger_open_item_matches`
- `ledger_open_item_match_lines`
- `ledger_booking_rules`
- `ledger_filings`
- `ledger_handovers`
- `ledger_advisor_balances`
- `ledger_advisor_balance_lines`
- `ledger_booking_advice` (phase 3)

## Phases

1. Ledger core: SKR 04 subset, entries and lines, revisions, Summen- und Saldenliste and
   account sheet, manual booking.
2. Tax fields in extraction and tax codes.
3. Proposals from documents, bank, settlement reports and outgoing invoices, with rules and AI.
4. Open-item accounts and matching; the existing clearing accounts move onto them.
5. Controls and the comparison with the tax advisor's figures.
6. Filings and the lock.
7. Export to the tax advisor (its own decision).

Acceptance test for phases 1 to 5: book June to September 2026 for Itegro and compare with
the tax advisor's Summen- und Saldenliste. The expected differences are known (Google Ads
50,00 EUR, Meta 0,15 EUR, notary input VAT 1,43 EUR, Finom); exactly those must show up.

## Consequences

- The ledger becomes the place where "is everything booked" is answered; the closing export
  can later read its open items from it instead of deriving them from payment statuses.
- Payment matching (decisions/0023, decisions/0025) stays as it is and feeds the ledger; a
  confirmed match becomes the evidence for a payment entry.
- Two representations of the clearing accounts exist until phase 4 is done.
- Open questions for the tax advisor before phase 3: whether VAT is owed on invoicing (Soll)
  or on payment (Ist), and which SKR 04 accounts she prefers for recurring cases (Finom fees,
  court fees, app store revenue). Entries are booked on the document date either way, because
  a GmbH draws up a balance sheet.
- Booking quality depends on the new extraction fields; until phase 2, proposals for an
  invoice without a tax breakdown fall back to the contact's rule and are flagged.
