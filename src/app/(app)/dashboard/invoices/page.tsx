import { notFound } from "next/navigation";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { getInvoiceEditorContextProjection, listInvoiceDraftsProjection, listInvoicesProjection } from "@/modules/invoicing/server";
import { InvoicesPageClient } from "@/modules/invoicing/client";

/** "Rechnungen" (decisions/0079-outgoing-invoices.md): every member writes invoices. The
 * workspace is always the caller's resolved membership, never client input. */
export default async function InvoicesPage() {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.invoicesManage)) notFound();

  const [drafts, invoices, context] = await Promise.all([
    listInvoiceDraftsProjection(access.workspace.id),
    listInvoicesProjection(access.workspace.id),
    getInvoiceEditorContextProjection(access.workspace.id),
  ]);

  return (
    <InvoicesPageClient
      drafts={drafts}
      invoices={invoices}
      sellerMissing={context.seller.missing}
      canEditCompanyProfile={access.permissions.includes(PERMISSIONS.companyProfileManage)}
    />
  );
}
