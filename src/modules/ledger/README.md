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
Last verified: 2026-11-12, fixes from the acceptance replay and the review: bank-transaction rules
(remittance text, no-document rules only, money direction), the payment fallback for a document
without an open-item account, cancellations, the commissionaire-only settlement template,
reverse charge against printed German VAT, rule tax codes by direction, open items at a date, the
2970 carry-forward, bounded match suggestions, matches on unbooking, deleting and editing, the
correcting filing taken automatically, row locks and conditional updates (migration
`0033_flippant_mercury.sql`), advisor upload limits, and the editor's and periods page's retries,
against `core/`, `ui/`, `src/persistence/use-cases/ledger-use-cases.ts`,
`src/persistence/repositories/drizzle/ledger-repository.ts` and the tests named under "Tests".
Previously 2026-11-12, decisions/0080-ledger-double-entry-bookkeeping.md UI stage, part 2: the
pages `/konten` (living Summen- und Saldenliste), `/konten/[nummer]` (Kontenblatt, "Offene
Posten"), `/auswertungen/ust`, `/auswertungen/abgleich`, `/auswertungen/zeitraeume`,
`/einstellungen` (Allgemein, Kontenplan, Regeln), the document page's "Buchhaltung" card, the
finance page's discovery link, `core/balance-view.ts`, `core/document-status.ts`, and the use
cases `getAccountSheet` (with proposals), `getAccountSheets`, `getBankComparisons` and the
`documentId` filter of `listEntries`. Previously 2026-11-12, UI stage, part 1: the
pages `/dashboard/buchhaltung` (overview, "Buchhaltung aktivieren"), `/zu-pruefen` (the review
queue), `/buchung/[id]` and `/buchung/neu` (the booking editor) and `/journal`, the components in
`ui/` and `client.ts`, `core/search-params.ts`, `core/periods.ts`, and the use cases
`countWaitingProposals` and `getSources`. Previously 2026-11-12, phase 3 (the proposal
engine, the AI booking advisor and its answer cache, automatic open-item matching, rule learning,
the `ledger-sync` job), against `core/proposals.ts`, `core/booking-advisor.ts`,
`core/open-item-matching.ts`, `core/rule-learning.ts` and `src/persistence/use-cases/ledger-use-cases.ts`.
Previously 2026-11-12, stage 1 (core, persistence, use cases, actions; no pages yet)

## Purpose

An internal bookkeeping and controlling tool (decisions/0080), enabled per workspace and off by
default. Digipost keeps the books itself on SKR 04 accounts: every journal entry has signed lines
(debit positive, credit negative) that must sum to zero once booked, tax lines are generated from
a base line's tax code, any account can carry open items, and everything stays editable, with a
revision per change, until a filing to the tax office locks the period it covers.

Admin-only end to end, like every finance table: pages need `finance.read` (and the ledger
enabled), every action `finance.manage`. There is no member-level access.

The UI's first part ("UI" below) has the overview, the review queue, the booking editor and the
journal, in the sidebar's "Buchhaltung" section for an admin of a workspace that enabled the
ledger. The proposal engine (phase 3, "Proposal engine" below) writes through `LedgerUseCases.upsertProposal`, keyed by a source key (`doc:<documentId>`,
`tx:<transactionId>`, `invoice:<invoiceId>`, `settlement:<documentId>:<YYYY-MM>`); it never
overwrites a booked, dismissed or human-edited entry.

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
  start every calendar year at zero, and the earlier years' result opens on 2970 "Gewinnvortrag
  vor Verwendung", a synthetic row when the chart lacks it, so the openings sum to zero),
  `computeAccountSheet` (running balance, counter accounts; 2970 opens with the same carried
  result), `computeOpenItems` (matches, explained remainders, what is open; a match settles its
  lines at a date only when all of them are booked on or before it), `computeVatPreview` (bases
  from tax codes, tax amounts from the tax accounts, Zahllast in Kennzahl 83).
- `core/controls.ts`: USt-VA periods, `compareBankBalances` (ledger bank account against the real
  bank balance per day, first divergence date), `computeControls`, `derivePeriodStatus`.
- `core/advisor.ts`: `parseDatevBalanceList` (lenient DATEV Summen- und Saldenliste CSV: `;`,
  German numbers, "S"/"H" in its own column or in the amount, "Saldo Soll"/"Saldo Haben",
  preamble lines skipped; at most `MAX_ADVISOR_ROWS` (5000) rows and amounts inside a Postgres
  `integer`) and `compareWithAdvisor`. A file over `MAX_ADVISOR_FILE_BYTES` (900 KB) is refused
  by the form and the use case. Every refusal is `advisor_file_invalid`.
- `core/summary.ts`: `summarizeEntry`, the deterministic one-sentence summary as an i18n key
  (`Ledger.summaries.*`) plus ICU values, never free text. Lines of the same account count once;
  a bank line against an open-item or equity account reads as a payment (`paymentOut`,
  `paymentIn`), a platform's report as `platformReport`.
- `core/proposals.ts`: the proposal engine's pure core: `adviceQuestionsFor` (which documents need
  the AI), `buildProposals` (snapshot plus validated advice in, drafts with lines, tax codes,
  origin, reason, warnings and source key out), `invoiceVatGroups` (an issued invoice's net and
  VAT per category, reconciled to its stored totals), the rule pickers.
- `core/ports.ts`: `LedgerBookingAdvisor`, the AI port, with its question and answer shapes.
- `core/booking-advisor.ts`: `validateBookingAdvice` (account from the question's chart, tax code
  fitting the direction, a split that adds up), `bookingAdviceCacheKey`, `toCacheableBookingAdvice`,
  and `createFakeLedgerBookingAdvisor` (keyword based, deterministic).
- `core/open-item-matching.ts`: `findAutoMatches` (same document, sum zero) and
  `suggestMatchGroups` (same document first, then one opposite line of exactly the amount, then
  up to four opposite lines adding up to one). Bounded whatever the account holds: at most
  `MAX_ANCHORS` (200) lines searched for, `MAX_SEARCH_STEPS` (50 000) lines tried in all, and a
  stop at `MAX_SUGGESTIONS` (50).
- `core/rule-learning.ts`: `deriveRuleFromEntry`, the rule "Als Regel speichern" creates.
- `core/schemas.ts`: the Zod schema of every action input and of the proposal engine's input.
  `RULE_TAX_CODES_BY_DIRECTION`: a rule's tax code fits its direction (`incoming`, the expense
  side: `vst19`, `vst7`, `rc13b`, `pass_through`, `not_taxable`, `tax_free`; `outgoing`, the
  revenue side: `ust19`, `ust7`, `eu_not_taxable`, `not_taxable`, `tax_free`; `any`: only
  `not_taxable`, `tax_free` or none), enforced by the schema and the rules form.
- `core/error-codes.ts`: `LEDGER_USE_CASE_ERROR_CODES`, `LEDGER_ACTION_ERROR_CODES`,
  `LEDGER_DB_RAISES` (the messages the custom SQL raises).
- `server/read-models.ts`: `cache()` projections over `getRequestServices().ledger`.
- `actions.ts`: one Server Action per write, each parsed with its schema, then
  `requirePermission(PERMISSIONS.financeManage)`, then the use case with the caller's own
  workspace id.
- `core/search-params.ts`: the URL filters of "Zu prüfen" (`?von=&bis=&herkunft=&nur=warnungen`)
  and the journal (`?von=&bis=&status=&herkunft=&konto=&seit=&anzahl=`), an empty or malformed
  value counting as absent (decisions/0062), and the journal's use-case filter and search string.
- `core/periods.ts`: `describePeriod` (month, quarter, year or range, for the labels),
  `lockingFilingFor` (the submitted filing covering a date), `firstOpenDate` (where "Korrektur
  buchen" dates its entry) and `startedVatPeriods` (the period selects).
- `core/balance-view.ts`: `buildBalanceGroups` (the accounts page's groups with subtotals, the
  "Einfach" amounts in the account's own direction, accounts without movement on request),
  `isCreditNormal`, the chip shape `AccountStatusChip`, and `openItemAccountType` (which
  explanation an open-item account gets: prepaid or charged first, receivable, shareholder,
  payable).
- `core/document-status.ts`: `ledgerDocumentStatusOf`, the document card's state (gesperrt,
  gebucht, Vorschlag, keine Buchung) and its entries, strongest first.
- `ui/`: the page components (see "UI").

## Public interfaces

- `index.ts` (neutral): the pure domain above, used by `src/persistence/use-cases/ledger-use-cases.ts`
  and `src/persistence/schema/ledger.ts`.
- `server.ts`: `getLedgerSettingsProjection`, `isLedgerEnabledProjection`,
  `countLedgerWaitingProposalsProjection` (the nav badge), `getLedgerSourcesProjection` (documents
  and bank transactions behind entries),
  `listLedgerAccountsProjection`, `listJournalEntriesProjection`, `getJournalEntryProjection`,
  `getLedgerBalancesProjection`, `getLedgerAccountSheetProjection`,
  `getLedgerOpenItemsProjection`, `listLedgerOpenItemAccountsProjection`,
  `getLedgerVatPreviewProjection`, `getLedgerControlsProjection`,
  `getLedgerPeriodOverviewProjection`, `listLedgerRulesProjection`, `listLedgerFilingsProjection`,
  `listLedgerHandoversProjection`, `listLedgerAdvisorUploadsProjection`,
  `getLedgerAdvisorComparisonProjection`, `getLedgerMatchSuggestionsProjection`,
  `getLedgerAccountSheetsProjection` (booked-only sheets of several accounts in one read),
  `getLedgerBankComparisonsProjection` (per bank account: matches the statement, or since when not),
  `getLedgerDocumentStatusProjection` (the document page's card: `null` while the ledger is off,
  so another owner's page can call it without checking the flag; the caller checks
  `finance.read`). A page checks `finance.read` and
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
  `uploadAdvisorBalancesAction`, `deleteAdvisorUploadAction`, `syncLedgerProposalsAction`
  ("Vorschläge aktualisieren", optionally for a period), `learnLedgerRuleFromEntryAction`
  ("Als Regel speichern").
- Use cases without an action: `scheduleSync` (the `ledger-sync` job), `autoMatchOpenItems`
  (after every sync and every booking).
- `client.ts`: `AccountTag`, `EntryEditor` (with `EditorEntry`, `EditorSeed`), `EntryLinesTable`,
  `JournalFilters`, `JournalTable`, `LedgerEnableCard`, `PeriodName`, `OriginPill`,
  `PeriodStatusPill`, `StatusPill`, `ReviewQueueClient` (with `QueueProblem`), `RevisionHistory`,
  `SourcePanel`, `SyncProposalsButton`; part 2: `BalanceListView`, `AccountStatusBadge`,
  `AccountSheetTable`, `OpenItemsClient`, `VatPreviewView`, `AdvisorUploadForm`,
  `AdvisorUploadsList`, `AdvisorComparisonTable`, `PeriodsClient`, `FilingConfirmCard`,
  `SettingsGeneralForm`, `ChartSettings`, `RulesSettings`, `RuleForm`, `DocumentLedgerCard`,
  `LedgerTabs`, `ReportsTabs`, `SettingsTabs`, `PeriodSelect`.
- The use cases `countWaitingProposals` (proposals not dismissed, any date) and `getSources`
  (the requested documents and bank transactions through `DocumentRepository.listForLedger` and
  `TransactionRepository.listForLedger`, extracted fields only; an id that is not found is left
  out, which the UI shows as "Beleg gelöscht").

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
  the entries to it; both are deliberate. Tying is automatic: booking, creating or editing a
  booked entry dated in a locked period without a `filing_id` takes the one draft correction that
  opens the date; with several the use case answers `filing_choice_required` and the editor offers
  "Berichtigte Meldung"; with none the date stays `locked` (the editor links to the periods).
- **Every change has a revision**, written in the same transaction with the previous state
  (entry and lines). Editing, unbooking or deleting a booked entry needs a reason. A deleted
  entry's revisions stay (`entry_ref`), so a handover's "changes since" still counts it.
- **One writer at a time.** Every write to an entry reads it `FOR UPDATE` and updates it only
  while it is still at the revision read (else `stale_revision`); a revision number exists once
  per entry (unique index `journal_entry_revisions_entry_revision_key`). The proposal engine
  locks the entry of its source key too and updates only an untouched proposal (proposed, never
  edited or dismissed), so an edit committed meanwhile is kept, never overwritten.
- **References out of the ledger are plain uuids** (documents, transactions, bank accounts,
  contacts, users), without a foreign key, for the same reason as `invoices`: a `set null` from a
  deleted document would be an UPDATE the lock refuses. The use case checks each one belongs to
  the caller's workspace before writing it. Ledger-internal references are composite foreign keys
  with `workspace_id`, so a line can never land on another workspace's account.
- **Open-item matches** are dissolved as a whole when one of their lines changes, and when the
  entry is unbooked or deleted. An edit leaves identical lines alone and keeps a line (its id and
  match) whose position, account, amount and document stay the same; only matches of removed
  lines are dissolved. A `match` must sum to zero; an `explained` remainder needs a note.
- **Reading other owners' tables** happens only in `LedgerRepository`'s source reads (read-only
  joins on `accounts`, `transactions`, `import_batches`, `documents`, `contacts`) and through
  `repos.contact.findById`. The ledger never writes them, and never books the synthetic
  transactions on clearing `accounts` rows (decisions/0026, decisions/0068): those only decide
  which open-item account a source belongs to.
- **Enabling** (`setSettings` with `enabled: true`, or `syncChart`) seeds the SKR 04 subset and
  adds an owned account for each bank and clearing `accounts` row that has none: the first bank
  account takes over the seeded 1800. It is idempotent and never renumbers an existing account.

## UI

Every page checks `finance.read` (else `notFound()`) and that the ledger is enabled (else
`notFound()`, except the overview, which then shows the "Buchhaltung aktivieren" card to an admin);
writing controls render only with `finance.manage`, and every action checks it again. The pages sit
under the shell's wide layout (`src/modules/dashboard-shell`'s `WIDE_LAYOUT_PREFIXES`). Copy is
`Ledger.*` in `de.json`.

- `/dashboard/buchhaltung` (overview): proposals waiting with "Jetzt prüfen" and "Vorschläge
  aktualisieren" (`SyncProposalsButton`, the result inline), three tiles (the current period's
  "Bank stimmt?" control, open-item accounts not at zero and how many are explained, the current
  USt-VA period's Zahllast), the year's USt-VA periods (`getPeriodOverview`, `?jahr=`) newest
  first with a status pill (label and icon, never colour alone), the changes since a handover and
  one line naming each failing check with a link to where it is fixed, and a link to
  `/dashboard/abschluss`. Off: `LedgerEnableCard` (start date, default the first day of the current
  year; USt-VA monthly or quarterly; Soll or Ist, each with a plain hint) saving through
  `saveLedgerSettingsAction`.
- `/dashboard/buchhaltung/zu-pruefen` (`ReviewQueueClient`): proposals grouped "Sicher (Vorlage oder
  Regel)" (template or rule, balanced, no warning: `ui/queue-model.ts`'s `isSafeProposal`) and
  "Bitte ansehen" (the AI, a manual proposal, a warning, a difference), then "Probleme": the
  control subjects `unbooked_bank_transactions` and `unbooked_documents` of the filtered period that
  no open proposal covers, each with "Buchung anlegen" (`/buchung/neu?umsatz=` or `?beleg=`). A
  row has the date, text, amount, origin pill (the AI in the warm colour with "Warum?" and its
  sentence), the deterministic sentence (`t(summary.key, summary.params)`), warning chips with
  their sentence, the Buchungssatz in a disclosure, and Buchen, Bearbeiten, Verwerfen (inline
  confirm). "Alle sicheren auswählen" never selects the AI or a warned proposal; "N buchen (Summe)"
  books through `bulkBookJournalEntriesAction` and shows each failure on its row. Booking removes a
  row at once and puts it back with its error if the action fails. Keys: j/k move, Enter books the
  focused row, e edits, x selects, ? shows the help; none acts while typing in a field.
- `/dashboard/buchhaltung/buchung/[id]` and `/buchung/neu` (`SourcePanel`, `EntryEditor`,
  `RevisionHistory`): the source on the left (document fields with the printed tax breakdown,
  links to the document page and its PDF; the bank transaction; "Beleg gelöscht" when it is gone),
  the editor on the right. Modes Ausgabe, Einnahme, Umbuchung, Aufteilen, Experte
  (`ui/editor-model.ts`, pure): every mode is a list of base lines that `expandTaxLines` turns into
  the live "So wird gebucht" table, the same function the use case books with; switching modes goes
  through those lines and a simple mode accepts only lines that fit it ("passt in keine Vorlage").
  The account field is `AccountCombobox` (ARIA combobox over the chart: name, number, group). An
  amount with a tax code is gross in the simple modes (Brutto/Netto toggle) and net in the expert
  grid; a printed tax amount from the document is kept while amount and code are unchanged.
  Booking needs balanced lines and, in Aufteilen, nothing left to distribute; saving a proposal
  may stay unbalanced. A booked entry needs a reason to be changed, unbooked or deleted. "Für
  <Kontakt> künftig so vorschlagen" calls `learnLedgerRuleFromEntryAction` after booking (ticked
  for an AI proposal). A locked entry is read-only with "Korrektur buchen" (`/buchung/neu?korrektur=`:
  the lines reversed, dated `firstOpenDate`, `correctionOfEntryId` set) and a link to the periods.
  `stale_revision` offers "Neu laden". "Buchen" on a changed proposal saves and then books; when
  the booking fails after the save, the editor keeps the saved revision, so trying again only
  books. A printed tax as large as the gross is not used, and the editor says so.
  `/buchung/neu?beleg=` prefills from the document (direction,
  amount, tax code from a single printed rate or reverse charge, the contact's open-item account or
  3300/1200), `?umsatz=` from the bank transaction (its bank account, the direction by sign).
- `/dashboard/buchhaltung/journal` (`JournalFilters`, `JournalTable`): every entry, proposals dashed,
  locked entries with a lock (`lockingFilingFor`), the main Soll and Haben account, filters in the
  URL including "Geändert seit Übergabe" once a handover exists, 200 rows at a time with "Mehr laden".

- `/dashboard/buchhaltung/konten` (`BalanceListView`): the living Summen- und Saldenliste of the
  period (`?von=&bis=`, default the current year), one collapsible group per account group in
  chart order ("Bank und Geld" first) with its subtotal. `?ansicht=einfach` (default) shows Rein,
  Raus and Stand in the account's own direction (share capital and revenue read positive; a mixed
  group such as "Steuern" has no added-up Stand); `?ansicht=soll-haben` shows EB, Soll, Haben and
  Saldo with S or H, as DATEV does. `?alle=1` adds the accounts without movement. Chips: a bank
  account "Stimmt mit Kontoauszug" or "Abweichung seit <Datum>" (`getBankComparisons` up to the
  period's end), an open-item account "Ausgeglichen", "Erklärt" or "n offene Posten". Every
  amount links to the Kontenblatt of the same period; a "?" disclosure shows the account's
  description; the footer checks "Summe Soll = Summe Haben".
- `/dashboard/buchhaltung/konten/[nummer]` (`AccountSheetTable`): header with both names,
  description and balance, the opening balance, each line with date, text (link to the entry),
  counter accounts (each a link to its sheet), document link, Soll, Haben and running Saldo.
  Proposals are dashed with a "Vorschlag" pill and stay out of the balance unless "Vorschläge
  einrechnen" (`?vorschlaege=1`). An open-item account has the tab `?tab=offen`
  (`OpenItemsClient`): what this kind of account is for, the automatic suggestions as cards
  ("Diese n Posten gleichen sich aus", "Übernehmen"), the open lines with checkboxes, a sticky
  bar with the selection's live sum, "Ausgleichen" enabled only at exactly 0,00, "Rest erklären"
  with a required note (a prepaid credit, a payout still to come), and the existing matches in a
  disclosure, each with "Ausgleich aufheben".
- `/dashboard/buchhaltung/auswertungen` redirects to `/ust`. Tabs (`ReportsTabs`): "Summen und
  Salden" is the accounts page in its Soll/Haben view (one list, not two that could disagree),
  "USt-VA", "Abgleich Steuerberaterin", "Zeiträume und Meldungen".
- `/auswertungen/ust` (`VatPreviewView`): one started USt-VA period (`?zeitraum=2026-07` or
  `2026-Q3`, default the newest), each Kennzahl with number, plain label, base and tax, opening to
  the booked entries behind it (`vatKennzahlenOfEntry`, the same rules the preview sums by), then
  Zahllast or Erstattung. It states the taxation basis; with Ist configured it says plainly that
  the preview still books on the booking date. Proposals in the period are named as not included.
- `/auswertungen/abgleich` (`AdvisorUploadForm`, `AdvisorUploadsList`, `AdvisorComparisonTable`):
  upload the tax advisor's DATEV CSV for a period (read as UTF-8, else Windows-1252), the uploads
  (`?upload=`, default the newest; delete after a confirm), and per account Digipost, her figure
  and the difference, `?nur=abweichungen` for differences only. A differing account opens to
  Digipost's own lines of the period (`getAccountSheets`, up to 60 accounts) and its Kontenblatt.
  Only account totals are compared, and the page says so.
- `/auswertungen/zeitraeume` (`PeriodsClient`): the year's started USt-VA periods (`?jahr=`) with
  status, booked and proposed counts, the newest handover and "n Änderungen seit der Übergabe"
  (link to the journal filtered by that handover), "An Steuerberaterin übergeben" (a note, never a
  lock). "Als eingereicht markieren" opens `FilingConfirmCard`: Eingereicht am, the Zahllast or
  Erstattung on the protocol (optional; a warning when it differs from the preview, never a
  block), how many booked entries get locked, proposals that will not be bookable any more, and
  the checkbox "Ich habe die Meldung beim Finanzamt abgegeben"; it creates the draft filing
  (unless one waits, or this card created one before a failed submission) and submits it. A
  submitted period shows the lock and "Berichtigte Meldung
  anlegen", which explains both paths (a correcting filing whose entries may be dated in the
  period, or "Korrektur buchen" in the next open period) and leaves the choice to the tax
  advisor. A correcting draft is submitted the same way. The year's annual statement is the last
  row (no Zahllast; it locks the whole year).
- `/dashboard/buchhaltung/einstellungen` (`SettingsTabs`): Allgemein (`SettingsGeneralForm`: start
  date, USt-VA period, basis, "Kontenplan aktualisieren", "Buchhaltung ausschalten" behind an
  inline confirm; nothing is deleted), `/kontenplan` (`ChartSettings`: grouped chart with kind,
  open items, owner and archived state; a new account with open items and an owner, bank account,
  contact, platform or person, whose type presets kind and group; edit name, description, group
  and open items; archive and restore; the owner options come from `listAccountsOverviewProjection`
  and `listContactSummariesProjection`), `/regeln` (`RulesSettings`, `RuleForm`: contact or
  pattern, direction, account, tax code, payment account, "ohne Beleg", hits, active; create,
  edit, deactivate, delete after an inline confirm).
- Outside the ledger's routes: the document page (`/dashboard/documents/[id]`) shows
  `DocumentLedgerCard` for `finance.read` while the ledger is on: Vorschlag, gebucht, gesperrt or
  keine Buchung, the entry's deterministic sentence and a link, or "Buchung anlegen"
  (`/buchung/neu?beleg=`, `finance.manage` only). `/dashboard/abschluss` links "Zur
  Buchhaltung" while the ledger is on. While it is off, `/dashboard/finance` shows one dashed link
  "Buchhaltung (intern)" to `finance.manage`: the least intrusive place an admin already visits
  for money matters, so the off-by-default ledger can be found without a nav entry.

## Proposal engine

`syncProposals(workspaceId, { from?, to? })` first adds owned accounts for new bank and clearing
`accounts` rows (`syncChart`), then reads every source through its owner's read method
(`DocumentRepository.listForLedger`, `TransactionRepository.listForLedger` (bank accounts only,
with the clearing account a row is paired with), `SettlementLineRepository.listForLedger`,
`InvoiceRepository.listInvoices`, contacts, learned payment names and no-document rules of the
payments owner), asks the AI only about incoming documents no rule covers, lets
`buildProposals` draft the entries and writes them through `upsertProposal`. Sources before the
start date or outside `from`/`to`, and sources whose entry a human booked, edited or dismissed,
are skipped. A second run with nothing new writes nothing. Everything is booked Soll style: the
invoice and its payment are two entries that meet on an open-item account, and each open-item
line carries the document it books or pays (`journal_lines.document_id`).

Templates, from certain to uncertain:

- **Incoming invoice** (`incoming_invoice`, `receipt`, an `authority_letter` with an amount;
  `doc:<id>`, booked on the document date): the expense account from a rule of the contact (or a
  name pattern), else the AI, else 6300 with `ai_unavailable`. Tax: one base line per printed
  rate with the exact printed net and tax (`vst19` on 1406, `vst7` on 1401); `rc13b` (net = gross,
  1407/3837 pair) when the document says reverse charge or the supplier is foreign (contact
  country not DE, or a non-DE VAT id) and shows no German VAT; the pass-through amount on its own
  `pass_through` line; with nothing printed the rule's or the AI's code, `not_taxable` for courts
  and authorities, else `vst19` from the gross with `no_tax_breakdown`. A German supplier (contact
  country DE or a DE VAT id) printing German VAT is booked from the printed breakdown even when
  the document says reverse charge, with `reverse_charge_conflict`. Against: the rule's
  payment account, else the contact's own open-item account (Meta 1461, Google Ads 1462), else the
  shareholder's account (3511 ff.) when every confirmed payment went to that person, else 3300.
- **Outgoing invoice issued in Digipost** (`invoice:<id>`, issue date): 1200 (or the contact's
  open-item account) against 4400 `ust19`, 4300 `ust7`, 4339 `eu_not_taxable` (category AE to an
  EU buyer), 4338 `not_taxable` (AE outside the EU, Z, G, O), 4200 `tax_free` (E), per VAT group
  with the invoice's own totals; a cancellation books the cancelled invoice's groups negated, so
  every revenue and tax account nets to zero (`invoiceVatGroups` also rounds half away from
  zero). Its inbox document is not booked again.
- **Outgoing invoice document** not issued in Digipost (`doc:<id>`): the same accounts from its
  printed tax fields, a rule, or `ust19` from the gross with `no_tax_breakdown`.
- **Platform report** (`settlement:<documentId>:<YYYY-MM>`, booked on the month end or the
  report's period end), Apple and Google only (the commissionaire model: the store sells in its
  own name, so the revenue is a supply to it): revenue and refunds on 4339 `eu_not_taxable`
  (charges minus charge refunds, withheld taxes included), fees on 6855 (Google: `rc13b`) or a
  rule whose pattern names the platform (fees minus refunded fees: a fee line without a gross
  whose net is the fee carries its own sign, so Google's "Google fee refund" reduces the fees;
  a fee next to its sale is always a cost; the same rule as `src/modules/accounts`'
  `settlementFeeEffectCents`), against the platform's
  receivable (1370 ff.), the receivable line carrying the report. Any other platform (Stripe,
  PayPal, Amazon, other) collects for the seller and needs another booking: no proposal, and the
  sync names the problem `unsupported_platform_settlement`.
- **Bank transaction** (`tx:<id>`, on a bank `accounts` row only): the bank's own account (1800,
  1810, ...) against, in this order: the open-item accounts of its confirmed documents
  (allocated amounts, a collective payment split per document, a remainder on the last line with
  `amount_differs_from_payment`; when one of the documents has no open-item account, such as a
  platform settlement without a receivable, the next steps decide instead); the account of the
  clearing account it is paired with (an app-store payout to the platform receivable, carrying
  the report when exactly one); a no-document rule whose pattern is in the counterparty name or
  the remittance text ("Stammeinlage" to 2900) and whose direction fits the money (money in is
  the revenue side, `outgoing`; money out the expense side, `incoming`), never a rule learned
  from documents, so a supplier's refund is not booked by its invoice rule; the contact's own
  open-item account; a shareholder's account (all name parts of the person in the counterparty
  name), after every explicit rule; 1360 for a transfer to another own bank account.
  Anything else gets no proposal: an unexplained bank transaction stays a problem.

Warnings: `no_tax_breakdown`, `amount_differs_from_payment`, `possible_pass_through` (notary,
court or register costs with German VAT and no pass-through amount), `foreign_supplier_with_vat`
(Finom NL, Apple IE with German VAT), `duplicate_suspect` (same contact, invoice number and
amount as an earlier document), `ai_unavailable`, `reverse_charge_conflict` (a German supplier's
printed German VAT next to a reverse-charge note). Problems (no proposal, named after
"Vorschläge aktualisieren"): `unsupported_platform_settlement`.

**The AI advisor** (`LedgerBookingAdvisor`) is asked for an account from the workspace's own
expense accounts, a tax code and one German sentence, optionally a split (a court fee and a
dunning fee). It is told only the extracted fields, never the OCR text (AGENTS.md "Mistral and
personal data"). Every answer, of any kind, is kept per document in `ledger_booking_advice` under
a hash of the whole question and the advisor's version; the same question is never asked twice,
a changed document, chart or prompt is. A sync asks at most 40 questions; the rest wait for the
next run, which the job schedules right away. A failing call is not cached.

**Rules**: a rule's direction names the side it books: `incoming` the expense side (incoming
invoices, money out), `outgoing` the revenue side (outgoing invoices, money in), `any` both. A
proposal from a rule stores `rule:<id>` as its reason; booking it increments the rule's `hits`.
`learnRuleFromEntry` ("Als Regel speichern") creates or updates the rule of the entry's contact
(an invoice: account, tax code, the contact's or shareholder's open-item account) or of a bank
transaction's counterparty (a no-document rule by name pattern, in the money's direction). An
existing rule keeps its direction unless the learned tax code does not fit it.

**Open items**: after every sync and every booking, `autoMatchOpenItems` matches the booked lines
of an open-item account that carry the same document and sum to zero (created by no user). After
a booking it runs once the booking committed; a failure there is logged and never turns the
booking into an error. `bulkBook` books each entry in its own transaction and reports any failure
with that entry (`unknown` for an unexpected one); the rest are still booked.
Everything else is only suggested: `suggestMatches(accountId)` (Google Ads 10 + 50 + 36,57 against
96,57; one Google Play payout against three reports).

**Triggers**: `syncLedgerProposalsAction`, and the `ledger-sync` job, scheduled
(`scheduleNow`, one queued run per workspace) after every `match-payments` and
`match-settlement-lines` run while the ledger is on.

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
  but not applied yet (the USt-VA page and the settings say so).
- The comparison with the tax advisor uses her account totals only; it cannot show which of her
  bookings differ.
- The rule and chart forms list up to 1000 contacts.
- Bases are reported in cents; the form rounds them to whole euros.
- A proposal whose source disappears or no longer qualifies (a deleted document, a removed
  match) is left as it is; the engine never deletes proposals.
- A payment to a shareholder is recognized only through a person-owned account in the chart
  (`owner_type = person`); workspace members are not consulted.
- `payment_no_document_rules` carry no target account, so they alone produce no proposal; a bank
  transaction is booked by a ledger rule only when that rule is itself a no-document rule.
- Rules learned from bank transactions before 2026-11-12 used `incoming` for money in; such a
  rule now applies to money out only and needs its direction changed (or `any`) in the rules
  settings.
- Platform fee tax codes are a default (`rc13b` for Google, none otherwise) until the tax
  advisor confirms them (decisions/0080 "Consequences").

## Data

Tables `ledger_settings`, `ledger_accounts`, `journal_entries`, `journal_lines`,
`journal_entry_revisions`, `ledger_open_item_matches`, `ledger_open_item_match_lines`,
`ledger_booking_rules`, `ledger_filings`, `ledger_handovers`, `ledger_advisor_balances`,
`ledger_advisor_balance_lines`, `ledger_booking_advice` (`src/persistence/schema/ledger.ts`, migration
`0028_illegal_mad_thinker.sql`, custom migrations `0029_ledger_balanced_entries.sql` and
`0030_ledger_filing_lock.sql`, phase 3's `0032_icy_medusa.sql` with `ledger_booking_advice` and
`journal_lines.document_id`, `0033_flippant_mercury.sql` with the unique revision index), written
only by
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
Postgres). Phase 3: `tests/proposals.test.ts` (every template on the Itegro fixtures, each draft
rendered through `de.json`), `tests/booking-advisor.test.ts`, `tests/open-item-matching.test.ts`,
`tests/rule-learning.test.ts`, `src/persistence/tests/ledger-sync-jobs.test.ts` (scheduling and
the job handlers), `src/persistence/tests/ledger-sync.db.test.ts` (the sync end to end: sources,
AI cache, idempotency, edited and dismissed proposals, automatic matches and suggestions,
learned rules and hits, workspace scoping). The fixtures are the real cases of decisions/0080: IONOS, the Meta prepaid credit,
Google Ads charged 10 + 50 + 36,57 against one invoice of 96,57, the notary paid by a shareholder
with 9,00 pass-through costs, the share capital, the court letter with 300 + 5. UI part 1:
`tests/editor-model.test.ts` (each mode's lines for IONOS, Meta § 13b, the court split, a transfer
and income; recognizing existing lines; mode switching; the correction's reversed lines),
`tests/entry-editor.test.tsx`, `tests/review-queue-client.test.tsx` and
`tests/journal-filters.test.tsx` (Testing Library + jsdom, the actions mocked),
`tests/search-params.test.ts`, `tests/periods.test.ts`, `tests/revision-diff.test.ts`, and
`tests/ui-messages-i18n.test.ts` (every literal message key in `ui/` and the pages resolves, and
every value set the UI shows, and no em or en dash in `Ledger.*`). UI part 2:
`tests/balance-view.test.ts` (grouping, signs, mixed groups, empty accounts, open-item account
types), `tests/ui2-core.test.ts` (the account sheet with proposals, `vatKennzahlenOfEntry`, the
document status, the accounts URL parameters, `startedVatPeriods`), and Testing Library tests
`tests/balance-list.test.tsx` (groups, both views, chips, links, Soll = Haben),
`tests/open-items-client.test.tsx` (Ausgleichen only at zero, a note to explain, a suggestion
applied, undo, read-only), `tests/periods-client.test.tsx` (the checkbox, the lock count, the
Zahllast warning, draft then submit, the correction guide, the handover),
`tests/advisor-comparison.test.tsx`, `tests/rules-settings.test.tsx` and
`tests/document-ledger-card.test.tsx`; `src/persistence/tests/ledger-use-cases.db.test.ts` covers
the new reads. End to end: `tests/e2e/ledger.spec.ts` (from the finance page's link through
enabling, booking the share capital, the journal, Konten 2900 in both views, its Kontenblatt,
the reports and settings pages; a member gets 404 on every ledger route and no nav entry).
Fixes after the acceptance replay: `tests/proposals.test.ts` ("fixes from the acceptance replay
and the review": the three share-capital credits, the Meta top-up fallback, the cancellation of
0,50 at 19 % plus 1,50 at 7 %, the Stripe report, the refund, reverse charge against printed
VAT), `tests/reports.test.ts` (the 2970 carry-forward, a match across the cut-off date),
`tests/open-item-matching.test.ts` (3000 lines under 0,5 s), `tests/schemas.test.ts` and
`tests/rules-settings.test.tsx` (tax codes by direction), `tests/advisor.test.ts` and
`tests/advisor-comparison.test.tsx` (limits), `tests/entry-editor.test.tsx` and
`tests/periods-client.test.tsx` (retries, the correcting filing choice),
`src/persistence/tests/ledger-integrity.db.test.ts` (matches on unbooking, deleting and editing,
the correcting filing flow, concurrent writers on two connections, the unique revision index,
`bulkBook` and the matching after a booking) and `src/persistence/tests/ledger-use-cases.db.test.ts`
(the year boundary in the list, the Kontenblatt and the advisor comparison).
