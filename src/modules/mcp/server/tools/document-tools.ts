// Owner: src/modules/mcp (decisions/0078-mcp-server.md). Document tools: the Posteingang search,
// the detail view, a download link, and every document action the dashboard offers. Upload is
// out of scope for v1 (user decision 4). Reads go through `@/modules/documents/server`'s read
// models, writes through `@/modules/documents/actions` - the very Server Actions the dashboard
// calls, so validation, permission checks and side effects are the same code.
import "server-only";

import { z } from "zod";

import {
  confirmIntakeAction,
  deleteDocumentAction,
  reclassifyDocumentAction,
  rejectIntakeAction,
  resetIntakeFingerprintAction,
  retryProcessingAction,
} from "@/modules/documents/actions";
import { RECLASSIFIABLE_KINDS } from "@/modules/documents";
import {
  getDocumentDetailProjection,
  getDocumentDownloadUrlProjection,
  listDocumentSummariesProjection,
  listIntakeFingerprintsProjection,
} from "@/modules/documents/server";
import { SEMANTIC_FIELDS, SETTLEMENT_PLATFORMS } from "@/modules/intake";
import { getEmailSourceForDocumentProjection } from "@/modules/mail-intake/server";
import { getDocumentPaymentSectionProjection, getSettlementReportProjection } from "@/modules/payments/server";
import { PERMISSIONS } from "@/platform/access";
import { DOCUMENT_DIRECTIONS, DOCUMENT_KINDS, DOCUMENT_STATUSES } from "@/persistence/repositories/contracts";

import { defineWorkspaceTool, fail, fromActionResult, MCP_ERROR, ok } from "../../core/tool-kit";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/** Default and maximum OCR text returned per call: whole letters fit, a 200-page contract pages. */
const OCR_DEFAULT_CHARS = 20_000;
const OCR_MAX_CHARS = 100_000;
/** An intake proposal larger than this is summarized instead of returned. */
const INTAKE_RESULT_MAX_CHARS = 60_000;
/** Presigned download links live five minutes (decisions/0012-object-storage.md: minutes, not hours). */
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 300;

export const searchDocumentsTool = defineWorkspaceTool({
  name: "search_documents",
  title: "Search documents",
  description:
    "Searches the workspace's documents (the 'Posteingang'): full-text search over OCR text and extracted fields " +
    "(German stemming, web-search syntax: words, \"phrases\", -exclusions) plus filters. Returns compact rows " +
    "(no OCR text) ordered by the document's own date, newest first, or by relevance when q is set. " +
    "Amounts are integer cents. paymentStatus is the effective one (an open invoice past its due date is overdue). " +
    "Page with page/hasMore. Use get_document for one document's details.",
  input: z.object({
    q: z.string().trim().max(200).optional().describe("Full-text query"),
    status: z.enum(DOCUMENT_STATUSES).optional().describe("Processing status"),
    direction: z.enum(DOCUMENT_DIRECTIONS).optional().describe("incoming = received, outgoing = issued by the workspace"),
    kind: z.enum(DOCUMENT_KINDS).optional(),
    paymentStatus: z.enum(["open", "overdue", "paid"]).optional(),
    pendingConfirmation: z.boolean().optional().describe("Only documents whose intake proposal waits for confirmation"),
    from: isoDate.optional().describe("Earliest document date, inclusive"),
    to: isoDate.optional().describe("Latest document date, inclusive"),
    sort: z.enum(["documentDate", "uploaded"]).default("documentDate"),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
  }),
  permission: PERMISSIONS.documentsRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    const result = await listDocumentSummariesProjection(ctx.workspace.id, {
      q: input.q || undefined,
      status: input.status,
      direction: input.direction,
      kind: input.kind,
      paymentStatus: input.paymentStatus,
      intakeStatus: input.pendingConfirmation ? "pending_confirmation" : undefined,
      from: input.from,
      to: input.to,
      sort: input.sort,
      page: input.page,
      pageSize: input.pageSize,
    });
    return ok(result);
  },
});

function sliceOcrText(text: string | null, offset: number, maxChars: number) {
  if (text === null) return { ocrText: null, ocrTextLength: 0, ocrTextOffset: 0, ocrTextTruncated: false };
  const slice = text.slice(offset, offset + maxChars);
  return { ocrText: slice, ocrTextLength: text.length, ocrTextOffset: offset, ocrTextTruncated: offset + slice.length < text.length };
}

function boundedIntakeResult(intakeResult: unknown) {
  if (intakeResult === null || intakeResult === undefined) return { intakeResult: null };
  const json = JSON.stringify(intakeResult);
  if (json.length <= INTAKE_RESULT_MAX_CHARS) return { intakeResult };
  return { intakeResult: null, intakeResultOmitted: `Too large to return (${json.length} characters).` };
}

export const getDocumentTool = defineWorkspaceTool({
  name: "get_document",
  title: "Get document",
  description:
    "One document's details as the dashboard shows them: extracted fields (sender, dates, invoice number, amount in " +
    "cents, IBAN, due date), summary, linked contacts, intake status, possible duplicate, and its payment status. " +
    "Admins (finance.read) also get matched bank transactions, payment suggestions and a settlement report " +
    "breakdown; for other members those are redacted exactly like in the dashboard. " +
    "include: 'ocrText' adds the OCR text (paged with ocrOffset/ocrMaxChars), 'intake' adds the raw intake " +
    "proposal (needed for confirm_intake).",
  input: z.object({
    documentId: z.uuid(),
    include: z.array(z.enum(["ocrText", "intake"])).max(2).default([]),
    ocrOffset: z.number().int().min(0).default(0),
    ocrMaxChars: z.number().int().min(1).max(OCR_MAX_CHARS).default(OCR_DEFAULT_CHARS),
  }),
  permission: PERMISSIONS.documentsRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    const workspaceId = ctx.workspace.id;
    const document = await getDocumentDetailProjection(workspaceId, input.documentId);
    if (!document) return fail(MCP_ERROR.notFound);

    const canReadFinance = ctx.permissions.includes(PERMISSIONS.financeRead);
    const isInvoiceShaped = document.paymentStatus !== "not_applicable";
    const isSettlementReport = (document.kind === "payout_report" || document.kind === "platform_settlement") && document.intakeStatus === "confirmed";
    const [payment, settlementReport, emailSource] = await Promise.all([
      // The same redaction the document page applies: `revealFinanceDetails` is the caller's own
      // finance.read, so a member gets status and paid date, never amounts, counterparties or
      // suggestions (decisions/0025-payment-matching-wiring.md).
      isInvoiceShaped ? getDocumentPaymentSectionProjection(workspaceId, document.id, canReadFinance) : Promise.resolve(null),
      isSettlementReport && canReadFinance ? getSettlementReportProjection(workspaceId, document.id) : Promise.resolve(null),
      document.uploadedByEmail ? Promise.resolve(null) : getEmailSourceForDocumentProjection(workspaceId, document.id),
    ]);

    const { ocrText, intakeResult, ...fields } = document;
    const includeOcr = input.include.includes("ocrText");
    const includeIntake = input.include.includes("intake");
    return ok({
      document: {
        ...fields,
        receivedByEmailFrom: emailSource?.fromAddress ?? null,
        ...(includeOcr ? sliceOcrText(ocrText, input.ocrOffset, input.ocrMaxChars) : { ocrTextLength: ocrText?.length ?? 0 }),
        ...(includeIntake ? boundedIntakeResult(intakeResult) : {}),
      },
      payment,
      settlementReport,
    });
  },
});

export const getDocumentDownloadUrlTool = defineWorkspaceTool({
  name: "get_document_download_url",
  title: "Get document download link",
  description:
    "A short-lived (5 minutes) download link for the document's file: the searchable PDF once processing produced " +
    "one, otherwise the original upload. Anyone holding the link can download the file until it expires, so only " +
    "pass it to the user, never to third parties.",
  input: z.object({ documentId: z.uuid() }),
  permission: PERMISSIONS.documentsRead,
  effect: "read",
  async run(input, ctx) {
    const link = await getDocumentDownloadUrlProjection(ctx.workspace.id, input.documentId, DOWNLOAD_URL_EXPIRES_IN_SECONDS);
    if (!link) return fail(MCP_ERROR.notFound);
    return ok({ ...link, expiresAt: new Date(Date.now() + link.expiresInSeconds * 1000).toISOString() });
  },
});

export const deleteDocumentTool = defineWorkspaceTool({
  name: "delete_document",
  title: "Delete document",
  description:
    "Permanently deletes a document: the record, its stored files, its contact links and payment links. " +
    "This CANNOT be undone. Confirm with the user before calling. Note: deleting does not refund the monthly upload quota.",
  input: z.object({ documentId: z.uuid() }),
  permission: PERMISSIONS.documentsWrite,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await deleteDocumentAction(input), { deleted: true });
  },
});

export const retryDocumentProcessingTool = defineWorkspaceTool({
  name: "retry_document_processing",
  title: "Retry processing",
  description: "Re-queues OCR and extraction for a document whose processing failed (status 'failed'). Processing runs in the background.",
  input: z.object({ documentId: z.uuid() }),
  permission: PERMISSIONS.documentsWrite,
  effect: "write",
  async run(input) {
    return fromActionResult(await retryProcessingAction(input), { queued: true });
  },
});

export const changeDocumentKindTool = defineWorkspaceTool({
  name: "change_document_kind",
  title: "Change document kind",
  description:
    "Corrects the recognized kind of a processed PDF ('Dokumentart ändern') and re-extracts its fields as that kind " +
    "in the background. Open payment suggestions of the document are discarded. Only for PDFs, not for structured imports.",
  input: z.object({ documentId: z.uuid(), kind: z.enum(RECLASSIFIABLE_KINDS) }),
  permission: PERMISSIONS.documentsWrite,
  effect: "write",
  async run(input) {
    return fromActionResult(await reclassifyDocumentAction(input), { queued: true });
  },
});

const columnMapping = z
  .partialRecord(z.enum(SEMANTIC_FIELDS), z.string().min(1))
  .describe("Semantic field -> source column header, as proposed in the document's intake proposal");

const amountSign = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("signed_column"), column: z.string().min(1) }),
    z.object({ mode: z.literal("separate_credit_debit_columns"), creditColumn: z.string().min(1), debitColumn: z.string().min(1) }),
    z.object({
      mode: z.literal("indicator_column"),
      amountColumn: z.string().min(1),
      indicatorColumn: z.string().min(1),
      creditValue: z.string().min(1),
      debitValue: z.string().min(1),
    }),
  ])
  .nullable();

export const confirmIntakeTool = defineWorkspaceTool({
  name: "confirm_intake",
  title: "Confirm intake proposal",
  description:
    "Confirms a tabular import's proposal ('Bestätigen und importieren') and imports its rows: the document kind, " +
    "the platform for settlement reports, the column mapping and how amounts are signed. Read the proposal first " +
    "with get_document(include: ['intake']). The mapping is re-validated against the whole file; on " +
    "mapping_validation_failed the details list each failing row. Confirming also remembers the source layout for " +
    "future files of the same shape.",
  input: z.object({
    documentId: z.uuid(),
    documentKind: z.enum(DOCUMENT_KINDS),
    platform: z.enum(SETTLEMENT_PLATFORMS).nullable(),
    mapping: columnMapping,
    amountSign,
  }),
  permission: PERMISSIONS.documentsWrite,
  effect: "write",
  async run(input) {
    return fromActionResult(await confirmIntakeAction(input), { confirmed: true });
  },
});

export const rejectIntakeTool = defineWorkspaceTool({
  name: "reject_intake",
  title: "Reject intake proposal",
  description:
    "Rejects a tabular import's proposal ('Ablehnen'): nothing is imported. A rejected proposal is deleted " +
    "automatically after 30 days.",
  input: z.object({ documentId: z.uuid() }),
  permission: PERMISSIONS.documentsWrite,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await rejectIntakeAction(input), { rejected: true });
  },
});

export const listIntakeSourcesTool = defineWorkspaceTool({
  name: "list_intake_sources",
  title: "List recognized sources",
  description: "The confirmed tabular source layouts ('Erkannte Quellen') that are imported without asking again. Admin only.",
  input: z.object({}),
  permission: PERMISSIONS.intakeManage,
  effect: "read",
  idempotent: true,
  async run(_input, ctx) {
    return ok({ sources: await listIntakeFingerprintsProjection(ctx.workspace.id) });
  },
});

export const resetIntakeSourceTool = defineWorkspaceTool({
  name: "reset_intake_source",
  title: "Reset recognized source",
  description:
    "Forgets a confirmed source layout ('Zuordnung zurücksetzen'), so the next file of that shape asks for " +
    "confirmation again. Already imported data stays. Cannot be undone except by confirming again. Admin only.",
  input: z.object({ fingerprintId: z.uuid() }),
  permission: PERMISSIONS.intakeManage,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await resetIntakeFingerprintAction(input), { reset: true });
  },
});

export const DOCUMENT_TOOLS = [
  searchDocumentsTool,
  getDocumentTool,
  getDocumentDownloadUrlTool,
  deleteDocumentTool,
  retryDocumentProcessingTool,
  changeDocumentKindTool,
  confirmIntakeTool,
  rejectIntakeTool,
  listIntakeSourcesTool,
  resetIntakeSourceTool,
];
