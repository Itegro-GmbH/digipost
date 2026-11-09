import { notFound } from "next/navigation";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { getInvoiceDraftCheckProjection, getInvoiceDraftProjection, getInvoiceEditorContextProjection } from "@/modules/invoicing/server";
import { InvoiceDraftEditor } from "@/modules/invoicing/client";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A draft's editor (decisions/0079-outgoing-invoices.md). A draft id from another workspace is
 * looked up in the caller's own workspace and therefore 404s like an unknown one. */
export default async function InvoiceDraftPage({ params }: PageProps<"/dashboard/invoices/drafts/[id]">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.invoicesManage)) notFound();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const draft = await getInvoiceDraftProjection(access.workspace.id, id);
  if (!draft) notFound();
  const [check, context] = await Promise.all([getInvoiceDraftCheckProjection(access.workspace.id, id), getInvoiceEditorContextProjection(access.workspace.id)]);

  return (
    <InvoiceDraftEditor
      draftId={draft.id}
      initialContent={draft.content}
      initialCheck={{ violations: check.violations, totals: check.totals }}
      seller={context.seller}
      contacts={context.contacts}
      canEditCompanyProfile={access.permissions.includes(PERMISSIONS.companyProfileManage)}
    />
  );
}
