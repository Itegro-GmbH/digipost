/**
 * `GET /api/invoices/export` (decisions/0079-outgoing-invoices.md): every issued invoice of the
 * caller's workspace, PDF and XML, as one streamed ZIP (`rechnungen/Rechnung-2026-0001.pdf`,
 * ...). Offered on the invoice list and in the workspace deletion's danger zone, where the
 * admin confirms they downloaded it. Workspace-scoped from the resolved session.
 */
import { createInvoiceArchive, invoiceArchiveFileName } from "@/modules/invoicing/server";
import { PERMISSIONS } from "@/platform/access";
import { workspaceAccess, WorkspaceAccessError } from "@/platform/access/server";

export const dynamic = "force-dynamic";
// Dominated by object-storage round trips, one file at a time; the same ceiling as the
// Abschluss export.
export const maxDuration = 60;

export async function GET(): Promise<Response> {
  let workspaceId: string;
  try {
    const access = await workspaceAccess(PERMISSIONS.invoicesManage);
    workspaceId = access.workspace.id;
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      return Response.json({ errorCode: err.code }, { status: err.code === "unauthenticated" ? 401 : 403 });
    }
    return Response.json({ errorCode: "unknown" }, { status: 500 });
  }

  return new Response(createInvoiceArchive(workspaceId), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${invoiceArchiveFileName(new Date())}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
