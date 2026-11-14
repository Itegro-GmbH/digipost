// Composition-root entry point (decisions/0081-ledger-via-api.md): the only reader of
// `LEDGER_API_URL`, `LEDGER_API_KEY` and `LEDGER_API_WORKSPACES`. `usesLedgerApi` decides per
// workspace whether its bookkeeping runs on the API; with `LEDGER_API_WORKSPACES` unset it is
// `false` for every workspace and nothing here is ever called.
import "server-only";

import { serverEnv } from "@/platform/env/server";

import type { LedgerApiClient } from "../core/ports";
import { parseLedgerApiWorkspaces } from "../core/workspaces";
import { createLedgerApiClient, createNotConfiguredLedgerApiClient } from "./http-client";

declare global {
  var __ledgerApiClient: LedgerApiClient | undefined;
}

/** The workspaces switched to the API, parsed from `LEDGER_API_WORKSPACES`. */
export function getLedgerApiWorkspaces(): ReadonlySet<string> {
  return parseLedgerApiWorkspaces(serverEnv().LEDGER_API_WORKSPACES);
}

export function usesLedgerApi(workspaceId: string): boolean {
  return getLedgerApiWorkspaces().has(workspaceId.toLowerCase());
}

function build(): LedgerApiClient {
  const env = serverEnv();
  if (!env.LEDGER_API_URL || !env.LEDGER_API_KEY) return createNotConfiguredLedgerApiClient();
  return createLedgerApiClient({ baseUrl: env.LEDGER_API_URL, apiKey: env.LEDGER_API_KEY });
}

export function getLedgerApiClient(): LedgerApiClient {
  return (globalThis.__ledgerApiClient ??= build());
}

/** Test hook: drop the memoized client. */
export function resetLedgerApiClientForTests(): void {
  globalThis.__ledgerApiClient = undefined;
}
