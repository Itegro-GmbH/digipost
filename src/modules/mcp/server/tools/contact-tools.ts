// Owner: src/modules/mcp (decisions/0078-mcp-server.md). Contact tools ("Firmenkontakte"): search,
// detail, create/edit/verify, merge/delete, change proposals, document links, and the two
// "Das sind wir" / "Das ist unsere Bank" corrections. Same permission tiers as the dashboard
// (decisions/0019-contacts.md, decisions/0027-hardening-and-deletion.md): everything behind
// `documents.write` except the two corrections (`company_profile.manage`); reads behind
// `documents.read`, finance parts of a contact (learned payment names, clearing account) only
// with `finance.read`.
import "server-only";

import { z } from "zod";

import { getContactClearingAccountProjection } from "@/modules/accounts/server";
import { CONTACT_RELATION_TYPES, DOCUMENT_CONTACT_ROLES, manualContactCreateSchema, updateContactInputSchema } from "@/modules/contacts";
import {
  acceptProposalAction,
  createContactAction,
  deleteContactAction,
  markContactAsOwnBankAction,
  markContactAsOwnCompanyAction,
  mergeContactsAction,
  rejectProposalAction,
  unlinkDocumentAction,
  updateContactAction,
  verifyContactAction,
} from "@/modules/contacts/actions";
import { getContactDetailProjection, listContactSummariesProjection, listPendingProposalsSummaryProjection } from "@/modules/contacts/server";
import { listContactPaymentAliasesProjection } from "@/modules/payments/server";
import { PERMISSIONS } from "@/platform/access";

import { defineWorkspaceTool, fail, fromActionResult, MCP_ERROR, ok } from "../../core/tool-kit";

export const searchContactsTool = defineWorkspaceTool({
  name: "search_contacts",
  title: "Search contacts",
  description:
    "Searches the workspace's company contacts ('Firmenkontakte': suppliers, customers, authorities, banks) by name " +
    "or other fields. Returns compact rows; use get_contact for linked documents and pending change proposals.",
  input: z.object({
    q: z.string().trim().max(200).optional(),
    relationType: z.enum(CONTACT_RELATION_TYPES).optional(),
    onlyUnverified: z.boolean().optional().describe("Only contacts nobody has confirmed yet"),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(30),
  }),
  permission: PERMISSIONS.documentsRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    return ok(
      await listContactSummariesProjection(ctx.workspace.id, {
        q: input.q || undefined,
        relationType: input.relationType,
        onlyUnverified: input.onlyUnverified,
        page: input.page,
        pageSize: input.pageSize,
      }),
    );
  },
});

export const getContactTool = defineWorkspaceTool({
  name: "get_contact",
  title: "Get contact",
  description:
    "One contact with every field, its verification state, linked documents and pending change proposals. Admins " +
    "(finance.read) also get the payment names learned from bank transactions and the contact's clearing account.",
  input: z.object({ contactId: z.uuid() }),
  permission: PERMISSIONS.documentsRead,
  effect: "read",
  idempotent: true,
  async run(input, ctx) {
    const contact = await getContactDetailProjection(ctx.workspace.id, input.contactId);
    if (!contact) return fail(MCP_ERROR.notFound);
    if (!ctx.permissions.includes(PERMISSIONS.financeRead)) return ok({ contact });
    const [paymentAliases, clearingAccount] = await Promise.all([
      listContactPaymentAliasesProjection(ctx.workspace.id, input.contactId),
      getContactClearingAccountProjection(ctx.workspace.id, input.contactId),
    ]);
    return ok({ contact, paymentAliases, clearingAccount });
  },
});

export const createContactTool = defineWorkspaceTool({
  name: "create_contact",
  title: "Create contact",
  description: "Creates a contact by hand. Only name is required. A manually created contact counts as verified.",
  input: manualContactCreateSchema,
  permission: PERMISSIONS.documentsWrite,
  effect: "write",
  async run(input) {
    return fromActionResult(await createContactAction(input));
  },
});

export const updateContactTool = defineWorkspaceTool({
  name: "update_contact",
  title: "Update contact",
  description:
    "Replaces every editable field of a contact (FULL replace: omitted fields are cleared) and marks it verified. " +
    "Call get_contact first and send back every field you want to keep.",
  input: updateContactInputSchema,
  permission: PERMISSIONS.documentsWrite,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await updateContactAction(input));
  },
});

export const verifyContactTool = defineWorkspaceTool({
  name: "verify_contact",
  title: "Verify contact",
  description: "Marks a contact as checked by a human ('Bestätigen') without changing any field.",
  input: z.object({ contactId: z.uuid() }),
  permission: PERMISSIONS.documentsWrite,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await verifyContactAction(input));
  },
});

export const deleteContactTool = defineWorkspaceTool({
  name: "delete_contact",
  title: "Delete contact",
  description:
    "Permanently deletes a contact and its document links (the documents themselves stay). This CANNOT be undone. " +
    "Confirm with the user first. To combine duplicates, prefer merge_contacts.",
  input: z.object({ contactId: z.uuid() }),
  permission: PERMISSIONS.documentsWrite,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await deleteContactAction(input), { deleted: true });
  },
});

export const mergeContactsTool = defineWorkspaceTool({
  name: "merge_contacts",
  title: "Merge contacts",
  description:
    "Merges the source contact into the target ('Zusammenführen'): moves every document link and proposal to the " +
    "target, fills the target's empty fields from the source, then deletes the source. The source CANNOT be restored. " +
    "Confirm with the user first.",
  input: z.object({
    sourceId: z.uuid().describe("Contact that disappears"),
    targetId: z.uuid().describe("Contact that remains"),
  }),
  permission: PERMISSIONS.documentsWrite,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await mergeContactsAction(input));
  },
});

export const listContactProposalsTool = defineWorkspaceTool({
  name: "list_contact_proposals",
  title: "List contact change proposals",
  description:
    "Every pending change proposal in the workspace: a newer document carries a different value for an already " +
    "verified contact field (e.g. a new IBAN). Proposals never apply themselves; accept or reject each one.",
  input: z.object({}),
  permission: PERMISSIONS.documentsRead,
  effect: "read",
  idempotent: true,
  async run(_input, ctx) {
    return ok({ proposals: await listPendingProposalsSummaryProjection(ctx.workspace.id) });
  },
});

export const acceptContactProposalTool = defineWorkspaceTool({
  name: "accept_contact_proposal",
  title: "Accept contact proposal",
  description:
    "Applies a pending change proposal to its contact and marks the contact verified. A changed IBAN is a classic " +
    "invoice-fraud pattern: confirm with the user before accepting one.",
  input: z.object({ proposalId: z.uuid() }),
  permission: PERMISSIONS.documentsWrite,
  effect: "write",
  async run(input) {
    return fromActionResult(await acceptProposalAction(input), { accepted: true });
  },
});

export const rejectContactProposalTool = defineWorkspaceTool({
  name: "reject_contact_proposal",
  title: "Reject contact proposal",
  description: "Rejects a pending change proposal; the contact stays unchanged.",
  input: z.object({ proposalId: z.uuid() }),
  permission: PERMISSIONS.documentsWrite,
  effect: "write",
  async run(input) {
    return fromActionResult(await rejectProposalAction(input), { rejected: true });
  },
});

export const unlinkDocumentFromContactTool = defineWorkspaceTool({
  name: "unlink_document_from_contact",
  title: "Unlink document from contact",
  description: "Removes one link between a document and a contact in the given role. Neither the document nor the contact is deleted.",
  input: z.object({ documentId: z.uuid(), contactId: z.uuid(), role: z.enum(DOCUMENT_CONTACT_ROLES) }),
  permission: PERMISSIONS.documentsWrite,
  effect: "write",
  async run(input) {
    return fromActionResult(await unlinkDocumentAction(input), { unlinked: true });
  },
});

export const markContactAsOwnCompanyTool = defineWorkspaceTool({
  name: "mark_contact_as_own_company",
  title: "This contact is us",
  description:
    "'Das sind wir': the contact is really the workspace's own company under another name. Adds its name to the " +
    "company profile's aliases, then DELETES the contact (cannot be undone). Admin only.",
  input: z.object({ contactId: z.uuid() }),
  permission: PERMISSIONS.companyProfileManage,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await markContactAsOwnCompanyAction(input), { done: true });
  },
});

export const markContactAsOwnBankTool = defineWorkspaceTool({
  name: "mark_contact_as_own_bank",
  title: "This contact is our bank",
  description:
    "'Das ist unsere Bank': the contact's IBAN is the workspace's own. Adds the IBAN to the company profile, then " +
    "DELETES the contact (cannot be undone). Fails with contact_missing_iban if it has no valid IBAN. Admin only.",
  input: z.object({ contactId: z.uuid() }),
  permission: PERMISSIONS.companyProfileManage,
  effect: "destructive",
  async run(input) {
    return fromActionResult(await markContactAsOwnBankAction(input), { done: true });
  },
});

export const CONTACT_TOOLS = [
  searchContactsTool,
  getContactTool,
  createContactTool,
  updateContactTool,
  verifyContactTool,
  deleteContactTool,
  mergeContactsTool,
  listContactProposalsTool,
  acceptContactProposalTool,
  rejectContactProposalTool,
  unlinkDocumentFromContactTool,
  markContactAsOwnCompanyTool,
  markContactAsOwnBankTool,
];
