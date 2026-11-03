# Abschluss: check a period for completeness, then hand it over

Document type: decision
Lifecycle: active
Owner: src/modules/closing
Scope: The completeness check for a month or a year, and the export handed to a tax advisor
Canonical responsibility: Active source for what "this period is complete" means and what the
export contains
Maintenance triggers:
- A new kind of gap belongs in the check (add it to the list below)
- The export's format changes, or a real DATEV Buchungsstapel lands
- The open-item rule or the "Erledigung" values change
- The effective-date expression changes (it is shared with the inbox on purpose)
Last verified: 2026-11-02, "Offene Posten instead of Zuordnungen" below, checked against the
owner's real August 2026. Previously 2026-10-02, re-verified against a sample 2025 after the
folder split and cross references

## Status

Accepted. Builds the "Abschluss" room decisions/0055-navigation-by-use-case.md listed as
planned.

## Context

Digipost reads post, names it, and matches it against the bank account. The question it could
not answer was the one that actually has a deadline: **is this month done, and can I hand it
over?** That answer lived nowhere. It had to be assembled by eye from the inbox and the three
finance pages.

The owner surveyed the open-source accounting landscape for something to adopt. The finding:
nothing worth embedding. Full applications (ERPNext, Odoo, Akaunting, Bigcapital) are whole
systems with their own data model, which means running and syncing a second system, not
importing a library. The Node double-entry ledger libraries that exist are young single-author
projects, and they offer exactly the layer this product already has, hardened against real
data: accounts, idempotent import, clearing accounts, transfer groups, matching. What is
genuinely missing is German-specific (SKR03/SKR04 mapping, reverse charge, DATEV EXTF, UStVA,
GoBD) and no generic library covers any of it. ELSTER in particular has no open path: its
interface is ERiC, a native C library whose licence terms have kept free software from
shipping it.

So the owner decided the product's role explicitly: **feed the tax advisor, do not replace
them.** The advisor already has DATEV, is allowed to post the books, and is liable for them.
What they lack is clean, complete, evidenced data.

## Decision

**A period is a month or a year.** Both are checked and exported the same way, because
"ist der Monat fertig" and "ist das Jahr fertig" are the same question at two scales.

**A document belongs to a period by the same date the inbox sorts it by**, the existing
`coalesce(document_date, <report period end>, <statement last booking>, created_at::date)`
(decisions/0058, 0060, 0061). That expression is extracted into one shared SQL helper rather
than copied, because an Abschluss that disagreed with the inbox about which month a document
belongs to would be worse than no Abschluss at all. A transaction belongs to a period by its
booking date.

**A count must be reproducible on the page it links to.** The first version scoped the five
counts to the period and left the links pointing at the unfiltered lists, so
`/dashboard/abschluss?period=2025` reported 20 unmatched bookings and opened a page showing all
25. A number nobody can recount teaches the user to distrust the page, which is worse than
having no page. Both target lists therefore take an inclusive `?from=`/`?to=` date range (plain
ISO bounds, not a `period` parameter: `ClosingPeriod` lives in this module, which already
depends on documents and payments, so letting them import it back would invert the dependency),
each link carries the period, and each filtered page spells out the range it is showing with a
way to clear it. The inbox filters on the same `documentEffectiveDate` expression it already
sorts by; Zuordnung filters on the booking date the count already uses.

For the same reason "Offene Zuordnungsvorschläge" counts DISTINCT transactions rather than
suggestion rows: the page it opens lists transactions, and one transaction can carry several
suggestions.

**The check is five gaps, each a count with a link to the list that fixes it:** transactions
with no document, documents with no payment, documents waiting for confirmation, documents
whose processing failed, and suggestions awaiting a decision. Each count reuses the query the
page it links to already runs, never a second definition of the same thing. The period's own
totals are shown alongside, so "no gaps" cannot be confused with "no data".

**The export is deliberately not DATEV.** A ZIP with `uebersicht.xlsx` and the documents'
own files. German headers, real dates and real numbers so the advisor can sum them.

Three sheets: **Belege**, **Buchungen**, and **Offene Posten** (see "Offene Posten instead of
Zuordnungen" below; the third sheet was first **Zuordnungen**, one row per confirmed pairing,
because the owner found two sheets were not enough). Each of the first two carries its own `Nr.`
column (`D-001`, `B-001`) and names its counterparts by those numbers rather than counting
them, so the connection between an invoice and the booking that settled it is readable inside
the workbook. A counterpart that has no row here is named rather than dropped: `außerhalb des
Zeitraums (14.12.2025, 20,00 EUR)` when its own date falls outside the period, and `nicht in
dieser Übersicht (...)` when it falls inside but is not listed (today only a clearing
account's own rows, which the Buchungen sheet omits by design).

Two folders, not one: **`ausgangsrechnungen/`** for a document whose direction is outgoing and
**`belege/`** for everything else. A handful of outgoing invoices were invisible among
seventy incoming ones in a single folder. Each spreadsheet row names the path of its own file,
so the advisor can go from a line to the evidence without guessing. The file kept is the
searchable PDF where one exists, otherwise the original upload, with the extension its media
type actually calls for: a bank statement stays XML or MT940.

**Admin only** (`finance.read`), the same gate as the rest of the finance area.

## Offene Posten instead of Zuordnungen (2026-11-02)

Closing August 2026 for real showed that the workbook still did not answer what the owner and
the tax advisor actually asked: 38 documents, 8 bookings and 11 pairings, and no way to see
why those numbers differ or whether everything is covered. The gaps were all about TIME, not
about pairing: an invoice paid three weeks after the month ended, an app store paying out two
months later, Google Play paying three months out together, a platform's 27 small ad invoices
settled through its clearing account with no bank booking of their own. The pairing sheet
showed each link but none of that.

So the period's last day, the **Stichtag**, becomes the reference point, on the Soll basis the
owner confirmed (a document belongs to the month of its own date, the money may move later):

- **Belege** replaces "Zahlungsstatus" with **Erledigung**: the effective status, except
  "Zahlung nach Stichtag" / "Teils nach Stichtag bezahlt" when a payment was booked after the
  Stichtag (the effective "Bezahlt" would hide exactly that), and "Über Verrechnungskonto
  erledigt" for `settled`. "Zugeordnete Buchungen" becomes **Zahlung(en)**: each payment with
  the amount this document claims of it, by "Nr." or by date and timing.
- **Offene Posten** (new) lists what was still owed on the Stichtag, payables then
  receivables: the part paid after it plus the part still open today, with how it was settled
  since. The side comes from an actual payment's sign where there is one (a payout report has
  no direction), else from direction and the sign of the total. Documents finished without a
  payment are never open items. Only the period's own documents are read.
- **Zuordnungen** is dropped: its amounts now sit in "Zahlung(en)", and the owner chose three
  sheets over four.

Everything above is computed in one pure place (`core/open-items.ts`) from the confirmed links
the export already read, so no query, table or count of the check changed. The terms are
generic on purpose; no platform is special-cased.

## Consequences

- The tax advisor gets something they can read without Digipost. That is the point: the export
  is evidence plus an index, not a proprietary interchange format nobody can open.
- A real DATEV Buchungsstapel (EXTF) stays possible later and is now a smaller step, since the
  hard part, deciding what belongs in a period and proving it is complete, is done. The format
  itself is published and has readable reference implementations in several languages.
- The check will say "complete" for a period whose documents were never uploaded at all. It
  measures what is known, not what exists in the world. The totals shown next to it are the
  only honest guard against that, and no software can do better from this side.
- One divergence survives and is written down rather than papered over: "Belege ohne Zahlung"
  counts the effective payment status with no direction filter, while "Offene Posten" lists the
  stored status and requires a direction. A partly paid document not yet due is listed but not
  counted; an open document with no direction is counted but not listed. Both are zero in the
  sample data, and closing it means deciding whether "ohne Zahlung" includes a partly paid
  invoice, which is a product question, not a bug to fix silently.
- Nothing here books anything. There is still no chart of accounts and no double entry, and
  adding them would be a second product, not a feature.
- The Zuordnungen sheet (now "Zahlung(en)") made an existing inconsistency visible rather than causing it: for a
  foreign-currency invoice, `document_transactions.allocated_amount_cents` holds the DOCUMENT's
  amount (12,00 USD) while the booking it settles is in EUR (-11,50), although that column's
  own schema comment calls it a portion of the transaction's amount. The export shows what is
  stored. Which of the two the column should mean is a payments question, open.

## Alternatives considered

- **Adopt an open-source accounting application.** Rejected, see Context: integration of a
  second system rather than reuse of a library, for the half this product already has.
- **Emit a DATEV Buchungsstapel right away.** Rejected for now: it needs an SKR04 account per
  booking, which needs reverse-charge handling and per-contact rules the product cannot yet
  learn. An export the advisor can read costs a fraction and unblocks the same handover.
- **CSV instead of a workbook.** Rejected: German Excel and CSV disagree about separators and
  encoding often enough that the first thing the advisor would see is mangled umlauts.
