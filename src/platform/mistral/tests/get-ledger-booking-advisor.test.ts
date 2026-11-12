// The ledger booking advisor's getter (decisions/0080 phase 3): the payment arbiter's env
// selection exactly (`get-payment-arbiter.test.ts`).
import { afterEach, describe, expect, it } from "vitest";

import { resetServerEnvCacheForTests } from "@/platform/env/server";

import { getLedgerBookingAdvisor, resetLedgerBookingAdvisorForTests } from "../server/get-ledger-booking-advisor";

function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    APP_URL: "http://localhost:3000",
    DATABASE_URL: "postgres://user:pass@localhost:5432/app",
    BETTER_AUTH_SECRET: "a".repeat(32),
    SMTP_URL: "smtp://localhost:1025",
    MAIL_FROM: "Digipost <no-reply@digipost.local>",
    CRON_SECRET: "a".repeat(32),
    S3_ENDPOINT: "http://localhost:54346",
    S3_REGION: "us-east-1",
    S3_BUCKET: "digipost-documents",
    S3_ACCESS_KEY_ID: "minioadmin",
    S3_SECRET_ACCESS_KEY: "minioadmin",
    S3_FORCE_PATH_STYLE: "true",
  };
}

function withEnv(env: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> | void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCacheForTests();
  resetLedgerBookingAdvisorForTests();

  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetServerEnvCacheForTests();
    resetLedgerBookingAdvisorForTests();
  };

  const result = run();
  if (result instanceof Promise) return result.finally(restore);
  restore();
  return undefined;
}

const question = {
  documentId: "d",
  direction: "incoming" as const,
  senderName: "IONOS SE",
  country: "DE",
  vatId: null,
  title: "Rechnung",
  summary: null,
  invoiceNumber: null,
  documentDate: null,
  totalAmountCents: 119,
  currency: "EUR",
  netTotalCents: null,
  taxTotalCents: null,
  passThroughCents: null,
  reverseCharge: null,
  taxBreakdown: null,
  accounts: [{ number: "6810", name: "Internetkosten" }],
};

describe("getLedgerBookingAdvisor", () => {
  afterEach(() => {
    resetServerEnvCacheForTests();
    resetLedgerBookingAdvisorForTests();
  });

  it("binds the fake advisor when AI_PROVIDER=fake, even with a key present", async () => {
    await withEnv({ ...baseEnv(), AI_PROVIDER: "fake", MISTRAL_API_KEY: "some-key" }, async () => {
      const advisor = getLedgerBookingAdvisor();
      expect(advisor.version).toBe("fake:1");
      expect((await advisor.advise(question)).accountNumber).toBe("6810");
    });
  });

  it("binds the fake advisor outside production when no key is configured", () => {
    withEnv({ ...baseEnv(), NODE_ENV: "test" }, () => {
      expect(getLedgerBookingAdvisor().version).toBe("fake:1");
    });
  });

  it("binds the Mistral advisor when a key is configured", () => {
    withEnv({ ...baseEnv(), AI_PROVIDER: undefined, MISTRAL_API_KEY: "some-key" }, () => {
      expect(getLedgerBookingAdvisor().version).toMatch(/^mistral:/);
    });
  });

  it("binds a not-configured advisor that throws on first use in production with no key", async () => {
    await withEnv({ ...baseEnv(), NODE_ENV: "production", APP_URL: "https://example.com" }, async () => {
      const advisor = getLedgerBookingAdvisor();
      expect(advisor.version).toBe("not_configured");
      await expect(advisor.advise(question)).rejects.toMatchObject({ code: "ai_not_configured" });
    });
  });

  it("caches the advisor across calls", () => {
    withEnv(baseEnv(), () => {
      expect(getLedgerBookingAdvisor()).toBe(getLedgerBookingAdvisor());
    });
  });
});
