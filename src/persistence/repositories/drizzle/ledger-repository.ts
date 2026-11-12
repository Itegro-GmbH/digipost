// Owner: src/modules/ledger (decisions/0080-ledger-double-entry-bookkeeping.md). Encapsulates
// access only (WEBAPP_TEMPLATE_SPEC.md §5.3). Every method filters on `workspaceId` explicitly.
// The source reads at the end join other owners' tables read-only and never write them.
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lte, or, sql, type SQL } from "drizzle-orm";

import { LEDGER_BOOKABLE_DOCUMENT_KINDS } from "@/modules/ledger";
import type { DbExecutor } from "@/persistence/foundation/db-types";
import type { CreateJournalLineRow, JournalLineRow, LedgerRepository } from "@/persistence/repositories/contracts/ledger-repository";
import { accounts, importBatches, transactions } from "@/persistence/schema/accounts";
import { contacts } from "@/persistence/schema/contacts";
import { documents } from "@/persistence/schema/documents";
import {
  journalEntries,
  journalEntryRevisions,
  journalLines,
  ledgerAccounts,
  ledgerAdvisorBalanceLines,
  ledgerAdvisorBalances,
  ledgerBookingAdvice,
  ledgerBookingRules,
  ledgerFilings,
  ledgerHandovers,
  ledgerOpenItemMatches,
  ledgerOpenItemMatchLines,
  ledgerSettings,
} from "@/persistence/schema/ledger";

function first<T>(rows: T[], table: string): T {
  const [row] = rows;
  if (!row) throw new Error(`insert into ${table} returned no row`);
  return row;
}

/** Whether filing `f` (a table alias or the table) covers `date`, like `ledger_filing_covers`. */
function filingCovers(date: string): SQL {
  return sql`ledger_filing_covers(${ledgerFilings.kind}, ${ledgerFilings.periodFrom}, ${ledgerFilings.periodTo}, ${date}::date)`;
}

export function createDrizzleLedgerRepository(db: DbExecutor): LedgerRepository {
  return {
    // -----------------------------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------------------------
    async findSettings(workspaceId) {
      const [row] = await db.select().from(ledgerSettings).where(eq(ledgerSettings.workspaceId, workspaceId)).limit(1);
      return row ?? null;
    },

    async upsertSettings(workspaceId, patch) {
      const rows = await db
        .insert(ledgerSettings)
        .values({ workspaceId, ...patch })
        .onConflictDoUpdate({ target: ledgerSettings.workspaceId, set: { ...patch, updatedAt: new Date() } })
        .returning();
      return first(rows, "ledger_settings");
    },

    // -----------------------------------------------------------------------------------------
    // Chart of accounts
    // -----------------------------------------------------------------------------------------
    listAccounts: (workspaceId) => db.select().from(ledgerAccounts).where(eq(ledgerAccounts.workspaceId, workspaceId)).orderBy(asc(ledgerAccounts.number)),

    async findAccountById(workspaceId, id) {
      const [row] = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.workspaceId, workspaceId), eq(ledgerAccounts.id, id)))
        .limit(1);
      return row ?? null;
    },

    async findAccountByNumber(workspaceId, number) {
      const [row] = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.workspaceId, workspaceId), eq(ledgerAccounts.number, number)))
        .limit(1);
      return row ?? null;
    },

    async insertAccount(row) {
      return first(await db.insert(ledgerAccounts).values(row).returning(), "ledger_accounts");
    },

    async insertAccountsIfMissing(rows) {
      if (rows.length === 0) return [];
      return db
        .insert(ledgerAccounts)
        .values(rows)
        .onConflictDoNothing({ target: [ledgerAccounts.workspaceId, ledgerAccounts.number] })
        .returning();
    },

    async updateAccount(workspaceId, id, patch) {
      const [row] = await db
        .update(ledgerAccounts)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(ledgerAccounts.workspaceId, workspaceId), eq(ledgerAccounts.id, id)))
        .returning();
      return row ?? null;
    },

    async countLinesForAccount(workspaceId, accountId) {
      const [row] = await db
        .select({ value: count() })
        .from(journalLines)
        .where(and(eq(journalLines.workspaceId, workspaceId), eq(journalLines.accountId, accountId)));
      return row?.value ?? 0;
    },

    // -----------------------------------------------------------------------------------------
    // Journal
    // -----------------------------------------------------------------------------------------
    async insertEntry(row) {
      return first(await db.insert(journalEntries).values(row).returning(), "journal_entries");
    },

    async findEntry(workspaceId, id, options) {
      const query = db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.workspaceId, workspaceId), eq(journalEntries.id, id)))
        .limit(1);
      const [row] = options?.forUpdate ? await query.for("update") : await query;
      return row ?? null;
    },

    async findEntryBySourceKey(workspaceId, sourceKey, options) {
      const query = db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.workspaceId, workspaceId), eq(journalEntries.sourceKey, sourceKey)))
        .limit(1);
      const [row] = options?.forUpdate ? await query.for("update") : await query;
      return row ?? null;
    },

    async updateEntry(workspaceId, id, patch, condition) {
      // Postgres re-checks the WHERE on the newest row version after waiting for a concurrent
      // writer, so a condition here cannot be passed by a change committed in between.
      const conditions: SQL[] = [eq(journalEntries.workspaceId, workspaceId), eq(journalEntries.id, id)];
      if (condition?.expectedRevision !== undefined) conditions.push(eq(journalEntries.revision, condition.expectedRevision));
      if (condition?.untouchedProposal) {
        conditions.push(eq(journalEntries.status, "proposed"), isNull(journalEntries.userEditedAt), isNull(journalEntries.dismissedAt));
      }
      const [row] = await db
        .update(journalEntries)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();
      return row ?? null;
    },

    async deleteEntry(workspaceId, id) {
      const rows = await db
        .delete(journalEntries)
        .where(and(eq(journalEntries.workspaceId, workspaceId), eq(journalEntries.id, id)))
        .returning({ id: journalEntries.id });
      return rows.length > 0;
    },

    async listEntries(workspaceId, filter) {
      const conditions: SQL[] = [eq(journalEntries.workspaceId, workspaceId)];
      if (filter.from) conditions.push(gte(journalEntries.bookingDate, filter.from));
      if (filter.to) conditions.push(lte(journalEntries.bookingDate, filter.to));
      if (filter.status) conditions.push(eq(journalEntries.status, filter.status));
      if (filter.origin) conditions.push(eq(journalEntries.origin, filter.origin));
      if (filter.documentId) conditions.push(eq(journalEntries.documentId, filter.documentId));
      if (filter.dismissed === "exclude") conditions.push(isNull(journalEntries.dismissedAt));
      if (filter.dismissed === "only") conditions.push(isNotNull(journalEntries.dismissedAt));
      if (filter.accountId) {
        conditions.push(
          sql`exists (select 1 from ${journalLines} where ${journalLines.entryId} = ${journalEntries.id} and ${journalLines.workspaceId} = ${workspaceId} and ${journalLines.accountId} = ${filter.accountId})`,
        );
      }
      if (filter.changedSince) {
        conditions.push(
          sql`exists (select 1 from ${journalEntryRevisions} where ${journalEntryRevisions.entryRef} = ${journalEntries.id} and ${journalEntryRevisions.workspaceId} = ${workspaceId} and ${journalEntryRevisions.changedAt} > ${filter.changedSince})`,
        );
      }
      return db
        .select()
        .from(journalEntries)
        .where(and(...conditions))
        .orderBy(desc(journalEntries.bookingDate), desc(journalEntries.createdAt))
        .limit(filter.limit);
    },

    async replaceLines(workspaceId, entryId, lines) {
      const old = await db
        .select()
        .from(journalLines)
        .where(and(eq(journalLines.workspaceId, workspaceId), eq(journalLines.entryId, entryId)))
        .orderBy(asc(journalLines.position));
      const oldByPosition = new Map(old.map((line) => [line.position, line]));
      // What an open item is: a line keeping these keeps its id, and so its match.
      const sameItem = (a: CreateJournalLineRow, b: CreateJournalLineRow) =>
        a.position === b.position && a.accountId === b.accountId && a.amountCents === b.amountCents && (a.documentId ?? null) === (b.documentId ?? null);
      const sameLine = (a: CreateJournalLineRow, b: CreateJournalLineRow) =>
        sameItem(a, b) && a.taxCode === b.taxCode && a.taxRole === b.taxRole && a.generatedFromLinePosition === b.generatedFromLinePosition && (a.text ?? null) === (b.text ?? null);

      if (old.length === lines.length && lines.every((line) => oldByPosition.has(line.position) && sameLine(oldByPosition.get(line.position)!, line))) {
        return { lines: old, dissolvedMatches: 0 };
      }

      const kept = lines.filter((line) => oldByPosition.has(line.position) && sameItem(oldByPosition.get(line.position)!, line));
      const keptPositions = new Set(kept.map((line) => line.position));
      const removed = old.filter((line) => !keptPositions.has(line.position)).map((line) => line.id);
      let dissolvedMatches = 0;
      if (removed.length > 0) {
        const affected = db
          .select({ id: ledgerOpenItemMatchLines.matchId })
          .from(ledgerOpenItemMatchLines)
          .where(and(eq(ledgerOpenItemMatchLines.workspaceId, workspaceId), inArray(ledgerOpenItemMatchLines.lineId, removed)));
        dissolvedMatches = (
          await db
            .delete(ledgerOpenItemMatches)
            .where(and(eq(ledgerOpenItemMatches.workspaceId, workspaceId), inArray(ledgerOpenItemMatches.id, affected)))
            .returning({ id: ledgerOpenItemMatches.id })
        ).length;
        await db.delete(journalLines).where(and(eq(journalLines.workspaceId, workspaceId), inArray(journalLines.id, removed)));
      }
      const result: JournalLineRow[] = [];
      for (const line of kept) {
        const previous = oldByPosition.get(line.position)!;
        if (sameLine(previous, line)) {
          result.push(previous);
          continue;
        }
        const [updated] = await db
          .update(journalLines)
          .set({ taxCode: line.taxCode, taxRole: line.taxRole, generatedFromLinePosition: line.generatedFromLinePosition, text: line.text })
          .where(and(eq(journalLines.workspaceId, workspaceId), eq(journalLines.id, previous.id)))
          .returning();
        result.push(updated ?? previous);
      }
      const added = lines.filter((line) => !keptPositions.has(line.position));
      if (added.length > 0) {
        result.push(
          ...(await db
            .insert(journalLines)
            .values(added.map((line) => ({ ...line, workspaceId, entryId })))
            .returning()),
        );
      }
      return { lines: result.sort((a, b) => a.position - b.position), dissolvedMatches };
    },

    async listLines(workspaceId, entryIds) {
      if (entryIds.length === 0) return [];
      const rows = await db
        .select({ line: journalLines, accountNumber: ledgerAccounts.number, accountName: ledgerAccounts.name })
        .from(journalLines)
        .innerJoin(ledgerAccounts, and(eq(ledgerAccounts.id, journalLines.accountId), eq(ledgerAccounts.workspaceId, journalLines.workspaceId)))
        .where(and(eq(journalLines.workspaceId, workspaceId), inArray(journalLines.entryId, entryIds)))
        .orderBy(asc(journalLines.entryId), asc(journalLines.position));
      return rows.map((row) => ({ ...row.line, accountNumber: row.accountNumber, accountName: row.accountName }));
    },

    async listReportLines(workspaceId, options) {
      const statuses = options.statuses ?? ["booked"];
      const conditions: SQL[] = [eq(journalLines.workspaceId, workspaceId), inArray(journalEntries.status, statuses), isNull(journalEntries.dismissedAt)];
      if (options.to) conditions.push(lte(journalEntries.bookingDate, options.to));
      return db
        .select({
          lineId: journalLines.id,
          entryId: journalLines.entryId,
          position: journalLines.position,
          accountId: journalLines.accountId,
          accountNumber: ledgerAccounts.number,
          bookingDate: journalEntries.bookingDate,
          amountCents: journalLines.amountCents,
          taxCode: journalLines.taxCode,
          taxRole: journalLines.taxRole,
          text: journalLines.text,
          entryText: journalEntries.text,
          documentId: journalEntries.documentId,
          transactionId: journalEntries.transactionId,
          status: journalEntries.status,
          lineDocumentId: journalLines.documentId,
        })
        .from(journalLines)
        .innerJoin(journalEntries, and(eq(journalEntries.id, journalLines.entryId), eq(journalEntries.workspaceId, journalLines.workspaceId)))
        .innerJoin(ledgerAccounts, and(eq(ledgerAccounts.id, journalLines.accountId), eq(ledgerAccounts.workspaceId, journalLines.workspaceId)))
        .where(and(...conditions))
        .orderBy(asc(journalEntries.bookingDate), asc(journalLines.entryId), asc(journalLines.position));
    },

    async countEntries(workspaceId, period) {
      const sums = db
        .select({ entryId: journalLines.entryId, total: sql<number>`sum(${journalLines.amountCents})`.as("total") })
        .from(journalLines)
        .where(eq(journalLines.workspaceId, workspaceId))
        .groupBy(journalLines.entryId)
        .as("sums");
      const [row] = await db
        .select({
          booked: sql<number>`count(*) filter (where ${journalEntries.status} = 'booked')`.mapWith(Number),
          proposed: sql<number>`count(*) filter (where ${journalEntries.status} = 'proposed')`.mapWith(Number),
          unbalancedProposed: sql<number>`count(*) filter (where ${journalEntries.status} = 'proposed' and coalesce(${sums.total}, 0) <> 0)`.mapWith(Number),
        })
        .from(journalEntries)
        .leftJoin(sums, eq(sums.entryId, journalEntries.id))
        .where(
          and(
            eq(journalEntries.workspaceId, workspaceId),
            isNull(journalEntries.dismissedAt),
            gte(journalEntries.bookingDate, period.from),
            lte(journalEntries.bookingDate, period.to),
          ),
        );
      return { booked: row?.booked ?? 0, proposed: row?.proposed ?? 0, unbalancedProposed: row?.unbalancedProposed ?? 0 };
    },

    async listSourceKeys(workspaceId, prefix) {
      const conditions: SQL[] = [eq(journalEntries.workspaceId, workspaceId), isNotNull(journalEntries.sourceKey)];
      if (prefix) conditions.push(like(journalEntries.sourceKey, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
      const rows = await db
        .select({
          sourceKey: journalEntries.sourceKey,
          entryId: journalEntries.id,
          status: journalEntries.status,
          dismissedAt: journalEntries.dismissedAt,
          userEditedAt: journalEntries.userEditedAt,
        })
        .from(journalEntries)
        .where(and(...conditions))
        .orderBy(asc(journalEntries.sourceKey));
      return rows.map((row) => ({ ...row, sourceKey: row.sourceKey ?? "" }));
    },

    // -----------------------------------------------------------------------------------------
    // Revisions
    // -----------------------------------------------------------------------------------------
    async insertRevision(row) {
      return first(await db.insert(journalEntryRevisions).values(row).returning(), "journal_entry_revisions");
    },

    listRevisions: (workspaceId, entryRef) =>
      db
        .select()
        .from(journalEntryRevisions)
        .where(and(eq(journalEntryRevisions.workspaceId, workspaceId), eq(journalEntryRevisions.entryRef, entryRef)))
        .orderBy(asc(journalEntryRevisions.revision), asc(journalEntryRevisions.changedAt)),

    async countRevisionsSince(workspaceId, period, since) {
      // A revision counts when either the booking date it records (the state after the change)
      // or the one in its snapshot (the state before) lies in the period: moving an entry out
      // of a handed-over period is a change to that period too.
      const [row] = await db
        .select({ value: count() })
        .from(journalEntryRevisions)
        .where(
          and(
            eq(journalEntryRevisions.workspaceId, workspaceId),
            gt(journalEntryRevisions.changedAt, since),
            or(
              and(gte(journalEntryRevisions.bookingDate, period.from), lte(journalEntryRevisions.bookingDate, period.to)),
              sql`(${journalEntryRevisions.snapshot} ->> 'bookingDate') between ${period.from} and ${period.to}`,
            ),
          ),
        );
      return row?.value ?? 0;
    },

    // -----------------------------------------------------------------------------------------
    // Open items
    // -----------------------------------------------------------------------------------------
    async insertMatch(row, lineIds) {
      const match = first(await db.insert(ledgerOpenItemMatches).values(row).returning(), "ledger_open_item_matches");
      await db.insert(ledgerOpenItemMatchLines).values(lineIds.map((lineId) => ({ workspaceId: row.workspaceId, matchId: match.id, lineId })));
      return match;
    },

    async findMatch(workspaceId, id) {
      const [row] = await db
        .select()
        .from(ledgerOpenItemMatches)
        .where(and(eq(ledgerOpenItemMatches.workspaceId, workspaceId), eq(ledgerOpenItemMatches.id, id)))
        .limit(1);
      return row ?? null;
    },

    async deleteMatch(workspaceId, id) {
      const rows = await db
        .delete(ledgerOpenItemMatches)
        .where(and(eq(ledgerOpenItemMatches.workspaceId, workspaceId), eq(ledgerOpenItemMatches.id, id)))
        .returning({ id: ledgerOpenItemMatches.id });
      return rows.length > 0;
    },

    async deleteMatchesForEntry(workspaceId, entryId) {
      const lines = db
        .select({ id: journalLines.id })
        .from(journalLines)
        .where(and(eq(journalLines.workspaceId, workspaceId), eq(journalLines.entryId, entryId)));
      const affected = db
        .select({ id: ledgerOpenItemMatchLines.matchId })
        .from(ledgerOpenItemMatchLines)
        .where(and(eq(ledgerOpenItemMatchLines.workspaceId, workspaceId), inArray(ledgerOpenItemMatchLines.lineId, lines)));
      const rows = await db
        .delete(ledgerOpenItemMatches)
        .where(and(eq(ledgerOpenItemMatches.workspaceId, workspaceId), inArray(ledgerOpenItemMatches.id, affected)))
        .returning({ id: ledgerOpenItemMatches.id });
      return rows.length;
    },

    async listMatches(workspaceId, accountId) {
      const conditions: SQL[] = [eq(ledgerOpenItemMatches.workspaceId, workspaceId)];
      if (accountId) conditions.push(eq(ledgerOpenItemMatches.accountId, accountId));
      const matches = await db
        .select()
        .from(ledgerOpenItemMatches)
        .where(and(...conditions))
        .orderBy(asc(ledgerOpenItemMatches.createdAt));
      if (matches.length === 0) return [];
      const links = await db
        .select()
        .from(ledgerOpenItemMatchLines)
        .where(
          and(
            eq(ledgerOpenItemMatchLines.workspaceId, workspaceId),
            inArray(
              ledgerOpenItemMatchLines.matchId,
              matches.map((match) => match.id),
            ),
          ),
        );
      return matches.map((match) => ({ ...match, lineIds: links.filter((link) => link.matchId === match.id).map((link) => link.lineId) }));
    },

    async findMatchedLineIds(workspaceId, lineIds) {
      if (lineIds.length === 0) return [];
      const rows = await db
        .select({ lineId: ledgerOpenItemMatchLines.lineId })
        .from(ledgerOpenItemMatchLines)
        .where(and(eq(ledgerOpenItemMatchLines.workspaceId, workspaceId), inArray(ledgerOpenItemMatchLines.lineId, lineIds)));
      return rows.map((row) => row.lineId);
    },

    async findLines(workspaceId, lineIds) {
      if (lineIds.length === 0) return [];
      const rows = await db
        .select({ line: journalLines, entryStatus: journalEntries.status })
        .from(journalLines)
        .innerJoin(journalEntries, and(eq(journalEntries.id, journalLines.entryId), eq(journalEntries.workspaceId, journalLines.workspaceId)))
        .where(and(eq(journalLines.workspaceId, workspaceId), inArray(journalLines.id, lineIds)));
      return rows.map((row) => ({ ...row.line, entryStatus: row.entryStatus }));
    },

    async listUnmatchedOpenItemLines(workspaceId, accountId) {
      const conditions: SQL[] = [
        eq(journalLines.workspaceId, workspaceId),
        eq(journalEntries.status, "booked"),
        eq(ledgerAccounts.openItems, true),
        sql`not exists (select 1 from ${ledgerOpenItemMatchLines} where ${ledgerOpenItemMatchLines.lineId} = ${journalLines.id})`,
      ];
      if (accountId) conditions.push(eq(journalLines.accountId, accountId));
      return db
        .select({
          lineId: journalLines.id,
          accountId: journalLines.accountId,
          amountCents: journalLines.amountCents,
          documentId: journalLines.documentId,
          bookingDate: journalEntries.bookingDate,
        })
        .from(journalLines)
        .innerJoin(journalEntries, and(eq(journalEntries.id, journalLines.entryId), eq(journalEntries.workspaceId, journalLines.workspaceId)))
        .innerJoin(ledgerAccounts, and(eq(ledgerAccounts.id, journalLines.accountId), eq(ledgerAccounts.workspaceId, journalLines.workspaceId)))
        .where(and(...conditions))
        .orderBy(asc(journalEntries.bookingDate), asc(journalLines.id));
    },

    // -----------------------------------------------------------------------------------------
    // Booking rules
    // -----------------------------------------------------------------------------------------
    listRules: (workspaceId) => db.select().from(ledgerBookingRules).where(eq(ledgerBookingRules.workspaceId, workspaceId)).orderBy(asc(ledgerBookingRules.createdAt)),

    async findRule(workspaceId, id) {
      const [row] = await db
        .select()
        .from(ledgerBookingRules)
        .where(and(eq(ledgerBookingRules.workspaceId, workspaceId), eq(ledgerBookingRules.id, id)))
        .limit(1);
      return row ?? null;
    },

    async insertRule(row) {
      return first(await db.insert(ledgerBookingRules).values(row).returning(), "ledger_booking_rules");
    },

    async updateRule(workspaceId, id, patch) {
      const [row] = await db
        .update(ledgerBookingRules)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(ledgerBookingRules.workspaceId, workspaceId), eq(ledgerBookingRules.id, id)))
        .returning();
      return row ?? null;
    },

    async incrementRuleHits(workspaceId, id) {
      await db
        .update(ledgerBookingRules)
        .set({ hits: sql`${ledgerBookingRules.hits} + 1` })
        .where(and(eq(ledgerBookingRules.workspaceId, workspaceId), eq(ledgerBookingRules.id, id)));
    },

    async listBookingAdvice(workspaceId, documentIds) {
      if (documentIds.length === 0) return [];
      return db
        .select()
        .from(ledgerBookingAdvice)
        .where(and(eq(ledgerBookingAdvice.workspaceId, workspaceId), inArray(ledgerBookingAdvice.documentId, documentIds)));
    },

    async upsertBookingAdvice(row) {
      await db
        .insert(ledgerBookingAdvice)
        .values(row)
        .onConflictDoUpdate({
          target: [ledgerBookingAdvice.workspaceId, ledgerBookingAdvice.documentId],
          set: { cacheKey: row.cacheKey, answer: row.answer, updatedAt: new Date() },
        });
    },

    async deleteRule(workspaceId, id) {
      const rows = await db
        .delete(ledgerBookingRules)
        .where(and(eq(ledgerBookingRules.workspaceId, workspaceId), eq(ledgerBookingRules.id, id)))
        .returning({ id: ledgerBookingRules.id });
      return rows.length > 0;
    },

    // -----------------------------------------------------------------------------------------
    // Filings
    // -----------------------------------------------------------------------------------------
    listFilings: (workspaceId) =>
      db.select().from(ledgerFilings).where(eq(ledgerFilings.workspaceId, workspaceId)).orderBy(desc(ledgerFilings.periodFrom), asc(ledgerFilings.createdAt)),

    async findFiling(workspaceId, id) {
      const [row] = await db
        .select()
        .from(ledgerFilings)
        .where(and(eq(ledgerFilings.workspaceId, workspaceId), eq(ledgerFilings.id, id)))
        .limit(1);
      return row ?? null;
    },

    async insertFiling(row) {
      return first(await db.insert(ledgerFilings).values(row).returning(), "ledger_filings");
    },

    async updateFiling(workspaceId, id, patch) {
      const [row] = await db
        .update(ledgerFilings)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(ledgerFilings.workspaceId, workspaceId), eq(ledgerFilings.id, id)))
        .returning();
      return row ?? null;
    },

    async findLockingFiling(workspaceId, date, filingId) {
      // The same rule as `ledger_date_locked` (src/persistence/sql/ledger_filing_lock/): a
      // submitted filing covering the date, unless `filingId` is a draft correction of the same
      // kind covering it too.
      const [row] = await db
        .select()
        .from(ledgerFilings)
        .where(
          and(
            eq(ledgerFilings.workspaceId, workspaceId),
            eq(ledgerFilings.status, "submitted"),
            filingCovers(date),
            filingId
              ? sql`not exists (
                  select 1 from ledger_filings d
                  where d.id = ${filingId} and d.workspace_id = ${workspaceId} and d.status = 'draft'
                    and d.corrects_filing_id is not null and d.kind = ${ledgerFilings.kind}
                    and ledger_filing_covers(d.kind, d.period_from, d.period_to, ${date}::date)
                )`
              : undefined,
          ),
        )
        .orderBy(asc(ledgerFilings.periodFrom))
        .limit(1);
      return row ?? null;
    },

    // -----------------------------------------------------------------------------------------
    // Handovers
    // -----------------------------------------------------------------------------------------
    async insertHandover(row) {
      return first(await db.insert(ledgerHandovers).values(row).returning(), "ledger_handovers");
    },

    listHandovers: (workspaceId) => db.select().from(ledgerHandovers).where(eq(ledgerHandovers.workspaceId, workspaceId)).orderBy(desc(ledgerHandovers.createdAt)),

    // -----------------------------------------------------------------------------------------
    // Tax advisor's balance lists
    // -----------------------------------------------------------------------------------------
    async insertAdvisorUpload(row, lines) {
      const upload = first(await db.insert(ledgerAdvisorBalances).values(row).returning(), "ledger_advisor_balances");
      if (lines.length > 0) {
        await db.insert(ledgerAdvisorBalanceLines).values(lines.map((line) => ({ ...line, workspaceId: row.workspaceId, uploadId: upload.id })));
      }
      return upload;
    },

    async listAdvisorUploads(workspaceId) {
      const rows = await db
        .select({ upload: ledgerAdvisorBalances, lineCount: count(ledgerAdvisorBalanceLines.id) })
        .from(ledgerAdvisorBalances)
        .leftJoin(
          ledgerAdvisorBalanceLines,
          and(eq(ledgerAdvisorBalanceLines.uploadId, ledgerAdvisorBalances.id), eq(ledgerAdvisorBalanceLines.workspaceId, ledgerAdvisorBalances.workspaceId)),
        )
        .where(eq(ledgerAdvisorBalances.workspaceId, workspaceId))
        .groupBy(ledgerAdvisorBalances.id)
        .orderBy(desc(ledgerAdvisorBalances.uploadedAt));
      return rows.map((row) => ({ ...row.upload, lineCount: row.lineCount }));
    },

    async findAdvisorUpload(workspaceId, id) {
      const [row] = await db
        .select()
        .from(ledgerAdvisorBalances)
        .where(and(eq(ledgerAdvisorBalances.workspaceId, workspaceId), eq(ledgerAdvisorBalances.id, id)))
        .limit(1);
      return row ?? null;
    },

    listAdvisorLines: (workspaceId, uploadId) =>
      db
        .select()
        .from(ledgerAdvisorBalanceLines)
        .where(and(eq(ledgerAdvisorBalanceLines.workspaceId, workspaceId), eq(ledgerAdvisorBalanceLines.uploadId, uploadId)))
        .orderBy(asc(ledgerAdvisorBalanceLines.accountNumber)),

    async deleteAdvisorUpload(workspaceId, id) {
      const rows = await db
        .delete(ledgerAdvisorBalances)
        .where(and(eq(ledgerAdvisorBalances.workspaceId, workspaceId), eq(ledgerAdvisorBalances.id, id)))
        .returning({ id: ledgerAdvisorBalances.id });
      return rows.length > 0;
    },

    // -----------------------------------------------------------------------------------------
    // Source reads (read-only joins of other owners' tables)
    // -----------------------------------------------------------------------------------------
    async documentExists(workspaceId, documentId) {
      const [row] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.workspaceId, workspaceId), eq(documents.id, documentId)))
        .limit(1);
      return Boolean(row);
    },

    async transactionExists(workspaceId, transactionId) {
      const [row] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.workspaceId, workspaceId), eq(transactions.id, transactionId)))
        .limit(1);
      return Boolean(row);
    },

    listSourceAccounts: (workspaceId) =>
      db
        .select({ id: accounts.id, name: accounts.name, type: accounts.type, platform: accounts.platform, contactId: accounts.contactId, contactName: contacts.name })
        .from(accounts)
        .leftJoin(contacts, and(eq(contacts.id, accounts.contactId), eq(contacts.workspaceId, accounts.workspaceId)))
        .where(eq(accounts.workspaceId, workspaceId))
        .orderBy(asc(accounts.createdAt), asc(accounts.id)),

    listBankMovements: (workspaceId, to) =>
      db
        .select({ transactionId: transactions.id, accountId: transactions.accountId, bookingDate: transactions.bookingDate, amountCents: transactions.amountCents })
        .from(transactions)
        .innerJoin(accounts, and(eq(accounts.id, transactions.accountId), eq(accounts.workspaceId, transactions.workspaceId)))
        .where(and(eq(transactions.workspaceId, workspaceId), eq(accounts.type, "bank"), lte(transactions.bookingDate, to)))
        .orderBy(asc(transactions.bookingDate)),

    async listBankOpeningBalances(workspaceId) {
      const rows = await db
        .selectDistinctOn([importBatches.accountId], { accountId: importBatches.accountId, openingBalanceCents: importBatches.openingBalanceCents })
        .from(importBatches)
        .innerJoin(accounts, and(eq(accounts.id, importBatches.accountId), eq(accounts.workspaceId, importBatches.workspaceId)))
        .where(and(eq(importBatches.workspaceId, workspaceId), eq(accounts.type, "bank"), isNotNull(importBatches.openingBalanceCents), isNotNull(importBatches.statementFrom)))
        .orderBy(asc(importBatches.accountId), asc(importBatches.statementFrom));
      return new Map(rows.map((row) => [row.accountId, row.openingBalanceCents ?? 0]));
    },

    async listUnbookedBankTransactionIds(workspaceId, period) {
      const rows = await db
        .select({ id: transactions.id })
        .from(transactions)
        .innerJoin(accounts, and(eq(accounts.id, transactions.accountId), eq(accounts.workspaceId, transactions.workspaceId)))
        .where(
          and(
            eq(transactions.workspaceId, workspaceId),
            eq(accounts.type, "bank"),
            gte(transactions.bookingDate, period.from),
            lte(transactions.bookingDate, period.to),
            sql`not exists (select 1 from ${journalEntries} where ${journalEntries.workspaceId} = ${workspaceId} and ${journalEntries.transactionId} = ${transactions.id} and ${journalEntries.status} = 'booked')`,
          ),
        )
        .orderBy(asc(transactions.bookingDate));
      return rows.map((row) => row.id);
    },

    async listUnbookedDocumentIds(workspaceId, period) {
      const effectiveDate = sql`coalesce(${documents.documentDate}, ${documents.createdAt}::date)`;
      const effectiveKind = sql`coalesce(${documents.manualKind}, ${documents.kind})`;
      const rows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.workspaceId, workspaceId),
            eq(documents.status, "done"),
            sql`${documents.intakeStatus} <> 'rejected'`,
            sql`${effectiveKind} in (${sql.join(
              LEDGER_BOOKABLE_DOCUMENT_KINDS.map((kind) => sql`${kind}`),
              sql`, `,
            )})`,
            sql`${effectiveDate} between ${period.from}::date and ${period.to}::date`,
            sql`not exists (select 1 from ${journalEntries} where ${journalEntries.workspaceId} = ${workspaceId} and ${journalEntries.documentId} = ${documents.id} and (${journalEntries.status} = 'booked' or ${journalEntries.dismissedAt} is not null))`,
          ),
        )
        .orderBy(sql`${effectiveDate}`);
      return rows.map((row) => row.id);
    },
  };
}
