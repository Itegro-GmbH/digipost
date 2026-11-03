# src/modules/mcp

Document type: reference
Lifecycle: active
Owner: src/modules/mcp
Scope: The remote MCP server at `/api/mcp` (Streamable HTTP, stateless), its tool catalog, the
per-call permission enforcement and audit line, and the "KI-Verbindungen" settings page plus the
OAuth consent form
Canonical responsibility: Which dashboard capabilities an AI client can use, with which
permission, and how one tool call runs as the token's user
Maintenance triggers:
- A dashboard capability is added, changed or removed (decide whether it becomes a tool, and
  keep `tests/tool-permissions.test.ts`'s permission table in step)
- A permission bundle in `src/platform/access` changes
- The MCP SDK (`@modelcontextprotocol/server`) or the protocol revision it serves changes
- A user decision behind the exclusions below changes (decisions/0078-mcp-server.md)
Last verified: 2026-11-03, decisions/0078-mcp-server.md: this module landed, 44 tools, against
`src/modules/*/actions.ts`, the `(app)` pages and `src/platform/access/core/permissions.ts`

## Purpose

A user enters `https://<host>/api/mcp` into any standards-compliant AI client (Claude, ChatGPT,
Cursor, ...). The client discovers the OAuth authorization server, the browser opens, the user
signs in with their normal Digipost account and consents, and from then on the AI can do what
the user can do in the dashboard, with the user's own permissions and nothing more. The OAuth
side (authorization server, token verification, grants, rate limit) lives in
`src/platform/auth`; this module is everything after a request is authenticated.

## Public interfaces

- `server.ts` (`server-only`): `handleMcpRequest(request, caller)` for
  `src/app/api/mcp/route.ts`, `listAiClientsProjection(userId)` for
  `/dashboard/settings/ai-clients`.
- `actions.ts` (`"use server"`): `revokeAiClientAction({ clientId })` ("Verbindung trennen").
- `client.ts` (`"use client"`): `AiClientsList`, `CopyMcpUrl`, `ConsentForm` (used by
  `src/app/(auth)/oauth/consent/page.tsx`).

## Structure

- `core/tool-kit.ts` - the tool shape (`defineWorkspaceTool`/`defineUserTool`), outcome codes
  (`MCP_ERROR`), `fromActionResult`, the shared optional `workspaceId` argument.
- `core/schemas.ts`, `core/error-codes.ts`, `core/types.ts` - the revoke action's input, codes,
  and the settings page's view type.
- `server/execute-tool.ts` - runs one tool call (see "How a tool call runs").
- `server/tool-registry.ts` - `MCP_TOOLS`, the one list of every tool.
- `server/tools/*.ts` - the tools, grouped by the module that owns the capability.
- `server/mcp-server.ts` - the per-request `McpServer` factory and the SDK handler.
- `server/read-models.ts` - the connected-clients list.
- `ui/` - the settings page's list and copy button, the consent buttons.
- `tests/` - permission matrix, enforcement, redaction, transport.

## How a tool call runs

1. `src/app/api/mcp/route.ts` -> `withMcpBearerAuth` (`src/platform/auth`): JWT signature,
   issuer, audience `/api/mcp`, `digipost` scope, a consent that still exists, rate limit.
2. `handleMcpRequest` builds a fresh `McpServer` for this request and lets the SDK validate the
   arguments against the tool's Zod schema.
3. `executeTool` runs the call inside `runAsDelegatedPrincipal` (`src/platform/access`): every
   access check inside it, including each Server Action's own `requirePermission`, resolves the
   token's user and the workspace the call named, through `resolveAccess`. A `workspaceId` the
   user is not a member of ends the call with `workspace_not_found`; no session cookie is read.
4. The tool's declared permission (the dashboard's own bundle for the same capability) is
   checked against the user's role in that workspace, then the tool runs: reads through the
   owning module's read models (`server.ts`), writes through the owning module's Server Action -
   the very function the dashboard calls, so validation, permission check, side effects
   (`revalidatePath`, job kicks) and error codes are the same code. This module writes no table
   of its own and duplicates no business rule.
5. One audit line (`logAuditEvent("mcp.tool_call", ...)`, `src/platform/observability`): tool,
   effect, user id, client id, workspace id, outcome, error code, duration. Never arguments or
   results.

## Tools

Every workspace tool takes an optional `workspaceId` (from `list_workspaces`). Amounts are integer
cents. `tests/tool-permissions.test.ts` holds the authoritative permission table.

| Tool | Permission | Effect |
|---|---|---|
| `list_workspaces` | (own memberships) | read |
| `get_overview` | `documents.read` (+ finance counts with `finance.read`) | read |
| `get_company_profile`, `update_company_profile` | `company_profile.manage` | read / write |
| `search_documents`, `get_document`, `get_document_download_url` | `documents.read` | read |
| `delete_document` | `documents.write` | destructive |
| `retry_document_processing`, `change_document_kind`, `confirm_intake` | `documents.write` | write |
| `reject_intake` | `documents.write` | destructive |
| `list_intake_sources` / `reset_intake_source` | `intake.manage` | read / destructive |
| `search_contacts`, `get_contact`, `list_contact_proposals` | `documents.read` | read |
| `create_contact`, `update_contact`, `verify_contact`, `accept_contact_proposal`, `reject_contact_proposal`, `unlink_document_from_contact` | `documents.write` | write |
| `delete_contact`, `merge_contacts` | `documents.write` | destructive |
| `mark_contact_as_own_company`, `mark_contact_as_own_bank` | `company_profile.manage` | destructive |
| `list_accounts`, `list_transactions`, `list_unmatched_transactions`, `list_open_items`, `get_closing_report` | `finance.read` | read |
| `create_account`, `update_account`, `create_contact_clearing_account`, `import_statement`, `confirm_payment_suggestion`, `reject_payment_suggestion`, `link_payment`, `mark_transactions_no_document_needed`, `set_payment_auto_confirm_mode` | `finance.manage` | write |
| `unlink_payment`, `delete_payment_alias` | `finance.manage` | destructive |
| `mark_document_settled_without_payment` | `documents.write` | write |

Finance redaction follows the dashboard exactly: `get_document` asks
`getDocumentPaymentSectionProjection` with the caller's own `finance.read`, so a member sees the
payment status and paid date but never an amount, counterparty or suggestion of a transaction,
and never a settlement report; `get_contact` adds learned payment names and the clearing account
only with `finance.read`; `get_overview` adds the two finance counts only with `finance.read`.

**Not offered, on purpose** (decisions/0078-mcp-server.md): workspace deletion, member
management (invite, remove, role, leave), billing tiers and packages, E-Mail-Eingang settings
(user decision 2); upload (v2, user decision 4); the Abschluss ZIP export (a large binary
download, dashboard only); onboarding, invitation acceptance and the workspace switcher (browser
flows; `workspaceId` replaces the switcher). Document rename does not exist in the dashboard
either: names are generated (decisions/0059-generated-document-names.md).

## Efficiency

`search_documents` uses `DocumentRepository.listSummaries` (one query, only list columns, no OCR
text, no intake payload, the inbox's own filter and order). `search_contacts` uses
`listContactSummariesProjection` (one query, no per-row detail lookup). `get_document` returns OCR
text only on request and paged (`ocrOffset`/`ocrMaxChars`), the raw intake proposal only on
request and bounded. `list_unmatched_transactions` pages in memory over the same list the
"Zuordnung" page loads.

## Persistence

None of its own. The usage/rate-limit table `auth."mcpClientUsage"` belongs to
`src/platform/auth` (it is part of the grant).

## Dependencies on other owners

`src/platform/auth` (`McpCaller`, grants), `src/platform/access` (delegated principal, guards,
permissions), `src/platform/observability` (audit line), and the read models and Server Actions
of `src/modules/documents`, `contacts`, `accounts`, `payments`, `closing`, `workspaces`,
`mail-intake` (only `getEmailSourceForDocumentProjection`, a document's sender address).

## Tests

- `tests/tool-permissions.test.ts` - the permission of every tool, the exclusions, destructive
  descriptions; member vs admin, a `workspaceId` outside the memberships, a write running the
  real Server Action in the named workspace, the audit line, finance redaction of
  `get_document`, paged OCR text. The access layer and the actions run for real; only the
  persistence door and read models are mocked.
- `tests/mcp-server.test.ts` - the real SDK transport in process: initialize, `tools/list` (every
  schema converts to JSON Schema, `workspaceId` present, annotations), a tool error.
- `tests/integration/http/mcp-oauth.integration.test.ts` - the whole OAuth flow and real tool
  calls against the test database (see `src/platform/auth/README.md`).
- `tests/e2e/mcp-connect.spec.ts` (`@smoke`) - the consent page and "KI-Verbindungen" in a browser.
