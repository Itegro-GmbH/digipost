/**
 * `GET /api/invoices/drafts/[id]/preview` (decisions/0079-outgoing-invoices.md): the draft
 * rendered as it would be issued today, with an "ENTWURF" watermark in place of a number.
 * Nothing is stored and no number is taken. Answers `422 { errorCode: "invoice_invalid" }`
 * while the draft cannot be rendered yet (the editor shows why through "Prüfen").
 */
import { PERMISSIONS } from "@/platform/access";
import { workspaceAccess, WorkspaceAccessError } from "@/platform/access/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { INVOICE_ERROR } from "@/persistence/use-cases/invoices-use-cases";

export const dynamic = "force-dynamic";
// The first render in a fresh function loads the Schematron rule sets (a few seconds).
export const maxDuration = 30;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function GET(_request: Request, context: RouteContext<"/api/invoices/drafts/[id]/preview">): Promise<Response> {
  const { id } = await context.params;

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

  if (!UUID_RE.test(id)) return new Response(null, { status: 404 });

  try {
    const pdf = await getRequestServices().invoices.renderDraftPreview(workspaceId, id);
    return new Response(new Blob([pdf as BlobPart]), {
      status: 200,
      headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="Entwurf.pdf"', "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    if (err instanceof UseCaseError && err.code === INVOICE_ERROR.notFound) return new Response(null, { status: 404 });
    if (err instanceof UseCaseError && err.code === INVOICE_ERROR.invoiceInvalid) return Response.json({ errorCode: err.code }, { status: 422 });
    console.error("[invoicing] draft preview failed", err instanceof Error ? err.name : "unknown");
    return Response.json({ errorCode: "unknown" }, { status: 500 });
  }
}
