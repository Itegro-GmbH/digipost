// Owner: src/modules/mcp (decisions/0078-mcp-server.md). Tools about the caller's workspaces, the
// "Start" work list and the company profile ("Firmendaten"). Excluded on purpose (user decision 2):
// workspace deletion, member management, billing, E-Mail-Eingang settings.
import "server-only";

import { z } from "zod";

import { countFailedProjection, countOverduePaymentsProjection, countPendingIntakeConfirmationProjection } from "@/modules/documents/server";
import { countOpenSuggestionsProjection, countUnmatchedTransactionsProjection } from "@/modules/payments/server";
import { updateCompanyProfileAction } from "@/modules/workspaces/actions";
import { getCompanyProfileProjection } from "@/modules/workspaces/server";
import { PERMISSIONS, permissionsForRole } from "@/platform/access";
import { getRequestServices } from "@/persistence/composition/request-services";

import { defineUserTool, defineWorkspaceTool, fromActionResult, ok } from "../../core/tool-kit";

export const listWorkspacesTool = defineUserTool({
  name: "list_workspaces",
  title: "List workspaces",
  description:
    "Lists every Digipost workspace (company) you are a member of, with your role and permissions in each. " +
    "Every other tool acts in your default workspace unless you pass one of these ids as workspaceId. " +
    "The first entry (isDefault: true) is the default.",
  input: z.object({}),
  effect: "read",
  idempotent: true,
  async run(_input, ctx) {
    const memberships = await getRequestServices().workspaces.listMembershipsForUser(ctx.userId);
    return ok({
      workspaces: memberships.map((m, index) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        role: m.role,
        permissions: permissionsForRole(m.role),
        isDefault: index === 0,
      })),
    });
  },
});

export const getOverviewTool = defineWorkspaceTool({
  name: "get_overview",
  title: "Work list overview",
  description:
    "The 'Start' work list of a workspace: how many documents wait for intake confirmation, failed processing, " +
    "or are overdue; for admins also unmatched bank transactions and open payment suggestions. " +
    "Use it first to see what needs attention, then search_documents / list_unmatched_transactions.",
  input: z.object({}),
  permission: PERMISSIONS.documentsRead,
  effect: "read",
  idempotent: true,
  async run(_input, ctx) {
    const workspaceId = ctx.workspace.id;
    const canReadFinance = ctx.permissions.includes(PERMISSIONS.financeRead);
    const [pendingConfirmation, failedProcessing, overduePayments, finance] = await Promise.all([
      countPendingIntakeConfirmationProjection(workspaceId),
      countFailedProjection(workspaceId),
      countOverduePaymentsProjection(workspaceId),
      canReadFinance ? Promise.all([countUnmatchedTransactionsProjection(workspaceId), countOpenSuggestionsProjection(workspaceId)]) : Promise.resolve(null),
    ]);
    return ok({
      workspace: ctx.workspace,
      role: ctx.role,
      documentsPendingConfirmation: pendingConfirmation,
      documentsFailedProcessing: failedProcessing,
      documentsOverdue: overduePayments,
      ...(finance ? { unmatchedTransactions: finance[0], openPaymentSuggestions: finance[1] } : {}),
    });
  },
});

export const getCompanyProfileTool = defineWorkspaceTool({
  name: "get_company_profile",
  title: "Get company profile",
  description:
    "The workspace's own company profile ('Firmendaten'): address, VAT id, tax/register data, aliases, own IBANs and " +
    "domains. Digipost uses it to recognize which party on a document is the workspace itself. Admin only.",
  input: z.object({}),
  permission: PERMISSIONS.companyProfileManage,
  effect: "read",
  idempotent: true,
  async run(_input, ctx) {
    return ok({ profile: await getCompanyProfileProjection(ctx.workspace.id) });
  },
});

const optionalText = (max: number) => z.string().max(max).optional();
const textList = (max: number) => z.array(z.string().max(max)).max(20).optional();

export const updateCompanyProfileTool = defineWorkspaceTool({
  name: "update_company_profile",
  title: "Update company profile",
  description:
    "Replaces the workspace's company profile. This is a FULL replace: every field you omit is cleared. " +
    "Call get_company_profile first and send back every field you want to keep. Admin only.",
  input: z.object({
    addressLine1: z.string().min(1).max(200),
    addressLine2: optionalText(200),
    postalCode: z.string().min(1).max(20),
    city: z.string().min(1).max(120),
    country: optionalText(2).describe("ISO 3166-1 alpha-2, e.g. DE"),
    vatId: optionalText(20),
    aliases: textList(120).describe("Other names the company appears under (brands, short forms)"),
    ibans: textList(34).describe("The company's own IBANs"),
    domains: textList(253).describe("The company's own e-mail/web domains"),
    taxNumber: optionalText(30),
    registerCourt: optionalText(120),
    registerNumber: optionalText(30),
    profileText: optionalText(1000).describe("Free text describing what the company does"),
  }),
  permission: PERMISSIONS.companyProfileManage,
  effect: "write",
  idempotent: true,
  async run(input) {
    return fromActionResult(await updateCompanyProfileAction(input));
  },
});

export const WORKSPACE_TOOLS = [listWorkspacesTool, getOverviewTool, getCompanyProfileTool, updateCompanyProfileTool];
