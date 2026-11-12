// The real `LedgerBookingAdvisor` (decisions/0080-ledger-double-entry-bookkeeping.md, phase 3):
// `POST /v1/chat/completions`, `response_format: { type: "json_object" }`, `temperature: 0`,
// the payment arbiter's exact shape (`mistralFetch`, `mistralChatResponseSchema`, the same error
// classification). Returns the RAW answer; `@/modules/ledger`'s `validateBookingAdvice` is run by
// the caller against the question, for the real adapter and the fake alike.
//
// "Mistral and personal data" (AGENTS.md): the question carries only extracted fields, never the
// OCR text, and real traffic stays blocked on the DPA like every other Mistral call; this
// adapter is bound only when `AI_PROVIDER`/`MISTRAL_API_KEY` select Mistral.
import "server-only";

import type { BookingAdviceQuestion, BookingAdviceRaw, LedgerBookingAdvisor } from "@/modules/ledger";

import { MISTRAL_ERROR_CODES, MistralRequestError } from "../core/errors";
import { mistralChatResponseSchema } from "../core/schemas";
import { buildLedgerBookingAdvisorSystemPrompt, buildLedgerBookingAdvisorUserPrompt, ledgerBookingAdvisorPromptFingerprint } from "./ledger-booking-advisor-prompts";
import { mistralFetch, type MistralFetchConfig } from "./mistral-fetch";

export type MistralLedgerBookingAdvisorConfig = MistralFetchConfig & { model: string };

export function createMistralLedgerBookingAdvisor(config: MistralLedgerBookingAdvisorConfig): LedgerBookingAdvisor {
  return {
    version: `mistral:${config.model}:${ledgerBookingAdvisorPromptFingerprint()}`,
    async advise(question: BookingAdviceQuestion): Promise<BookingAdviceRaw> {
      if (question.accounts.length === 0) return { accountNumber: null, taxCode: null, reason: "" };
      const json = await mistralFetch(
        "/v1/chat/completions",
        {
          model: config.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: buildLedgerBookingAdvisorSystemPrompt() },
            { role: "user", content: buildLedgerBookingAdvisorUserPrompt(question) },
          ],
        },
        config,
      );

      const parsed = mistralChatResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new MistralRequestError(MISTRAL_ERROR_CODES.invalidResponse, false, "Mistral ledger-advisor response failed validation");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(parsed.data.choices[0]?.message.content ?? "");
      } catch {
        raw = {};
      }
      return normalizeRawAdvice(raw);
    },
  };
}

/** Lenient: a missing or wrong-typed field degrades to "no answer", never a thrown error. */
function normalizeRawAdvice(raw: unknown): BookingAdviceRaw {
  if (typeof raw !== "object" || raw === null) return { accountNumber: null, taxCode: null, reason: "" };
  const record = raw as Record<string, unknown>;
  const text = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return null;
  };
  const lines = Array.isArray(record.lines)
    ? record.lines.flatMap((line) => {
        if (typeof line !== "object" || line === null) return [];
        const entry = line as Record<string, unknown>;
        const accountNumber = text(entry.accountNumber);
        const amountCents = typeof entry.amountCents === "number" ? entry.amountCents : null;
        return accountNumber && amountCents !== null ? [{ accountNumber, taxCode: text(entry.taxCode), amountCents }] : [];
      })
    : null;
  return { accountNumber: text(record.accountNumber), taxCode: text(record.taxCode), reason: text(record.reason) ?? "", lines };
}
