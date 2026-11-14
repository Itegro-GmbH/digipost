# Bookkeeping on the external ledger API, switchable per workspace

Document type: decision
Lifecycle: active
Owner: src/modules/ledger
Scope: How Digipost's bookkeeping (`src/modules/ledger`) moves from its in-process use cases onto
the external ledger API: stage A (switchable per workspace, off by default) and stage B (the
finance pages read from the API, Digipost's own ledger and source tables dropped)
Canonical responsibility: Active source for which workspaces run their books on the API, what
Digipost sends there, and what still stays in Digipost
Maintenance triggers:
- A workspace is switched to the API in production (`LEDGER_API_WORKSPACES`)
- The ledger API gains an operation this stage lacks (ids on money accounts and movements, a
  settings read, `changedSince`)
- Stage B starts
Last verified: 2026-11-13, stage A implemented, against `src/platform/ledger-api/`,
`src/persistence/use-cases/ledger-api-use-cases.ts`, `ledger-api-source-push.ts`,
`ledger-router.ts` and the ledger API repository's `packages/operations/src/*.ts`

## Status

Accepted. Stage A implemented; stage B not started.

## Context

The ledger API (its own repository, its decisions/0001-ledger-api.md) is a multi-tenant
bookkeeping core reached only through an API. Its bookkeeping use cases are Digipost's own from
decisions/0080, moved over: the same views, the same error codes, `workspaceId` renamed
`tenantId`. A tenant is a Digipost workspace (`tenant.id = workspace.id`), and the API also owns
copies of the sources the books are made from: counterparties (contacts), money accounts
(`accounts`), movements (`transactions`), statement records (`import_batches`), settlement lines,
the documents' accounting view, the confirmed movement-document links, payment aliases and the
"no document needed" rules, with Digipost's ids (the switch copies Digipost's rows inside the
shared database instance, keeping every id).

Digipost must be able to move one workspace at a time, keep every page, action and MCP tool
working unchanged, and go back by changing one variable.

## Decision

### Stage A: switchable per workspace, off by default

- `src/platform/ledger-api` is the HTTP client (`POST /v1/<operation>`, a bearer platform key,
  `Ledger-Tenant` = workspace id, `Ledger-Actor` = the acting user's id or `digipost:system`, a
  fresh `Idempotency-Key` per write). It is the only holder of `LEDGER_API_KEY`; nothing secret
  and no body is ever logged.
- `LEDGER_API_WORKSPACES` (comma-separated workspace ids, empty by default) selects the
  workspaces whose bookkeeping runs on the API. With it unset, nothing about the API is built or
  called and every workspace runs exactly the in-process ledger of decisions/0080.
- The composition root hands every caller (pages, Server Actions, MCP tools, the job handlers)
  one `ledger`: a router (`ledger-router.ts`) that picks, per call and by the call's workspace,
  the API-backed `LedgerUseCases` (`ledger-api-use-cases.ts`) or the in-process one.
- The API-backed implementation maps each method to its operation and returns the answer
  unchanged; an API code that is a ledger code becomes the same `UseCaseError`, so the actions
  and the UI need no change. `tenant_not_found` reads as `disabled`. What stays in Digipost:
  `getSources` (Digipost owns documents and transactions) and the `ledger-sync` job itself.
- Before every proposal sync (the `ledger-sync` job and "Vorschläge aktualisieren"), Digipost
  pushes the workspace's current sources with the API's upsert operations: a full, idempotent
  snapshot (money accounts, movements, links and marks diffed against what the API lists, the
  rest upserted in full), then `sync_proposals`.
  Digipost's own data stays where it is; the push only reads it.
- A money account or movement the API does not hold yet (one created after the copy) is created
  there with Digipost's id (ledger-api PR #12: `create_money_account` and
  `upsert_money_movements` accept one), so every link, entry and payment suggestion keeps naming
  the same row. Statement records (`import_batches`) of newer imports are not pushed.

### Stage B: the API as the only books (later)

After a verified period with the switched workspaces (balances per account, VAT previews, open
items, bank comparisons and controls identical on both sides):

1. Digipost's finance pages (accounts, transactions, statement import, open items) and its MCP
   finance tools read from and write to the API as well; sources are sent when they arise
   (an outbox after analysis, the statement import through `import_bank_statement`) instead of
   a snapshot before each sync.
2. Workspace deletion calls `delete_tenant` in the same flow (decisions/0027 is updated then).
3. Digipost's own ledger tables and the source tables that moved are dropped, in a separate,
   approved migration, only after the verified period. Matching (suggestions, the AI arbiter,
   rejections) and contact change proposals stay in Digipost and reference the moved rows by id.

## Consequences

- One variable switches a workspace either way; nothing is migrated by stage A itself. The
  data copy into the API's schema is the API repository's adoption step and needs the owner's
  explicit approval at that time.
- A switched workspace's books depend on the API's availability; a failed call surfaces as
  `unknown` in an action and as a retried job, never as a silent fallback to the in-process
  ledger (a switched workspace with no URL or key fails every call with `not_configured`).
- The same data-protection condition as in decisions/0016 applies to the API's AI booking advisor
  (Mistral): document summaries and the accounting view now reach the API, which runs it.

## Mapping (stage A)

| `LedgerUseCases` | API operation |
|---|---|
| `getSettings`, `isEnabled`, `countWaitingProposals`, `getBankComparisons`, `getControls`, `listOpenItemAccounts` | `get_overview` (settings read once per request) |
| `setSettings` | `update_tenant` (VAT settings; the API's books cannot be switched off) |
| `syncChart`, `listAccounts` | `list_accounts` (the API adds money accounts' ledger accounts at every `sync_proposals`) |
| `createAccount`, `updateAccount`, `setAccountArchived` | `create_account`, `update_account`, `set_account_archived` |
| `listEntries` | `list_entries`, paged (`changedSince` filtered by the entries' `updatedAt`) |
| `getEntry` | `get_entry` |
| `createEntry`, `updateEntry`, `deleteEntry`, `unbookEntry` | `create_entry`, `update_entry`, `delete_entry`, `unbook_entry` |
| `bookEntry`, `bulkBook` | `book_entries` |
| `dismissProposal`, `restoreProposal` | `dismiss_proposal`, `restore_proposal` |
| `getBalances`, `getAccountSheet`, `getAccountSheets`, `getOpenItems`, `getVatPreview` | `get_balances`, `get_account_sheet`, `get_open_items`, `get_vat_preview` |
| `getPeriodOverview`, `listFilings`, `listHandovers` | `list_periods` |
| `createMatch`, `deleteMatch`, `suggestMatches` | `create_open_item_match`, `delete_open_item_match`, `get_open_items` |
| `listRules`, `createRule`, `updateRule`, `deleteRule`, `learnRuleFromEntry` | `list_rules`, `create_rule`, `update_rule`, `delete_rule`, `learn_rule_from_entry` |
| `createFiling`, `submitFiling`, `createCorrectionFiling`, `createHandover` | `create_filing` (+ `submit_filing` for one recorded as submitted), `submit_filing`, `create_correction_filing`, `create_handover` |
| `uploadAdvisorBalances`, `listAdvisorUploads`, `getAdvisorComparison`, `deleteAdvisorUpload` | `import_advisor_balances`, `get_advisor_comparison`, `delete_advisor_balances` |
| `syncProposals` | the source push, then `sync_proposals` |
| `getSources`, `scheduleSync` | local (Digipost's sources; Digipost's job queue) |
| `autoMatchOpenItems` | none: a no-op, the API matches inside `sync_proposals` and after booking |
| `upsertProposal`, `listSourceKeys` | none: the in-process engine's internals, they throw |

## Open points

- Statement records of imports after the switch stay in Digipost: the API's bank comparison
  starts from the last copied statement until the push sends them.
- `upsert_settlement_lines` landed in the API while this stage was built; the push sends
  `{ lines: [{ id, clearingAccountId, sourceDocumentId, transactionId, ...settlement_lines
  columns }] }` as its schema reads (`upsertSettlementLines`/`settlementLineOf` in
  `ledger-api-source-push.ts`), not yet tried against a running API.
- Digipost's own outgoing invoices (`invoices`, decisions/0079) are not a source of the API; the
  API books an issued invoice from its inbox document's accounting view.
- A document deleted in Digipost stays in the API (there is no delete operation for documents).
- A movement refreshed by the push (a new payout pairing) gets the pushed fields as its raw
  value in the API.
