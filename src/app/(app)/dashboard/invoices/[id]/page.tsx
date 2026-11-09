import { notFound } from "next/navigation";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { getInvoiceProjection } from "@/modules/invoicing/server";
import { InvoiceDetailClient } from "@/modules/invoicing/client";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** An issued invoice or cancellation (decisions/0079-outgoing-invoices.md), read-only. */
export default async function InvoicePage({ params }: PageProps<"/dashboard/invoices/[id]">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.invoicesManage)) notFound();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const invoice = await getInvoiceProjection(access.workspace.id, id);
  if (!invoice) notFound();

  return <InvoiceDetailClient invoice={invoice} />;
}
