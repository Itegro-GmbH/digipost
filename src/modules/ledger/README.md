# src/modules/ledger

Document type: reference
Lifecycle: active
Owner: src/modules/ledger
Scope: The general ledger: settings and the SKR 04 chart, journal entries with tax codes and
revisions, booking, open-item matches, booking rules, filings and the lock they set, handovers to
the tax advisor, her uploaded balance lists, and the reports and controls over the books
Canonical responsibility: How Digipost keeps its own double-entry books, which rules the database
enforces on them, and what each ledger use case and action does
Maintenance triggers:
- A table in `src/persistence/schema/ledger.ts` or a custom SQL source in
  `src/persistence/sql/ledger_*` changes
- A tax code, its USt-VA mapping, or the seed chart changes
- A new write path touches a ledger table, or a control is added
- The proposal engine or the UI stage lands (decisions/0080 phases)
Last verified: 2026-11-12, decisions/0080-ledger-double-entry-bookkeeping.md stage 1 (core,
persistence, use cases, actions; no proposal engine and no pages yet)

## Purpose

An internal bookkeeping and controlling tool (decisions/0080), enabled per workspace and off by
default. Digipost keeps the books itself on SKR 04 accounts: every journal entry has signed lines
(debit positive, credit negative) that must sum to zero once booked, tax lines are generated from
a base line's tax code, any account can carry open items, and everything stays editable, with a
revision per change, until a filing to the tax office locks the period it covers.

Admin-only end to end, like every finance table: pages need `finance.read` (and the ledger
enabled), every action `finance.manage`. There is no member-level access.

This stage has no pages and no navigation entry, and no proposal engine. The engine (a later
stage) writes through `LedgerUseCases.upsertProposal`, keyed by a source key such as
`doc:<documentId>` or `tx:<transactionId>`; it never overwrites a booked, dismissed or
human-edited entry, and `listSourceKeys` tells it what exists.

## Layout

- `core/types.ts`: every closed value set (account kinds and groups, owner types, entry statuses
  and origins, tax codes and roles, amount modes, revision kinds, match kinds, rule directions,
  filing kinds and statuses, VAT period and basis, period statuses, control ids and statuses,
  proposal warnings, USt-VA Kennzahlen, open-item statuses, summary kinds, bookable document
  kinds) and the view shapes the use cases return.
- `core/tax-codes.ts`: `TAX_CODE_DEFINITIONS` (rate, tax account, USt-VA field, label and hint
  keys), `TAX_ACCOUNT_KENNZAHLEN`, and `expandTaxLines`: gross or net base lines to base plus tax
  lines, rounded to the cent in integer arithmetic. Input tax goes to 1406/1401, output tax to
  3806/3801, § 13b adds the pair 1407 (+) and 3837 (-), which cancel each other out.
- `core/chart.ts`: `SKR04_SEED_ACCOUNTS` (about 40 accounts, each with a plain German name and a
  one-sentence description), the number ranges for owned accounts (bank 1800, 1810 ...; platform
  receivables 1370 ff.; contact clearing accounts 1461 ff.; persons 3511 ff.) and their texts.
- `core/reports.ts`: `computeBalances` (Summen- und Saldenliste; revenue and expense accounts
  start every calendar year at zero), `computeAccountSheet` (running balance, counter accounts),
  `computeOpenItems` (matches, explained remainders, what is open), `computeVatPreview` (bases
  from tax codes, tax amounts from the tax accounts, Zahllast in Kennzahl 83).
- `core/controls.ts`: USt-VA periods, `compareBankBalances` (ledger bank account against the real
  bank balance per day, first divergence date), `computeControls`, `derivePeriodStatus`.
- `core/advisor.ts`: `parseDatevBalanceList` (lenient DATEV Summen- und Saldenliste CSV: `;`,
  German numbers, "S"/"H" in its own column or in the amount, "Saldo Soll"/"Saldo Haben",
  preamble lines skipped) and `compareWithAdvisor`.
- `core/summary.ts`: `summarizeEntry`, the deterministic one-sentence summary as an i18n key
  (`Ledger.summaries.*`) plus ICU values, never free text.
- `core/schemas.ts`: the Zod schema of every action input and of the proposal engine's input.
- `core/error-codes.ts`: `LEDGER_USE_CASE_ERROR_CODES`, `LEDGER_ACTION_ERROR_CODES`,
  `LEDGER_DB_RAISES` (the messages the custom SQL raises).
- `server/read-models.ts`: `cache()` projections over `getRequestServices().ledger`.
- `actions.ts`: one Server Action per write, each parsed with its schema, then
  `requirePermission(PERMISSIONS.financeManage)`, then the use case with the caller's own
  workspace id.

## Public interfaces

- `index.ts` (neutral): the pure domain above, used by `src/persistence/use-cases/ledger-use-cases.ts`
  and `src/persistence/schema/ledger.ts`.
- `server.ts`: `getLedgerSettingsProjection`, `isLedgerEnabledProjection`,
  `listLedgerAccountsProjection`, `listJournalEntriesProjection`, `getJournalEntryProjection`,
  `getLedgerBalancesProjection`, `getLedgerAccountSheetProjection`,
  `getLedgerOpenItemsProjection`, `listLedgerOpenItemAccountsProjection`,
  `getLedgerVatPreviewProjection`, `getLedgerControlsProjection`,
  `getLedgerPeriodOverviewProjection`, `listLedgerRulesProjection`, `listLedgerFilingsProjection`,
  `listLedgerHandoversProjection`, `listLedgerAdvisorUploadsProjection`,
  `getLedgerAdvisorComparisonProjection`. A page checks `finance.read` and
  `isLedgerEnabledProjection` first; every other projection throws `disabled` while the ledger is
  off.
- `actions.ts`: `saveLedgerSettingsAction`, `syncLedgerChartAction`,
  `createLedgerAccountAction`, `updateLedgerAccountAction`, `archiveLedgerAccountAction`,
  `restoreLedgerAccountAction`, `createJournalEntryAction`, `updateJournalEntryAction`,
  `deleteJournalEntryAction`, `bookJournalEntryAction`, `unbookJournalEntryAction`,
  `bulkBookJournalEntriesAction`, `dismissProposalAction`, `restoreProposalAction`,
  `createOpenItemMatchAction`, `deleteOpenItemMatchAction`, `createBookingRuleAction`,
  `updateBookingRuleAction`, `deleteBookingRuleAction`, `createFilingAction`,
  `submitFilingAction`, `createCorrectionFilingAction`, `createHandoverAction`,
  `uploadAdvisorBalancesAction`, `deleteAdvisorUploadAction`.
- There is no `client.ts` yet: the UI stage adds it with the first page components.

## Rules

- **Balanced when booked.** A booked entry needs at least two lines summing to zero. The use case
  checks it first; a deferred constraint trigger checks it again at COMMIT
  (`src/persistence/sql/ledger_balanced_entries/`), raising `ledger_unbalanced`. A proposal may be
  unbalanced while it is edited.
- **Locked when filed.** A submitted USt-VA locks the booked entries dated in its period, a
  submitted annual statement every day of its year: no update or delete of the entry or its
  lines, no booked insert into the period, no booking or moving into it
  (`src/persistence/sql/ledger_filing_lock/`, raising `ledger_locked`). Two exceptions, both
  recognized by the data: the workspace-deletion cascade, and entries whose `filing_id` names a
  draft correcting filing of the same kind covering the date. A submitted filing itself is frozen.
  A correction is either a new entry in an open period or "Berichtigte Meldung anlegen" and tying
  the entries to it; both are deliberate.
- **Every change has a revision**, written in the same transaction with the previous state
  (entry and lines). Editing, unbooking or deleting a booked entry needs a reason. A deleted
  entry's revisions stay (`entry_ref`), so a handover's "changes since" still counts it.
- **References out of the ledger are plain uuids** (documents, transactions, bank accounts,
  contacts, users), without a foreign key, for the same reason as `invoices`: a `set null` from a
  deleted document would be an UPDATE the lock refuses. The use case checks each one belongs to
  the caller's workspace before writing it. Ledger-internal references are composite foreign keys
  with `workspace_id`, so a line can never land on another workspace's account.
- **Open-item matches** are dissolved as a whole when one of their lines is replaced (an edit
  rewrites an entry's lines). A `match` must sum to zero; an `explained` remainder needs a note.
- **Reading other owners' tables** happens only in `LedgerRepository`'s source reads (read-only
  joins on `accounts`, `transactions`, `import_batches`, `documents`, `contacts`) and through
  `repos.contact.findById`. The ledger never writes them, and never books the synthetic
  transactions on clearing `accounts` rows (decisions/0026, decisions/0068): those only decide
  which open-item account a source belongs to.
- **Enabling** (`setSettings` with `enabled: true`, or `syncChart`) seeds the SKR 04 subset and
  adds an owned account for each bank and clearing `accounts` row that has none: the first bank
  account takes over the seeded 1800. It is idempotent and never renumbers an existing account.

## Controls

`getControls(period)` and the period overview run: the ledger's bank account equals the real
bank balance on every day (the real side is the earliest statement's opening balance plus every
imported transaction; the ledger side is everything booked on the owned account), every bank
transaction is booked, every bookable document (`LEDGER_BOOKABLE_DOCUMENT_KINDS`) is booked or
its proposal dismissed, every open-item account is at zero or explained, no proposal is
unbalanced, no proposal waits, and the tax advisor's uploaded list for the period agrees. The
unbooked checks start at the ledger's start date.

## Known gaps

- The USt-VA preview books on the booking date; Ist-Versteuerung (`vat_basis = ist`) is stored
  but not applied yet.
- Bases are reported in cents; the form rounds them to whole euros.
- `ledger_booking_rules.hits` is never incremented yet: the proposal engine will.

## Data

Tables `ledger_settings`, `ledger_accounts`, `journal_entries`, `journal_lines`,
`journal_entry_revisions`, `ledger_open_item_matches`, `ledger_open_item_match_lines`,
`ledger_booking_rules`, `ledger_filings`, `ledger_handovers`, `ledger_advisor_balances`,
`ledger_advisor_balance_lines` (`src/persistence/schema/ledger.ts`, migration
`0028_illegal_mad_thinker.sql`, custom migrations `0029_ledger_balanced_entries.sql` and
`0030_ledger_filing_lock.sql`), written only by
`src/persistence/repositories/drizzle/ledger-repository.ts`. Every table cascades from
`workspaces.id` (decisions/0080's "Cascade verification").

## Tests

`tests/` (unit: tax expansion with rounding and § 13b, the seed chart, balances, account sheet,
open items, VAT preview, controls with the bank divergence date, period status, the DATEV
parser, summaries rendered through `de.json`, schemas, i18n coverage, the actions' permission
gate), `src/persistence/tests/ledger-use-cases.test.ts` (checks before writing and the mapping of
the database's refusals, with a fake), `src/persistence/tests/ledger-repository.db.test.ts` (both
triggers, the correction exception, the cascade exception, workspace isolation, matches) and
`src/persistence/tests/ledger-use-cases.db.test.ts` (the Itegro cases end to end against real
Postgres). The fixtures are the real cases of decisions/0080: IONOS, the Meta prepaid credit,
Google Ads charged 10 + 50 + 36,57 against one invoice of 96,57, the notary paid by a shareholder
with 9,00 pass-through costs, the share capital, the court letter with 300 + 5.
