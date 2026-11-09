/**
 * `GET /api/invoices/[id]/file?format=pdf|xml` (decisions/0079-outgoing-invoices.md): an issued
 * invoice's archived ZUGFeRD PDF (default) or its CII XML. Workspace-scoped: an id from another
 * workspace 404s, never leaking whether it exists. `?download=1` asks for
 * `Content-Disposition: attachment` instead of `inline` (the detail page embeds the PDF).
 *
 * Bypasses `src/platform/api-pipeline` deliberately, exactly like
 * `src/app/api/documents/[id]/file/route.ts`: the contract is a binary stream.
 */
import { contentDispositionHeader } from "@/modules/documents/server";
import { PERMISSIONS } from "@/platform/access";
import { workspaceAccess, WorkspaceAccessError } from "@/platform/access/server";
import { getRequestServices } from "@/persistence/composition/request-services";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function GET(request: Request, context: RouteContext<"/api/invoices/[id]/file">): Promise<Response> {
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
  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "xml" ? "xml" : "pdf";

  const file = await getRequestServices().invoices.getInvoiceFile(workspaceId, id, format);
  if (!file) return new Response(null, { status: 404 });

  const download = params.get("download") === "1";
  return new Response(new Blob([file.bytes as BlobPart]), {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": contentDispositionHeader(download ? "attachment" : "inline", file.fileName),
      "Cache-Control": "private, no-store",
    },
  });
}
