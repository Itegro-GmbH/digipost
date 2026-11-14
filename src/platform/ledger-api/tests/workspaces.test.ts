// `LEDGER_API_WORKSPACES` parsing, the per-workspace switch read from the env (off unless a
// workspace is listed), and which operations are reads.
import { afterEach, describe, expect, it } from "vitest";

import { resetServerEnvCacheForTests } from "@/platform/env/server";
import { isLedgerApiReadOperation, parseLedgerApiWorkspaces } from "@/platform/ledger-api";
import { usesLedgerApi } from "@/platform/ledger-api/server";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

const BASE_ENV: Record<string, string> = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://user:pass@localhost:5432/app",
  BETTER_AUTH_SECRET: "a".repeat(32),
  SMTP_URL: "smtp://localhost:1025",
  MAIL_FROM: "App <no-reply@example.com>",
  CRON_SECRET: "a".repeat(32),
  S3_REGION: "us-east-1",
  S3_BUCKET: "digipost-documents",
  S3_ACCESS_KEY_ID: "minioadmin",
  S3_SECRET_ACCESS_KEY: "minioadmin",
};

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCacheForTests();
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetServerEnvCacheForTests();
  }
}

afterEach(() => resetServerEnvCacheForTests());

describe("parseLedgerApiWorkspaces", () => {
  it("is empty for unset, empty or blank values", () => {
    expect(parseLedgerApiWorkspaces(undefined).size).toBe(0);
    expect(parseLedgerApiWorkspaces("").size).toBe(0);
    expect(parseLedgerApiWorkspaces(" , ,").size).toBe(0);
  });

  it("splits by comma, trims and lowercases", () => {
    expect([...parseLedgerApiWorkspaces(` ${WS.toUpperCase()} ,${OTHER},`)]).toEqual([WS, OTHER]);
  });
});

describe("usesLedgerApi", () => {
  it("is off for every workspace while LEDGER_API_WORKSPACES is unset or empty", () => {
    withEnv({ ...BASE_ENV, LEDGER_API_WORKSPACES: undefined, LEDGER_API_URL: undefined, LEDGER_API_KEY: undefined }, () => {
      expect(usesLedgerApi(WS)).toBe(false);
    });
    withEnv({ ...BASE_ENV, LEDGER_API_WORKSPACES: "" }, () => {
      expect(usesLedgerApi(WS)).toBe(false);
    });
  });

  it("is on only for a listed workspace", () => {
    withEnv({ ...BASE_ENV, LEDGER_API_WORKSPACES: WS }, () => {
      expect(usesLedgerApi(WS)).toBe(true);
      expect(usesLedgerApi(WS.toUpperCase())).toBe(true);
      expect(usesLedgerApi(OTHER)).toBe(false);
    });
  });
});

describe("isLedgerApiReadOperation", () => {
  it("treats list_, get_ and find_ operations as reads and everything else as a write", () => {
    for (const read of ["list_entries", "get_overview", "find_tenant", "list_money_movements"]) expect(isLedgerApiReadOperation(read)).toBe(true);
    for (const write of ["create_entry", "book_entries", "sync_proposals", "upsert_documents", "submit_filing", "delete_rule"]) expect(isLedgerApiReadOperation(write)).toBe(false);
  });
});
