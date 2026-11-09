"use server";

// The invoicing actions (decisions/0079-outgoing-invoices.md). Every member may write invoices
// (user decision): each action needs `invoices.manage`, which both roles have, and acts on the
// caller's own resolved workspace, never on a workspace id from the client. Ids of drafts and
// invoices from the client are only ever looked up within that workspace.
import { revalidatePath } from "next/cache";

import { PERMISSIONS } from "@/platform/access";
import { requirePermission } from "@/platform/access/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { DOCUMENT_ERROR } from "@/persistence/use-cases/documents-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { INVOICE_ERROR, InvoiceInvalidError, type InvoiceDraftCheck } from "@/persistence/use-cases/invoices-use-cases";
import type { ActionResult } from "@/shared/action-result";

import type { InvoiceActionErrorCode } from "./core/error-codes";
import { draftIdInputSchema, invoiceIdInputSchema, updateDraftInputSchema } from "./core/schemas";
import type { InvoiceViolation } from "./core/types";

const LIST_PATH = "/dashboard/invoices";

/** An error result, plus the violations when the draft is not a valid invoice yet. */
export type InvoiceActionResult<T> = ActionResult<T, InvoiceActionErrorCode> | { status: "invalid"; violations: InvoiceViolation[] };

function mapUseCaseError(err: unknown): InvoiceActionErrorCode {
  if (err instanceof UseCaseError) {
    const code = err.code;
    if (
      code === INVOICE_ERROR.notFound ||
      code === INVOICE_ERROR.companyProfileIncomplete ||
      code === INVOICE_ERROR.invoiceInvalid ||
      code === INVOICE_ERROR.alreadyCancelled ||
      code === INVOICE_ERROR.notCancellable ||
      code === DOCUMENT_ERROR.quotaTotalExceeded ||
      code === DOCUMENT_ERROR.quotaMonthlyExceeded
    ) {
      return code;
    }
  }
  console.error("[invoicing] action failed", err instanceof Error ? err.name : "unknown");
  return "unknown";
}

function fail<T>(err: unknown): InvoiceActionResult<T> {
  if (err instanceof InvoiceInvalidError) return { status: "invalid", violations: [...err.violations] };
  return { status: "error", errorCode: mapUseCaseError(err) };
}

/** "Neue Rechnung": an empty draft, prefilled with the workspace's first own IBAN. */
export async function createInvoiceDraftAction(): Promise<InvoiceActionResult<{ draftId: string }>> {
  const access = await requirePermission(PERMISSIONS.invoicesManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };
  try {
    const { id } = await getRequestServices().invoices.createDraft({ workspaceId: access.access.workspace.id, userId: access.access.user.id });
    revalidatePath(LIST_PATH);
    return { status: "success", data: { draftId: id } };
  } catch (err) {
    return fail(err);
  }
}

/** Saves the draft and answers with the result of "Prüfen" for what was saved. */
export async function saveInvoiceDraftAction(input: unknown): Promise<InvoiceActionResult<InvoiceDraftCheck>> {
  const parsed = updateDraftInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };
  const access = await requirePermission(PERMISSIONS.invoicesManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };
  const workspaceId = access.access.workspace.id;
  try {
    const services = getRequestServices();
    await services.invoices.updateDraft({ workspaceId, draftId: parsed.data.draftId, content: parsed.data.content });
    const check = await services.invoices.checkDraft(workspaceId, parsed.data.draftId);
    revalidatePath(LIST_PATH);
    return { status: "success", data: check };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteInvoiceDraftAction(input: unknown): Promise<InvoiceActionResult<undefined>> {
  const parsed = draftIdInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };
  const access = await requirePermission(PERMISSIONS.invoicesManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };
  try {
    await getRequestServices().invoices.deleteDraft(access.access.workspace.id, parsed.data.draftId);
    revalidatePath(LIST_PATH);
    return { status: "success", data: undefined };
  } catch (err) {
    return fail(err);
  }
}

/** "Festschreiben": the draft becomes a numbered invoice that can never be changed again. */
export async function finalizeInvoiceDraftAction(input: unknown): Promise<InvoiceActionResult<{ invoiceId: string }>> {
  const parsed = draftIdInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };
  const access = await requirePermission(PERMISSIONS.invoicesManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };
  try {
    const result = await getRequestServices().invoices.finalizeDraft({
      workspaceId: access.access.workspace.id,
      draftId: parsed.data.draftId,
      userId: access.access.user.id,
      userEmail: access.access.user.email,
    });
    revalidatePath(LIST_PATH);
    revalidatePath("/dashboard");
    return { status: "success", data: result };
  } catch (err) {
    return fail(err);
  }
}

/** "Stornieren": issues the full cancellation of an invoice as a new numbered invoice. */
export async function cancelInvoiceAction(input: unknown): Promise<InvoiceActionResult<{ invoiceId: string }>> {
  const parsed = invoiceIdInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };
  const access = await requirePermission(PERMISSIONS.invoicesManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };
  try {
    const result = await getRequestServices().invoices.cancelInvoice({
      workspaceId: access.access.workspace.id,
      invoiceId: parsed.data.invoiceId,
      userId: access.access.user.id,
      userEmail: access.access.user.email,
    });
    revalidatePath(LIST_PATH);
    revalidatePath(`${LIST_PATH}/${parsed.data.invoiceId}`);
    revalidatePath("/dashboard");
    return { status: "success", data: result };
  } catch (err) {
    return fail(err);
  }
}
