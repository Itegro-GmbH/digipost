// Owner: src/modules/ledger (decisions/0081-ledger-via-api.md, stage A). The `ledger` every entry
// point gets: per call, a workspace switched to the ledger API (`LEDGER_API_WORKSPACES`) is
// served by the API-backed use cases, every other workspace by the in-process ones. Every method
// takes the workspace first (as an id, or as `input.workspaceId`), which is what routes it. The
// API-backed implementation is built only when a switched workspace is first asked for, so with
// no workspace switched nothing about it is ever constructed and behavior is exactly the
// in-process ledger's.
import type { LedgerUseCases } from "@/persistence/use-cases/ledger-use-cases";

/** Every method of `LedgerUseCases`; the type check below fails when one is added and not listed. */
const LEDGER_USE_CASE_METHODS = [
  "getSettings",
  "isEnabled",
  "setSettings",
  "syncChart",
  "listAccounts",
  "createAccount",
  "updateAccount",
  "setAccountArchived",
  "listEntries",
  "getEntry",
  "countWaitingProposals",
  "getSources",
  "createEntry",
  "updateEntry",
  "deleteEntry",
  "bookEntry",
  "unbookEntry",
  "bulkBook",
  "dismissProposal",
  "restoreProposal",
  "upsertProposal",
  "listSourceKeys",
  "getBalances",
  "getAccountSheet",
  "getAccountSheets",
  "getBankComparisons",
  "getOpenItems",
  "listOpenItemAccounts",
  "getVatPreview",
  "getControls",
  "getPeriodOverview",
  "createMatch",
  "deleteMatch",
  "listRules",
  "createRule",
  "updateRule",
  "deleteRule",
  "listFilings",
  "createFiling",
  "submitFiling",
  "createCorrectionFiling",
  "createHandover",
  "listHandovers",
  "uploadAdvisorBalances",
  "listAdvisorUploads",
  "getAdvisorComparison",
  "deleteAdvisorUpload",
  "syncProposals",
  "scheduleSync",
  "autoMatchOpenItems",
  "suggestMatches",
  "learnRuleFromEntry",
] as const satisfies readonly (keyof LedgerUseCases)[];

type Unlisted = Exclude<keyof LedgerUseCases, (typeof LEDGER_USE_CASE_METHODS)[number]>;
const everyMethodListed: [Unlisted] extends [never] ? true : Unlisted = true;
void everyMethodListed;

export type LedgerRouterDeps = {
  local: LedgerUseCases;
  /** Built on first use, at most once per router. */
  api: () => LedgerUseCases;
  /** Whether this workspace's bookkeeping runs on the ledger API. */
  usesApi: (workspaceId: string) => boolean;
};

function workspaceOf(first: unknown): string {
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "workspaceId" in first && typeof first.workspaceId === "string") return first.workspaceId;
  throw new Error("ledger router: a ledger use case was called without a workspace");
}

export function createLedgerRouter(deps: LedgerRouterDeps): LedgerUseCases {
  let api: LedgerUseCases | undefined;
  const pick = (workspaceId: string): LedgerUseCases => (deps.usesApi(workspaceId) ? (api ??= deps.api()) : deps.local);

  const router: Record<string, (first: unknown, ...rest: unknown[]) => unknown> = {};
  for (const method of LEDGER_USE_CASE_METHODS) {
    router[method] = (first, ...rest) => {
      // Every method's signature starts with the workspace; the cast only forwards the same
      // arguments to the same method of the chosen implementation.
      const target = pick(workspaceOf(first))[method] as (...args: unknown[]) => unknown;
      return target(first, ...rest);
    };
  }
  return router as unknown as LedgerUseCases;
}
