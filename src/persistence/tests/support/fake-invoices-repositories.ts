// Typed in-memory fake for `InvoiceRepository` (WEBAPP_TEMPLATE_SPEC.md §10.2), owner
// src/modules/invoicing (decisions/0079-outgoing-invoices.md). Like the real tables it offers no
// way to change or remove an issued row. `snapshot`/`restore` let a test's Unit of Work roll the
// fake back when a transaction throws, the way Postgres would.
import type { InvoiceDraftRow, InvoiceEventRow, InvoiceRepository, InvoiceRow } from "@/persistence/repositories/contracts";

type State = { drafts: InvoiceDraftRow[]; invoices: InvoiceRow[]; events: InvoiceEventRow[]; sequences: Map<string, number> };

export function createFakeInvoiceRepository(): {
  repo: InvoiceRepository;
  state: State;
  snapshot(): State;
  restore(snapshot: State): void;
} {
  const state: State = { drafts: [], invoices: [], events: [], sequences: new Map() };

  function withCounterpart(row: InvoiceRow) {
    const cancellation = state.invoices.find((other) => other.workspaceId === row.workspaceId && other.cancelsInvoiceId === row.id) ?? null;
    const original = row.cancelsInvoiceId ? (state.invoices.find((other) => other.workspaceId === row.workspaceId && other.id === row.cancelsInvoiceId) ?? null) : null;
    return { ...row, cancelledById: cancellation?.id ?? null, cancelledByNumber: cancellation?.number ?? null, cancelsNumber: original?.number ?? null };
  }

  const repo: InvoiceRepository = {
    async createDraft(input) {
      const at = new Date();
      const row: InvoiceDraftRow = { id: crypto.randomUUID(), createdAt: at, updatedAt: at, ...input };
      state.drafts.push(row);
      return row;
    },
    async findDraft(workspaceId, id) {
      return state.drafts.find((row) => row.workspaceId === workspaceId && row.id === id) ?? null;
    },
    async listDrafts(workspaceId) {
      return state.drafts.filter((row) => row.workspaceId === workspaceId);
    },
    async updateDraft(workspaceId, id, patch) {
      const row = state.drafts.find((draft) => draft.workspaceId === workspaceId && draft.id === id);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: new Date() });
      return row;
    },
    async deleteDraft(workspaceId, id) {
      const index = state.drafts.findIndex((row) => row.workspaceId === workspaceId && row.id === id);
      if (index < 0) return false;
      state.drafts.splice(index, 1);
      return true;
    },
    async allocateSequence(workspaceId, year) {
      const key = `${workspaceId}:${year}`;
      const next = (state.sequences.get(key) ?? 0) + 1;
      state.sequences.set(key, next);
      return next;
    },
    async insertInvoice(input) {
      if (state.invoices.some((row) => row.workspaceId === input.workspaceId && row.number === input.number)) throw new Error("duplicate invoice number");
      const row: InvoiceRow = { ...input, createdAt: new Date() };
      state.invoices.push(row);
      return row;
    },
    async findInvoice(workspaceId, id) {
      const row = state.invoices.find((invoice) => invoice.workspaceId === workspaceId && invoice.id === id);
      return row ? withCounterpart(row) : null;
    },
    async findCancellationOf(workspaceId, invoiceId) {
      return state.invoices.find((row) => row.workspaceId === workspaceId && row.cancelsInvoiceId === invoiceId) ?? null;
    },
    async listInvoices(workspaceId, limit) {
      return state.invoices
        .filter((row) => row.workspaceId === workspaceId)
        .sort((a, b) => b.year - a.year || b.sequence - a.sequence)
        .slice(0, limit)
        .map(withCounterpart);
    },
    async countInvoices(workspaceId) {
      return state.invoices.filter((row) => row.workspaceId === workspaceId).length;
    },
    async listForArchive(workspaceId) {
      return state.invoices
        .filter((row) => row.workspaceId === workspaceId)
        .sort((a, b) => a.year - b.year || a.sequence - b.sequence)
        .map(({ id, number, type, pdfStorageKey, xmlStorageKey }) => ({ id, number, type, pdfStorageKey, xmlStorageKey }));
    },
    async insertEvent(input) {
      state.events.push({ id: crypto.randomUUID(), createdAt: new Date(), ...input });
    },
    async listEvents(workspaceId, invoiceId) {
      return state.events.filter((row) => row.workspaceId === workspaceId && row.invoiceId === invoiceId);
    },
  };

  return {
    repo,
    state,
    snapshot: () => ({
      drafts: state.drafts.map((row) => ({ ...row })),
      invoices: [...state.invoices],
      events: [...state.events],
      sequences: new Map(state.sequences),
    }),
    restore(snapshot) {
      state.drafts.splice(0, state.drafts.length, ...snapshot.drafts);
      state.invoices.splice(0, state.invoices.length, ...snapshot.invoices);
      state.events.splice(0, state.events.length, ...snapshot.events);
      state.sequences.clear();
      for (const [key, value] of snapshot.sequences) state.sequences.set(key, value);
    },
  };
}
