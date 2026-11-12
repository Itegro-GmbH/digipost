// Real Postgres for the corrected Google Play reader (src/modules/accounts/README.md, "Google fee
// refunds" and "Re-import"): a report imported while a "Google fee refund" row was still read as
// revenue is re-imported, the misclassified line and its clearing-account transaction are
// replaced by a fee line with a positive amount, every unchanged line keeps its id, and the
// ledger's untouched proposal for the report is updated to revenue = charges - charge refunds and
// fees = fees - fee refunds.
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createFakeLedgerBookingAdvisor } from "@/modules/ledger";
import { getDb } from "@/persistence/foundation/client";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { settlementLines, transactions } from "@/persistence/schema/accounts";
import { documents } from "@/persistence/schema/documents";
import { jobs } from "@/persistence/schema/jobs";
import { createAccountsUseCases } from "@/persistence/use-cases/accounts-use-cases";
import { createLedgerUseCases } from "@/persistence/use-cases/ledger-use-cases";
import { JOB_KINDS } from "@/platform/jobs";
import { createFakeObjectStorage } from "@/platform/object-storage/tests/support/fake-object-storage";

const db = getDb();
const repos = createDrizzleRepositories(db);
const uow = createDrizzleUnitOfWork(db);

const HEADER =
  "Description,Transaction Date,Transaction Time,Tax Type,Transaction Type,Refund Type,Product Title,Product id,Product Type,Sku Id,Hardware,Buyer Country,Buyer State,Buyer Postal Code,Buyer Currency,Amount (Buyer Currency),Currency Conversion Rate,Merchant Currency,Amount (Merchant Currency),Base Plan ID,Offer ID,Group ID,First USD 1M Eligible,Service Fee %,Fee Description,Promotion ID";
const row = (order: string, day: number, type: string, amount: string) =>
  `${order},"Jul ${day}, 2026",1:00:00 AM PDT,,${type},,Yearly (Planties),com.example.planties,1,yearly,x,DE,,00000,EUR,${amount},1.000000,EUR,${amount},,,1,Yes,15,,`;

/** July 2026 in miniature: charges 25,00 minus a charge refund of 11,64 are 13,36; Google's fees
 * 12,72 minus a refunded fee of 10,71 are 2,01; net 11,35. */
const JULY_REPORT = [
  HEADER,
  row("GPA.1", 3, "Charge", "25.00"),
  row("GPA.1", 3, "Google fee", "-3.75"),
  row("GPA.2", 8, "Google fee", "-8.97"),
  row("GPA.2", 20, "Charge refund", "-11.64"),
  row("GPA.2", 20, "Google fee refund", "10.71"),
].join("\n");

async function setup() {
  const workspace = await repos.workspace.create({ name: `Itegro GmbH ${randomUUID()}` });
  const workspaceId = workspace.id;
  const storageKey = `workspaces/${workspaceId}/documents/${randomUUID()}/original.csv`;
  const [doc] = await db
    .insert(documents)
    .values({
      workspaceId,
      originalFileName: "PlayApps_202607.csv",
      mimeType: "text/csv",
      pageCount: 1,
      sizeBytes: JULY_REPORT.length,
      storageKey,
      kind: "platform_settlement",
      platform: "google",
      intakeStatus: "confirmed",
      status: "done",
      direction: "unknown",
    })
    .returning();
  const { storage } = createFakeObjectStorage();
  await storage.putObject({ key: storageKey, body: new TextEncoder().encode(JULY_REPORT), contentType: "text/csv" });
  const accountsUseCases = createAccountsUseCases({ repos, uow, objectStorage: storage });
  const ledger = createLedgerUseCases({ repos, uow, bookingAdvisor: createFakeLedgerBookingAdvisor() });
  return { workspaceId, documentId: doc!.id, accountsUseCases, ledger };
}

/** Puts the report back into the state the old reader left it in: the refunded fee (row 5) stored
 * as a revenue line with its own +10,71 transaction. */
async function misclassifyFeeRefund(workspaceId: string, documentId: string) {
  const [feeLine] = await db
    .select()
    .from(settlementLines)
    .where(and(eq(settlementLines.sourceDocumentId, documentId), eq(settlementLines.externalLineId, "fee:row5")));
  await db.delete(settlementLines).where(eq(settlementLines.id, feeLine!.id));
  await db.delete(transactions).where(eq(transactions.id, feeLine!.transactionId!));
  const [oldTx] = await db
    .insert(transactions)
    .values({
      workspaceId,
      accountId: feeLine!.clearingAccountId,
      bookingDate: "2026-07-20",
      amountCents: 1071,
      creditDebit: "credit",
      counterpartyName: "Google Play",
      idempotencyKey: `settlement:${documentId}:revenue:row5`,
      sourceDocumentId: documentId,
    })
    .returning();
  await db.insert(settlementLines).values({
    workspaceId,
    clearingAccountId: feeLine!.clearingAccountId,
    sourceDocumentId: documentId,
    transactionId: oldTx!.id,
    type: "revenue",
    externalLineId: "revenue:row5",
    grossCents: 1071,
    feeCents: null,
    netCents: 1071,
    bookingDate: "2026-07-20",
  });
}

async function proposalLines(ledger: ReturnType<typeof createLedgerUseCases>, workspaceId: string, documentId: string) {
  const entries = await ledger.listEntries(workspaceId, { dismissed: "include" });
  const entry = entries.find((candidate) => candidate.sourceKey === `settlement:${documentId}:2026-07`);
  return entry?.lines.map((line) => [line.accountNumber, line.amountCents]);
}

describe("re-importing a Google Play report after the fee-refund fix", () => {
  it("replaces the misclassified line and updates the untouched ledger proposal", async () => {
    const { workspaceId, documentId, accountsUseCases, ledger } = await setup();
    await accountsUseCases.importFromDocument({ workspaceId, documentId });
    await misclassifyFeeRefund(workspaceId, documentId);

    await ledger.setSettings({ workspaceId, settings: { enabled: true, vatPeriod: "month", vatBasis: "soll", startDate: "2026-01-01" } });
    await ledger.syncProposals({ workspaceId });
    // What production showed: revenue and fees both overstated by the refunded fee.
    expect(await proposalLines(ledger, workspaceId, documentId)).toEqual([
      ["4339", -2407],
      ["6855", 1272],
      ["1407", 242],
      ["3837", -242],
      ["1370", 1135],
    ]);

    const unchangedBefore = await db.select().from(settlementLines).where(and(eq(settlementLines.sourceDocumentId, documentId), eq(settlementLines.externalLineId, "revenue:row1")));
    await db.delete(jobs).where(eq(jobs.workspaceId, workspaceId));

    const outcome = await accountsUseCases.importFromDocument({ workspaceId, documentId });
    expect(outcome).toMatchObject({ status: "settlement_imported", linesTotal: 5, linesImported: 1, linesDuplicate: 4 });

    const lines = await db.select().from(settlementLines).where(eq(settlementLines.sourceDocumentId, documentId));
    expect(lines.map((line) => [line.externalLineId, line.type, line.grossCents, line.feeCents, line.netCents]).sort()).toEqual(
      [
        ["fee:row2", "fee", null, -375, -375],
        ["fee:row3", "fee", null, -897, -897],
        ["fee:row5", "fee", null, 1071, 1071],
        ["refund:row4", "refund", -1164, null, -1164],
        ["revenue:row1", "revenue", 2500, null, 2500],
      ].sort(),
    );
    // The unchanged line kept its id; the replaced one's transaction is gone, the new one credits.
    expect(lines.find((line) => line.externalLineId === "revenue:row1")!.id).toBe(unchangedBefore[0]!.id);
    const clearing = await db.select().from(transactions).where(eq(transactions.sourceDocumentId, documentId));
    expect(clearing.some((tx) => tx.idempotencyKey.endsWith(":revenue:row5"))).toBe(false);
    expect(clearing.find((tx) => tx.idempotencyKey.endsWith(":fee:row5"))?.amountCents).toBe(1071);
    expect(clearing.reduce((sum, tx) => sum + tx.amountCents, 0)).toBe(1135);
    // The matching run that follows schedules the ledger sync.
    const queued = await db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId));
    expect(queued.map((job) => job.kind)).toEqual([JOB_KINDS.matchSettlementLines]);

    const sync = await ledger.syncProposals({ workspaceId });
    expect(sync.updated).toBe(1);
    expect(await proposalLines(ledger, workspaceId, documentId)).toEqual([
      ["4339", -1336],
      ["6855", 201],
      ["1407", 38],
      ["3837", -38],
      ["1370", 1135],
    ]);

    // A third import changes nothing.
    const again = await accountsUseCases.importFromDocument({ workspaceId, documentId });
    expect(again).toMatchObject({ linesImported: 0, linesDuplicate: 5 });
  });
});
