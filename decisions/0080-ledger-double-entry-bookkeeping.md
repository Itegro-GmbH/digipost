# An own ledger: double-entry bookkeeping with open-item accounts, editable until filed

Document type: decision
Lifecycle: active
Owner: src/modules/ledger (planned)
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
Last verified: 2026-11-12, initial proposal, against `src/persistence/schema/accounts.ts`,
`src/persistence/schema/payments.ts`, `src/persistence/schema/documents.ts`,
decisions/0026-platform-settlements.md, decisions/0066-abschluss-check-and-export.md,
decisions/0068-supplier-clearing-accounts.md, decisions/0079-outgoing-invoices.md, and the
reconciliation of the tax advisor's evaluations for June to September 2026

## Status

Proposed. Nothing is implemented yet. Builds on decisions/0024-accounts-and-transactions.md,
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
