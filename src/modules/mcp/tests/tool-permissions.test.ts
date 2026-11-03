// Unit test (no DB, no network): permission enforcement of every MCP tool
// (decisions/0078-mcp-server.md). The persistence door, the auth session, the read models and the
// observability sink are mocked at the module paths the code imports; `src/platform/access` and
// the Server Actions run for real, so these tests prove the SAME access code the dashboard uses
// decides here too.
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMembershipsForUser = vi.fn();
const deleteDocument = vi.fn();
vi.mock("@/persistence/composition/request-services", () => ({
  getRequestServices: () => ({ workspaces: { listMembershipsForUser }, documents: { deleteDocument } }),
}));

vi.mock("@/platform/auth/server", () => ({
  getCurrentUser: vi.fn(async () => {
    throw new Error("an MCP tool call must never read the session cookie");
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "22222222-2222-4222-8222-222222222222" }) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const logAuditEvent = vi.fn();
vi.mock("@/platform/observability/server", () => ({ logAuditEvent: (...args: unknown[]) => logAuditEvent(...args), captureError: vi.fn() }));

const listAccountsOverviewProjection = vi.fn(async () => [{ id: "acc-1" }]);
const listPendingAccountDocumentsProjection = vi.fn(async () => []);
vi.mock("@/modules/accounts/server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAccountsOverviewProjection: () => listAccountsOverviewProjection(),
  listPendingAccountDocumentsProjection: () => listPendingAccountDocumentsProjection(),
}));

const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const getDocumentDetailProjection = vi.fn();
vi.mock("@/modules/documents/server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDocumentDetailProjection: (...args: unknown[]) => getDocumentDetailProjection(...args),
}));
const getDocumentPaymentSectionProjection = vi.fn();
const getSettlementReportProjection = vi.fn();
vi.mock("@/modules/payments/server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDocumentPaymentSectionProjection: (...args: unknown[]) => getDocumentPaymentSectionProjection(...args),
  getSettlementReportProjection: (...args: unknown[]) => getSettlementReportProjection(...args),
}));
vi.mock("@/modules/mail-intake/server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEmailSourceForDocumentProjection: async () => null,
}));

import { PERMISSIONS } from "@/platform/access";

import { executeTool } from "../server/execute-tool";
import { findMcpTool, MCP_TOOLS } from "../server/tool-registry";

const CALLER = { user: { id: "u-token", email: "token@example.test" }, clientId: "client-1", scopes: ["digipost"], expiresAt: undefined };

const ADMIN_WS = { membershipId: "m1", role: "admin" as const, workspace: { id: "11111111-1111-4111-8111-111111111111", name: "Admin GmbH", tier: "free", createdAt: new Date(0) } };
const MEMBER_WS = { membershipId: "m2", role: "member" as const, workspace: { id: "22222222-2222-4222-8222-222222222222", name: "Member GmbH", tier: "free", createdAt: new Date(1) } };
const FOREIGN_WORKSPACE_ID = "99999999-9999-4999-8999-999999999999";

function tool(name: string) {
  const found = findMcpTool(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

beforeEach(() => {
  listMembershipsForUser.mockReset();
  deleteDocument.mockReset();
  logAuditEvent.mockReset();
  listAccountsOverviewProjection.mockClear();
  getDocumentDetailProjection.mockReset();
  getDocumentPaymentSectionProjection.mockReset();
  getSettlementReportProjection.mockReset();
});

/** The dashboard's own permission for every capability the MCP server exposes. A new tool must
 * be added here on purpose, and a changed permission shows up as a failing diff. */
const EXPECTED_PERMISSIONS: Record<string, string | null> = {
  list_workspaces: null,
  get_overview: PERMISSIONS.documentsRead,
  get_company_profile: PERMISSIONS.companyProfileManage,
  update_company_profile: PERMISSIONS.companyProfileManage,
  search_documents: PERMISSIONS.documentsRead,
  get_document: PERMISSIONS.documentsRead,
  get_document_download_url: PERMISSIONS.documentsRead,
  delete_document: PERMISSIONS.documentsWrite,
  retry_document_processing: PERMISSIONS.documentsWrite,
  change_document_kind: PERMISSIONS.documentsWrite,
  confirm_intake: PERMISSIONS.documentsWrite,
  reject_intake: PERMISSIONS.documentsWrite,
  list_intake_sources: PERMISSIONS.intakeManage,
  reset_intake_source: PERMISSIONS.intakeManage,
  search_contacts: PERMISSIONS.documentsRead,
  get_contact: PERMISSIONS.documentsRead,
  create_contact: PERMISSIONS.documentsWrite,
  update_contact: PERMISSIONS.documentsWrite,
  verify_contact: PERMISSIONS.documentsWrite,
  delete_contact: PERMISSIONS.documentsWrite,
  merge_contacts: PERMISSIONS.documentsWrite,
  list_contact_proposals: PERMISSIONS.documentsRead,
  accept_contact_proposal: PERMISSIONS.documentsWrite,
  reject_contact_proposal: PERMISSIONS.documentsWrite,
  unlink_document_from_contact: PERMISSIONS.documentsWrite,
  mark_contact_as_own_company: PERMISSIONS.companyProfileManage,
  mark_contact_as_own_bank: PERMISSIONS.companyProfileManage,
  list_accounts: PERMISSIONS.financeRead,
  list_transactions: PERMISSIONS.financeRead,
  create_account: PERMISSIONS.financeManage,
  update_account: PERMISSIONS.financeManage,
  create_contact_clearing_account: PERMISSIONS.financeManage,
  import_statement: PERMISSIONS.financeManage,
  list_unmatched_transactions: PERMISSIONS.financeRead,
  list_open_items: PERMISSIONS.financeRead,
  confirm_payment_suggestion: PERMISSIONS.financeManage,
  reject_payment_suggestion: PERMISSIONS.financeManage,
  unlink_payment: PERMISSIONS.financeManage,
  link_payment: PERMISSIONS.financeManage,
  mark_transactions_no_document_needed: PERMISSIONS.financeManage,
  mark_document_settled_without_payment: PERMISSIONS.documentsWrite,
  set_payment_auto_confirm_mode: PERMISSIONS.financeManage,
  delete_payment_alias: PERMISSIONS.financeManage,
  get_closing_report: PERMISSIONS.financeRead,
};

describe("the MCP tool registry", () => {
  it("requires exactly the dashboard's permission for every tool", () => {
    const actual = Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t.scope === "workspace" ? t.permission : null]));
    expect(actual).toEqual(EXPECTED_PERMISSIONS);
  });

  it("offers none of the excluded capabilities (workspace deletion, members, billing, mail intake, upload)", () => {
    const names = MCP_TOOLS.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/workspace_delete|delete_workspace|invite|member|role|tier|package|billing|mail_intake|email_intake|sender|upload/);
  });

  it("marks every destructive tool as such and says it cannot be undone", () => {
    for (const t of MCP_TOOLS.filter((candidate) => candidate.effect === "destructive")) {
      expect(t.description, t.name).toMatch(/cannot be undone|CANNOT be undone|deleted automatically|Cannot be undone|cannot be restored|CANNOT be restored|becomes open again/i);
    }
  });
});

describe("executeTool permission enforcement", () => {
  it("refuses a finance tool to a member without running it", async () => {
    listMembershipsForUser.mockResolvedValue([MEMBER_WS]);

    const outcome = await executeTool(tool("list_accounts"), {}, CALLER);

    expect(outcome).toEqual({ ok: false, errorCode: "forbidden", details: { requiredPermission: PERMISSIONS.financeRead } });
    expect(listAccountsOverviewProjection).not.toHaveBeenCalled();
  });

  it("runs a finance tool for an admin", async () => {
    listMembershipsForUser.mockResolvedValue([ADMIN_WS]);

    const outcome = await executeTool(tool("list_accounts"), {}, CALLER);

    expect(outcome).toMatchObject({ ok: true, data: { accounts: [{ id: "acc-1" }] } });
  });

  it("uses the role of the workspace the call names, not the default one", async () => {
    listMembershipsForUser.mockResolvedValue([ADMIN_WS, MEMBER_WS]);

    await expect(executeTool(tool("list_accounts"), {}, CALLER)).resolves.toMatchObject({ ok: true });
    await expect(executeTool(tool("list_accounts"), { workspaceId: MEMBER_WS.workspace.id }, CALLER)).resolves.toMatchObject({
      ok: false,
      errorCode: "forbidden",
    });
  });

  it("denies a workspaceId that is not one of the caller's memberships", async () => {
    listMembershipsForUser.mockResolvedValue([ADMIN_WS]);

    const outcome = await executeTool(tool("list_accounts"), { workspaceId: FOREIGN_WORKSPACE_ID }, CALLER);

    expect(outcome).toEqual({ ok: false, errorCode: "workspace_not_found" });
    expect(listAccountsOverviewProjection).not.toHaveBeenCalled();
  });

  it("answers no_workspace for a user without any membership", async () => {
    listMembershipsForUser.mockResolvedValue([]);

    await expect(executeTool(tool("search_documents"), {}, CALLER)).resolves.toEqual({ ok: false, errorCode: "no_workspace" });
  });

  it("runs a write tool's own Server Action scoped to the delegated user's workspace", async () => {
    listMembershipsForUser.mockResolvedValue([ADMIN_WS, MEMBER_WS]);

    const outcome = await executeTool(tool("delete_document"), { documentId: DOCUMENT_ID, workspaceId: MEMBER_WS.workspace.id }, CALLER);

    expect(outcome).toEqual({ ok: true, data: { deleted: true } });
    // The action resolved the token's user and the NAMED workspace itself (members may delete).
    expect(deleteDocument).toHaveBeenCalledWith({ workspaceId: MEMBER_WS.workspace.id, documentId: DOCUMENT_ID });
  });

  it("writes one audit line with identifiers and the outcome, never the input", async () => {
    listMembershipsForUser.mockResolvedValue([MEMBER_WS]);

    await executeTool(tool("list_accounts"), { workspaceId: MEMBER_WS.workspace.id }, CALLER);

    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith(
      "mcp.tool_call",
      expect.objectContaining({
        tool: "list_accounts",
        userId: CALLER.user.id,
        clientId: CALLER.clientId,
        workspaceId: MEMBER_WS.workspace.id,
        outcome: "error",
        errorCode: "forbidden",
      }),
    );
  });
});

describe("get_document finance redaction", () => {
  const DOCUMENT = {
    id: DOCUMENT_ID,
    kind: "payout_report",
    intakeStatus: "confirmed",
    paymentStatus: "open",
    uploadedByEmail: "someone@example.test",
    ocrText: "Rechnung Nr. 1",
    intakeResult: null,
  };

  it("asks the payment read model to redact for a member and never loads the settlement report", async () => {
    listMembershipsForUser.mockResolvedValue([MEMBER_WS]);
    getDocumentDetailProjection.mockResolvedValue(DOCUMENT);
    getDocumentPaymentSectionProjection.mockResolvedValue({ paymentStatus: "open", matchedTransactions: [], suggestions: [] });

    const outcome = await executeTool(tool("get_document"), { documentId: DOCUMENT_ID, include: [], ocrOffset: 0, ocrMaxChars: 100 }, CALLER);

    expect(outcome.ok).toBe(true);
    expect(getDocumentPaymentSectionProjection).toHaveBeenCalledWith(MEMBER_WS.workspace.id, DOCUMENT_ID, false);
    expect(getSettlementReportProjection).not.toHaveBeenCalled();
  });

  it("reveals finance details to an admin", async () => {
    listMembershipsForUser.mockResolvedValue([ADMIN_WS]);
    getDocumentDetailProjection.mockResolvedValue(DOCUMENT);
    getDocumentPaymentSectionProjection.mockResolvedValue(null);
    getSettlementReportProjection.mockResolvedValue({ documentId: DOCUMENT_ID });

    const outcome = await executeTool(tool("get_document"), { documentId: DOCUMENT_ID, include: [], ocrOffset: 0, ocrMaxChars: 100 }, CALLER);

    expect(outcome).toMatchObject({ ok: true, data: { settlementReport: { documentId: DOCUMENT_ID } } });
    expect(getDocumentPaymentSectionProjection).toHaveBeenCalledWith(ADMIN_WS.workspace.id, DOCUMENT_ID, true);
  });

  it("reads the document only from the resolved workspace and answers not_found otherwise", async () => {
    listMembershipsForUser.mockResolvedValue([ADMIN_WS]);
    getDocumentDetailProjection.mockResolvedValue(null);

    const outcome = await executeTool(tool("get_document"), { documentId: DOCUMENT_ID, include: [], ocrOffset: 0, ocrMaxChars: 100 }, CALLER);

    expect(outcome).toEqual({ ok: false, errorCode: "not_found" });
    expect(getDocumentDetailProjection).toHaveBeenCalledWith(ADMIN_WS.workspace.id, DOCUMENT_ID);
  });

  it("returns the OCR text only on request, paged", async () => {
    listMembershipsForUser.mockResolvedValue([MEMBER_WS]);
    getDocumentDetailProjection.mockResolvedValue({ ...DOCUMENT, kind: "letter", paymentStatus: "not_applicable" });

    const without = await executeTool(tool("get_document"), { documentId: DOCUMENT_ID, include: [], ocrOffset: 0, ocrMaxChars: 100 }, CALLER);
    const withText = await executeTool(tool("get_document"), { documentId: DOCUMENT_ID, include: ["ocrText"], ocrOffset: 9, ocrMaxChars: 3 }, CALLER);

    expect(without).toMatchObject({ ok: true, data: { document: { ocrTextLength: 14 } } });
    expect(JSON.stringify(without)).not.toContain("Rechnung");
    expect(withText).toMatchObject({ ok: true, data: { document: { ocrText: "Nr.", ocrTextOffset: 9, ocrTextTruncated: true } } });
  });
});
