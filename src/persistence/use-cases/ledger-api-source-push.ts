// Owner: src/modules/ledger (decisions/0081-ledger-via-api.md, stage A). Before the ledger API
// proposes entries for a workspace switched to it, this pushes the workspace's current sources
// there: a full, idempotent snapshot, read through the owners' own read methods (never written)
// and sent with the API's upsert operations, keeping Digipost's ids.
//
// Order: counterparties (contacts), payment aliases, money accounts, movements (transactions),
// settlement lines, documents (their accounting view, exactly what `listForLedger` reads),
// confirmed movement-document links, then the "no document needed" rules and marks.
// Counterparties, aliases, settlement lines and documents are upserted in full every time (all
// idempotent, hundreds of rows); money accounts, movements, links and marks are diffed against
// what the API lists first, so only a change is written there.
//
// Every row keeps Digipost's id in the API: a bank account or movement created after the copy of
// decisions/0081's switch is created there with that id (`create_money_account` and
// `upsert_money_movements` accept one), since every link, entry and payment suggestion names it.
// Statement records (`import_batches`) are not pushed: the copy carries the existing ones, and the
// bank comparison of a newer statement is an open point in the ADR.
import { normalizeName } from "@/modules/contacts";
import type { AccountRow, ContactRow, LedgerDocumentRow, Repositories, SettlementLineRow, TransactionRow } from "@/persistence/repositories/contracts";

/** One API operation, already bound to the workspace's tenant and the push's actor. */
export type LedgerApiCall = <T = Record<string, unknown>>(operation: string, input: Record<string, unknown>) => Promise<T>;

export type SourcePushResult = {
  counterparties: number;
  paymentAliases: number;
  moneyAccounts: { created: number; updated: number };
  movements: { created: number; refreshed: number };
  settlementLines: { pushed: number; skipped: number };
  documents: number;
  links: { linked: number; unlinked: number; failed: number };
  noDocument: { rules: number; marked: number; cleared: number };
};

/** The API's largest batch for counterparties, documents and aliases (`MAX_BATCH`), and for
 * links and marks (`MAX_BULK_ENTRIES`). */
const BATCH = 500;
/** The API's largest page of a list operation. */
const PAGE = 200;

type Page<T> = { items: T[]; hasMore: boolean };
type ApiCounterparty = { id: string; verifiedAt: string | null };
type ApiMoneyAccount = { id: string; name: string; iban: string | null; bic: string | null; currency: string; holder: string | null };
type ApiMovement = { id: string; accountId: string; transferGroupId: string | null; sourceDocumentId: string | null; noDocumentNeeded: boolean };
type ApiDocument = { id: string; links: { transactionId: string; allocatedAmountCents: number }[] };

function chunks<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function listAll<T>(call: LedgerApiCall, operation: string, input: Record<string, unknown> = {}): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await call<Page<T>>(operation, { ...input, offset, limit: PAGE });
    items.push(...page.items);
    if (!page.hasMore || page.items.length === 0) return items;
  }
}

/** Free text cut to the API's maximum length (identity for every value within it), so one
 * over-long value never refuses a whole all-or-nothing batch. */
function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

const pattern = (regex: RegExp) => (value: string | null | undefined) => (value && regex.test(value) ? value : null);
const countryCode = pattern(/^[A-Z]{2}$/);
const currencyCode = pattern(/^[A-Z]{3}$/);

function counterpartyOf(contact: ContactRow, verified: boolean | undefined): Record<string, unknown> {
  return {
    id: contact.id,
    name: clip(contact.name, 300),
    legalForm: clip(contact.legalForm, 100),
    addressLine1: clip(contact.addressLine1, 300),
    addressLine2: clip(contact.addressLine2, 300),
    postalCode: clip(contact.postalCode, 20),
    city: clip(contact.city, 200),
    country: countryCode(contact.country),
    vatId: clip(contact.vatId, 30),
    taxNumber: clip(contact.taxNumber, 30),
    registerCourt: clip(contact.registerCourt, 200),
    registerNumber: clip(contact.registerNumber, 50),
    leitwegId: clip(contact.leitwegId, 50),
    iban: clip(contact.iban, 42),
    bic: clip(contact.bic, 11),
    bankName: clip(contact.bankName, 200),
    accountHolder: clip(contact.accountHolder, 200),
    sepaCreditorId: clip(contact.sepaCreditorId, 35),
    phone: clip(contact.phone, 50),
    email: clip(contact.email, 320),
    website: clip(contact.website, 300),
    contactPerson: clip(contact.contactPerson, 200),
    customerNumber: clip(contact.customerNumber, 50),
    supplierNumber: clip(contact.supplierNumber, 50),
    paymentTermsDays: contact.paymentTermsDays !== null && contact.paymentTermsDays >= 0 && contact.paymentTermsDays <= 365 ? contact.paymentTermsDays : null,
    relationType: contact.relationType,
    notes: clip(contact.notes, 2000),
    source: contact.source,
    // Only a change is sent: `verified: true` stamps "now" in the API, so repeating it on every
    // push would move the verification date each time.
    ...(verified === undefined ? {} : { verified }),
  };
}

function movementOf(tx: TransactionRow): Record<string, unknown> {
  return {
    id: tx.id,
    externalId: tx.idempotencyKey,
    bookingDate: tx.bookingDate,
    valueDate: tx.valueDate,
    amountCents: tx.amountCents,
    currency: currencyCode(tx.currency),
    counterpartyName: clip(tx.counterpartyName, 300),
    counterpartyIban: clip(tx.counterpartyIban, 42),
    counterpartyBic: clip(tx.counterpartyBic, 11),
    remittanceText: clip(tx.remittanceText, 1000),
    endToEndId: clip(tx.endToEndId, 100),
    mandateId: clip(tx.mandateId, 100),
    creditorId: clip(tx.creditorId, 100),
    bankTxCode: clip(tx.bankTxCode, 100),
    bankReference: clip(tx.bankReference, 200),
    transferGroupId: tx.transferGroupId,
    sourceDocumentId: tx.sourceDocumentId,
  };
}

function documentOf(doc: LedgerDocumentRow, counterpartyIds: ReadonlySet<string>, appUrl: string | null): Record<string, unknown> {
  return {
    id: doc.id,
    kind: doc.kind,
    direction: doc.direction,
    title: clip(doc.title, 300),
    sender: clip(doc.sender, 300),
    summary: clip(doc.summary, 2000),
    originalFileName: clip(doc.originalFileName, 300),
    fileUrl: appUrl ? `${appUrl.replace(/\/+$/, "")}/dashboard/documents/${doc.id}` : null,
    invoiceNumber: clip(doc.invoiceNumber, 100),
    documentDate: doc.documentDate,
    serviceDate: doc.serviceDate,
    servicePeriodFrom: doc.servicePeriodFrom,
    servicePeriodTo: doc.servicePeriodTo,
    currency: currencyCode(doc.currency),
    totalAmountCents: doc.totalAmountCents,
    netTotalCents: doc.netTotalCents,
    taxTotalCents: doc.taxTotalCents,
    passThroughCents: doc.passThroughCents,
    taxBreakdown: doc.taxBreakdown ? doc.taxBreakdown.slice(0, 10) : null,
    reverseCharge: doc.reverseCharge,
    platform: clip(doc.platform, 50),
    counterpartyId: doc.contactId && counterpartyIds.has(doc.contactId) ? doc.contactId : null,
  };
}

function settlementLineOf(line: SettlementLineRow, presentMovements: ReadonlySet<string>): Record<string, unknown> {
  return {
    id: line.id,
    clearingAccountId: line.clearingAccountId,
    sourceDocumentId: line.sourceDocumentId,
    transactionId: line.transactionId && presentMovements.has(line.transactionId) ? line.transactionId : null,
    type: line.type,
    externalLineId: clip(line.externalLineId, 200),
    grossCents: line.grossCents,
    feeCents: line.feeCents,
    netCents: line.netCents,
    currency: currencyCode(line.currency),
    bookingDate: line.bookingDate,
    payoutId: clip(line.payoutId, 200),
    chargeId: clip(line.chargeId, 200),
    invoiceId: clip(line.invoiceId, 200),
    customerName: clip(line.customerName, 300),
    customerEmail: clip(line.customerEmail, 300),
    productName: clip(line.productName, 300),
    countryOfSale: clip(line.countryOfSale, 10),
  };
}

/**
 * `upsert_settlement_lines`: a platform report's lines on their clearing account, idempotent by
 * (report document, external line id), keeping Digipost's line id; a line pushed again keeps its
 * movement link when `transactionId` is null. Kept in this one function (with
 * `settlementLineOf`) so the operation's input shape is easy to adjust.
 */
export async function upsertSettlementLines(call: LedgerApiCall, lines: readonly Record<string, unknown>[]): Promise<number> {
  for (const batch of chunks(lines)) await call("upsert_settlement_lines", { lines: batch });
  return lines.length;
}

async function allTransactions(repos: Repositories, workspaceId: string, accountId: string): Promise<TransactionRow[]> {
  const rows: TransactionRow[] = [];
  for (let page = 1; ; page++) {
    const result = await repos.transaction.list(workspaceId, accountId, { page, pageSize: BATCH });
    rows.push(...result.items);
    if (!result.hasMore) return rows;
  }
}

function accountChanged(digipost: AccountRow, api: ApiMoneyAccount): boolean {
  const code = (value: string | null) => (value ? value.toUpperCase().replace(/\s+/g, "") : null);
  return digipost.name !== api.name || code(digipost.iban) !== code(api.iban) || (digipost.bic ?? null) !== (api.bic ?? null) || digipost.currency !== api.currency || (digipost.holder ?? null) !== (api.holder ?? null);
}

const pairKey = (documentId: string, transactionId: string) => `${documentId}:${transactionId}`;

export async function pushLedgerSources(deps: { repos: Repositories; call: LedgerApiCall; appUrl?: string | null }, workspaceId: string): Promise<SourcePushResult> {
  const { repos, call } = deps;
  const result: SourcePushResult = {
    counterparties: 0,
    paymentAliases: 0,
    moneyAccounts: { created: 0, updated: 0 },
    movements: { created: 0, refreshed: 0 },
    settlementLines: { pushed: 0, skipped: 0 },
    documents: 0,
    links: { linked: 0, unlinked: 0, failed: 0 },
    noDocument: { rules: 0, marked: 0, cleared: 0 },
  };

  const [contacts, aliases, noDocumentRules, accounts, documents, ledgerSettlementLines] = await Promise.all([
    repos.contact.listAllForWorkspace(workspaceId),
    repos.paymentAlias.listForWorkspace(workspaceId),
    repos.paymentNoDocumentRule.listForWorkspace(workspaceId),
    repos.account.listForWorkspace(workspaceId),
    repos.document.listForLedger(workspaceId),
    repos.settlementLine.listForLedger(workspaceId),
  ]);

  // --- Counterparties ---------------------------------------------------------------------------
  const apiCounterparties = new Map((await listAll<ApiCounterparty>(call, "list_counterparties")).map((row) => [row.id, row]));
  const pushableContacts = contacts.filter((contact) => contact.name.trim().length > 0);
  const counterparties = pushableContacts.map((contact) => {
    const verified = contact.verifiedAt !== null;
    const known = apiCounterparties.get(contact.id);
    const apiVerified = known ? known.verifiedAt !== null : false;
    return counterpartyOf(contact, verified === apiVerified ? undefined : verified);
  });
  for (const batch of chunks(counterparties)) await call("upsert_counterparties", { counterparties: batch });
  result.counterparties = counterparties.length;
  const counterpartyIds = new Set(pushableContacts.map((contact) => contact.id));

  // --- Payment aliases --------------------------------------------------------------------------
  const aliasInput = [...new Map(aliases.filter((alias) => alias.counterpartyNameNormalized.trim().length > 0 && counterpartyIds.has(alias.contactId)).map((alias) => [alias.counterpartyNameNormalized, alias])).values()].map((alias) => ({
    counterpartyName: clip(alias.counterpartyNameNormalized, 300),
    counterpartyId: alias.contactId,
  }));
  for (const batch of chunks(aliasInput)) await call("upsert_payment_aliases", { aliases: batch });
  result.paymentAliases = aliasInput.length;

  // --- Money accounts ---------------------------------------------------------------------------
  const apiAccounts = new Map((await call<{ accounts: ApiMoneyAccount[] }>("list_money_accounts", {})).accounts.map((account) => [account.id, account]));
  const presentAccounts: AccountRow[] = [];
  for (const account of accounts) {
    const known = apiAccounts.get(account.id);
    // A clearing account owned by a supplier the API does not hold cannot be created there.
    if (!known && account.contactId && !counterpartyIds.has(account.contactId)) continue;
    presentAccounts.push(account);
    if (!known) {
      await call("create_money_account", {
        id: account.id,
        type: account.type,
        name: clip(account.name, 200),
        iban: clip(account.iban, 42),
        bic: clip(account.bic, 11),
        currency: account.currency,
        holder: clip(account.holder, 200),
        platform: account.platform,
        counterpartyId: account.contactId,
      });
      result.moneyAccounts.created++;
      continue;
    }
    if (!accountChanged(account, known)) continue;
    await call("update_money_account", { id: account.id, name: clip(account.name, 200), iban: clip(account.iban, 42), bic: clip(account.bic, 11), currency: account.currency, holder: clip(account.holder, 200) });
    result.moneyAccounts.updated++;
  }
  const presentAccountIds = new Set(presentAccounts.map((account) => account.id));

  // --- Movements --------------------------------------------------------------------------------
  const presentMovements = new Map<string, ApiMovement>();
  const digipostMovements = new Map<string, TransactionRow>();
  for (const account of presentAccounts) {
    const [ours, theirs] = await Promise.all([allTransactions(repos, workspaceId, account.id), listAll<ApiMovement>(call, "list_money_movements", { accountId: account.id })]);
    const known = new Map(theirs.map((movement) => [movement.id, movement]));
    const refresh: TransactionRow[] = [];
    const create: TransactionRow[] = [];
    for (const tx of ours) {
      digipostMovements.set(tx.id, tx);
      const movement = known.get(tx.id);
      if (!movement) {
        create.push(tx);
        // As the API stores a new movement: unmarked; the marks below then set Digipost's.
        presentMovements.set(tx.id, { id: tx.id, accountId: account.id, transferGroupId: tx.transferGroupId, sourceDocumentId: tx.sourceDocumentId, noDocumentNeeded: false });
        continue;
      }
      presentMovements.set(tx.id, movement);
      // The payout pairing (decisions/0026/0048/0068) and the statement document are set after
      // the import; the API keeps a stored value when null is sent, so only a new one is pushed.
      const groupChanged = tx.transferGroupId !== null && tx.transferGroupId !== movement.transferGroupId;
      const sourceChanged = tx.sourceDocumentId !== null && tx.sourceDocumentId !== movement.sourceDocumentId;
      if (groupChanged || sourceChanged) refresh.push(tx);
    }
    for (const batch of chunks([...create, ...refresh], 1000)) await call("upsert_money_movements", { accountId: account.id, movements: batch.map(movementOf) });
    result.movements.created += create.length;
    result.movements.refreshed += refresh.length;
  }

  // --- Settlement lines -------------------------------------------------------------------------
  const reportDocumentIds = [...new Set(ledgerSettlementLines.map((line) => line.sourceDocumentId))];
  const settlementLines = (await Promise.all(reportDocumentIds.map((documentId) => repos.settlementLine.listForDocument(workspaceId, documentId)))).flat();
  const pushableLines = settlementLines.filter((line) => presentAccountIds.has(line.clearingAccountId));
  result.settlementLines.skipped = settlementLines.length - pushableLines.length;
  result.settlementLines.pushed = await upsertSettlementLines(
    call,
    pushableLines.map((line) => settlementLineOf(line, new Set(presentMovements.keys()))),
  );

  // --- Documents --------------------------------------------------------------------------------
  // Only analyzed documents: a document still in processing has no accounting view yet, and the
  // proposal engine books only `done` ones.
  const doneDocuments = documents.filter((doc) => doc.status === "done");
  const pushedDocumentIds = new Set(doneDocuments.map((doc) => doc.id));
  for (const batch of chunks(doneDocuments)) await call("upsert_documents", { documents: batch.map((doc) => documentOf(doc, counterpartyIds, deps.appUrl ?? null)) });
  result.documents = doneDocuments.length;

  // --- Confirmed links --------------------------------------------------------------------------
  const wanted = new Map<string, { documentId: string; movementId: string; allocatedAmountCents: number }>();
  for (const doc of documents) {
    for (const link of doc.confirmedTransactions) {
      if (!presentMovements.has(link.transactionId)) continue;
      wanted.set(pairKey(doc.id, link.transactionId), { documentId: doc.id, movementId: link.transactionId, allocatedAmountCents: link.allocatedAmountCents });
    }
  }
  const existing = new Map<string, number>();
  for (const doc of await listAll<ApiDocument>(call, "list_documents")) for (const link of doc.links) existing.set(pairKey(doc.id, link.transactionId), link.allocatedAmountCents);

  // Removed first, so a reallocated movement has its cents free again.
  for (const key of existing.keys()) {
    if (wanted.has(key)) continue;
    const [documentId, movementId] = key.split(":") as [string, string];
    await call("unlink_movement_document", { documentId, movementId });
    result.links.unlinked++;
  }
  const toLink = [...wanted.entries()].filter(([key, link]) => pushedDocumentIds.has(link.documentId) && existing.get(key) !== link.allocatedAmountCents).map(([, link]) => link);
  for (const batch of chunks(toLink)) {
    try {
      await call("link_movement_documents", { links: batch.map((link) => ({ ...link, matchedBy: "user" })) });
      result.links.linked += batch.length;
    } catch {
      // All or nothing: one refused link (an allocation the API counts differently, a
      // direction mismatch) must not hold back the others, so the batch is retried one by one.
      for (const link of batch) {
        try {
          await call("link_movement_documents", { links: [{ ...link, matchedBy: "user" }] });
          result.links.linked++;
        } catch {
          result.links.failed++;
        }
      }
    }
  }

  // --- No document needed -----------------------------------------------------------------------
  // The standing rules first: the API stores one per counterparty name and marks that name's
  // unexplained movements at once. Then every movement's own mark is set to Digipost's, which
  // also clears what a rule marked but Digipost did not (Digipost applies its rules when
  // proposing, not by marking), so both end in the same state.
  const apiMarked = new Map([...presentMovements].map(([id, movement]) => [id, movement.noDocumentNeeded]));
  for (const rule of noDocumentRules) {
    const example = [...digipostMovements.values()].find((tx) => tx.counterpartyName !== null && normalizeName(tx.counterpartyName) === rule.counterpartyNameNormalized);
    if (!example) continue;
    const answer = await call<{ alsoMarked?: string[] }>("set_no_document_needed", { movementIds: [example.id], noDocumentNeeded: true, forCounterparty: true });
    apiMarked.set(example.id, true);
    for (const id of answer.alsoMarked ?? []) apiMarked.set(id, true);
    result.noDocument.rules++;
  }
  const toMark: string[] = [];
  const toClear: string[] = [];
  for (const [id, tx] of digipostMovements) {
    const marked = apiMarked.get(id) ?? false;
    if (tx.noDocumentNeeded && !marked) toMark.push(id);
    if (!tx.noDocumentNeeded && marked) toClear.push(id);
  }
  for (const batch of chunks(toMark)) await call("set_no_document_needed", { movementIds: batch, noDocumentNeeded: true });
  for (const batch of chunks(toClear)) await call("set_no_document_needed", { movementIds: batch, noDocumentNeeded: false });
  result.noDocument.marked = toMark.length;
  result.noDocument.cleared = toClear.length;

  return result;
}
