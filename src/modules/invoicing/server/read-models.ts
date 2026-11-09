import "server-only";

import { cache } from "react";

import { getRequestServices } from "@/persistence/composition/request-services";
import type { InvoiceDraftCheck } from "@/persistence/use-cases/invoices-use-cases";

import type {
  InvoiceContactOption,
  InvoiceDraftListItem,
  InvoiceDraftView,
  InvoiceSellerSummary,
  IssuedInvoiceListItem,
  IssuedInvoiceView,
} from "../core/types";

// Projections for `/dashboard/invoices/**` (decisions/0079-outgoing-invoices.md). `workspaceId`
// is always the caller's own resolved membership, never client input.

export const listInvoicesProjection = cache(async (workspaceId: string): Promise<IssuedInvoiceListItem[]> => {
  return getRequestServices().invoices.listInvoices(workspaceId);
});

export const listInvoiceDraftsProjection = cache(async (workspaceId: string): Promise<InvoiceDraftListItem[]> => {
  return getRequestServices().invoices.listDrafts(workspaceId);
});

export const getInvoiceDraftProjection = cache(async (workspaceId: string, draftId: string): Promise<InvoiceDraftView | null> => {
  return getRequestServices().invoices.getDraft(workspaceId, draftId);
});

export const getInvoiceDraftCheckProjection = cache(async (workspaceId: string, draftId: string): Promise<InvoiceDraftCheck> => {
  return getRequestServices().invoices.checkDraft(workspaceId, draftId);
});

export const getInvoiceEditorContextProjection = cache(
  async (workspaceId: string): Promise<{ seller: InvoiceSellerSummary; contacts: InvoiceContactOption[] }> => {
    return getRequestServices().invoices.getEditorContext(workspaceId);
  },
);

export const getInvoiceProjection = cache(async (workspaceId: string, invoiceId: string): Promise<IssuedInvoiceView | null> => {
  return getRequestServices().invoices.getInvoice(workspaceId, invoiceId);
});

/** The workspace deletion's danger zone: how many invoices the admin must confirm they kept. */
export const countIssuedInvoicesProjection = cache(async (workspaceId: string): Promise<number> => {
  return getRequestServices().invoices.countIssued(workspaceId);
});
