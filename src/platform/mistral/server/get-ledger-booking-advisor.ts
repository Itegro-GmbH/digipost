// Composition-root entry point for `LedgerBookingAdvisor` (decisions/0080 phase 3), the payment
// arbiter's getter (`get-payment-arbiter.ts`) copied exactly: env-driven selection with the same
// precedence, `globalThis` memoization so Next's dev-server HMR does not rebuild it on every
// reload.
import "server-only";

import { createFakeLedgerBookingAdvisor, type LedgerBookingAdvisor } from "@/modules/ledger";
import { serverEnv } from "@/platform/env/server";

import { MISTRAL_ERROR_CODES, MistralRequestError } from "../core/errors";
import { createMistralLedgerBookingAdvisor } from "./mistral-ledger-booking-advisor";

type LedgerBookingAdvisorMode = "mistral" | "fake" | "not_configured";

/** `AI_PROVIDER` explicit beats everything; unset falls back to "mistral" once a key exists,
 * otherwise to "fake" outside production and to "not_configured" in production. */
function resolveMode(): LedgerBookingAdvisorMode {
  const env = serverEnv();
  if (env.AI_PROVIDER === "fake") return "fake";
  if (env.AI_PROVIDER === "mistral") return env.MISTRAL_API_KEY ? "mistral" : "not_configured";
  if (env.MISTRAL_API_KEY) return "mistral";
  return env.NODE_ENV === "production" ? "not_configured" : "fake";
}

function createNotConfiguredLedgerBookingAdvisor(): LedgerBookingAdvisor {
  return {
    // Never answers (every call throws), so nothing is ever cached under this version.
    version: "not_configured",
    async advise() {
      throw new MistralRequestError(MISTRAL_ERROR_CODES.notConfigured, false, "AI provider is not configured");
    },
  };
}

function buildLedgerBookingAdvisor(mode: LedgerBookingAdvisorMode): LedgerBookingAdvisor {
  if (mode === "fake") return createFakeLedgerBookingAdvisor();
  if (mode === "not_configured") return createNotConfiguredLedgerBookingAdvisor();
  const env = serverEnv();
  // A chat completion like the arbiter's: the same MISTRAL_CHAT_MODEL, no separate env var.
  return createMistralLedgerBookingAdvisor({ apiKey: env.MISTRAL_API_KEY ?? "", model: env.MISTRAL_CHAT_MODEL ?? "mistral-small-latest" });
}

declare global {
  var __ledgerBookingAdvisor: LedgerBookingAdvisor | undefined;
}

export function getLedgerBookingAdvisor(): LedgerBookingAdvisor {
  return (globalThis.__ledgerBookingAdvisor ??= buildLedgerBookingAdvisor(resolveMode()));
}

/** Test hook: drop the memoized adapter. */
export function resetLedgerBookingAdvisorForTests(): void {
  globalThis.__ledgerBookingAdvisor = undefined;
}
