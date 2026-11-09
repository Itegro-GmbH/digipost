// Owner: src/modules/invoicing (decisions/0079-outgoing-invoices.md). Writing invoices: drafts,
// "Festschreiben" (finalizing a draft into a numbered, immutable invoice) and the full
// cancellation ("Stornorechnung") of an issued one.
//
// GoBD, and why the two write paths look the way they do: an issued invoice is never changed.
// Finalizing and cancelling both run in ONE transaction that locks the workspace row, takes the
// next number of the year (`allocateSequence`, whose row stays locked until commit), renders the
// PDF/XML with that number, stores both, creates the inbox document
// (`DocumentUseCases.createForIssuedInvoice`, the same quota rules as an upload), and inserts the
// invoice and its audit event. If anything fails, the whole transaction rolls back, the number
// goes back to the range (no gap), and the objects already written are deleted again. The
// database refuses any later UPDATE/DELETE of `invoices`/`invoice_events`
// (`src/persistence/sql/invoices_append_only/`).
//
// The PDF is rendered while the workspace row is locked, because the number printed on it is
// only final once the transaction commits. That holds back a concurrent upload in the same
// workspace for the render time (well under a second once the rule sets are loaded): accepted,
// since the alternative, numbering after rendering, would either leave gaps or print a number
// that might never commit.
//
// Neutral-Entrypoint-Regel (WEBAPP_TEMPLATE_SPEC.md §5.4): only `Repositories`/`UnitOfWork`, the
// injected `ObjectStorage` and `InvoiceRenderer` ports, the sibling `DocumentUseCases`, and pure
// logic from `@/modules/invoicing`/`@/modules/intake` neutral entrypoints. Every method takes the
// caller's own resolved workspace id, never one from client input.
import type { InvoiceInput } from "@itegro/einvoice";

import type { ExtractedContactData } from "@/modules/contacts";
import { fileHash } from "@/modules/intake";
import {
  buildCancellationInput,
  buildInvoiceInput,
  checkDraft,
  emptyDraftContent,
  formatInvoiceNumber,
  INVOICE_CURRENCY,
  invoiceDraftContentSchema,
  invoiceFileName,
  InvoiceValidationError,
  issueDateFor,
  missingSellerFields,
  parseStoredDraftContent,
  yearOfIsoDate,
  type InvoiceContactOption,
  type InvoiceDraftContent,
  type InvoiceDraftListItem,
  type InvoiceDraftView,
  type InvoiceRenderer,
  type InvoiceSellerSummary,
  type InvoiceTotalsCents,
  type InvoiceType,
  type InvoiceViolation,
  type IssuedInvoiceListItem,
  type IssuedInvoiceView,
  type SellerProfile,
  type SellerMissingField,
} from "@/modules/invoicing";
import { isDbError } from "@/persistence/foundation/db-errors";
import type { InvoiceDraftRow, InvoiceWithCounterpart, Repositories, UnitOfWork, WorkspaceRow } from "@/persistence/repositories/contracts";
import type { DocumentUseCases } from "@/persistence/use-cases/documents-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { invoiceFileKey, type ObjectStorage } from "@/platform/object-storage";

export const INVOICE_ERROR = {
  notFound: "not_found",
  /** The company profile lacks what section 14 UStG requires of the issuer. */
  companyProfileIncomplete: "company_profile_incomplete",
  /** The draft is not a valid invoice yet. Thrown as `InvoiceInvalidError`, which carries the
   * violations for the editor. */
  invoiceInvalid: "invoice_invalid",
  alreadyCancelled: "already_cancelled",
  /** A cancellation itself cannot be cancelled again. */
  notCancellable: "not_cancellable",
} as const;
export type InvoiceErrorCode = (typeof INVOICE_ERROR)[keyof typeof INVOICE_ERROR];

export class InvoiceInvalidError extends UseCaseError<typeof INVOICE_ERROR.invoiceInvalid> {
  constructor(readonly violations: readonly InvoiceViolation[]) {
    super(INVOICE_ERROR.invoiceInvalid);
  }
}

/** The list on `/dashboard/invoices`. A small business issues a few hundred invoices a year;
 * the archive download, not this list, is the way to get all of them. */
export const INVOICE_LIST_LIMIT = 500;

/** How many contacts the editor's picker offers (a small business's own contact book). */
const CONTACT_PICKER_LIMIT = 500;

/** The number shown on a draft preview, which has none yet. */
const DRAFT_PREVIEW_NUMBER = "ENTWURF";

export type InvoiceDraftCheck = {
  violations: InvoiceViolation[];
  totals: InvoiceTotalsCents | null;
  sellerMissing: SellerMissingField[];
};

export type InvoiceFile = { bytes: Uint8Array; fileName: string; contentType: string };

export type InvoiceArchiveEntry = { name: string; bytes: Uint8Array };

export interface InvoiceUseCases {
  getEditorContext(workspaceId: string): Promise<{ seller: InvoiceSellerSummary; contacts: InvoiceContactOption[] }>;
  listDrafts(workspaceId: string): Promise<InvoiceDraftListItem[]>;
  getDraft(workspaceId: string, draftId: string): Promise<InvoiceDraftView | null>;
  createDraft(input: { workspaceId: string; userId: string }): Promise<{ id: string }>;
  updateDraft(input: { workspaceId: string; draftId: string; content: InvoiceDraftContent }): Promise<InvoiceDraftView>;
  deleteDraft(workspaceId: string, draftId: string): Promise<void>;
  /** "Prüfen": our own checks plus the library's, and the totals as the library computes them. */
  checkDraft(workspaceId: string, draftId: string): Promise<InvoiceDraftCheck>;
  /** The draft as a PDF with an "ENTWURF" watermark and no number. Throws `InvoiceInvalidError`
   * when it cannot be rendered yet. */
  renderDraftPreview(workspaceId: string, draftId: string): Promise<Uint8Array>;
  /** "Festschreiben": see this file's header. */
  finalizeDraft(input: { workspaceId: string; draftId: string; userId: string; userEmail: string }): Promise<{ invoiceId: string }>;
  /** "Stornieren": the full cancellation of an issued invoice, as a new numbered invoice. */
  cancelInvoice(input: { workspaceId: string; invoiceId: string; userId: string; userEmail: string }): Promise<{ invoiceId: string }>;
  listInvoices(workspaceId: string): Promise<IssuedInvoiceListItem[]>;
  getInvoice(workspaceId: string, invoiceId: string): Promise<IssuedInvoiceView | null>;
  getInvoiceFile(workspaceId: string, invoiceId: string, format: "pdf" | "xml"): Promise<InvoiceFile | null>;
  /** Every issued invoice's PDF and XML, oldest number first, one at a time (the archive ZIP). */
  archiveEntries(workspaceId: string): AsyncGenerator<InvoiceArchiveEntry>;
  /** How many invoices this workspace has issued (the workspace deletion's confirmation). */
  countIssued(workspaceId: string): Promise<number>;
}

export type InvoiceUseCaseDeps = {
  repos: Repositories;
  uow: UnitOfWork;
  objectStorage: ObjectStorage;
  renderer: InvoiceRenderer;
  documents: DocumentUseCases;
  now?: () => Date;
  generateId?: () => string;
};

function toSellerProfile(workspace: WorkspaceRow): SellerProfile {
  return {
    name: workspace.name,
    addressLine1: workspace.companyAddressLine1,
    addressLine2: workspace.companyAddressLine2,
    postalCode: workspace.companyPostalCode,
    city: workspace.companyCity,
    country: workspace.companyCountry,
    vatId: workspace.companyVatId,
    taxNumber: workspace.companyTaxNumber,
    registerCourt: workspace.companyRegisterCourt,
    registerNumber: workspace.companyRegisterNumber,
    ibans: workspace.companyIbans,
  };
}

function toDraftView(row: InvoiceDraftRow): InvoiceDraftView {
  return { id: row.id, content: parseStoredDraftContent(row.content), updatedAt: row.updatedAt.toISOString() };
}

function toListItem(row: InvoiceWithCounterpart): IssuedInvoiceListItem {
  return {
    id: row.id,
    number: row.number,
    type: row.type,
    issueDate: row.issueDate,
    buyerName: row.buyerName,
    grossCents: row.grossCents,
    currency: row.currency,
    cancelledByNumber: row.cancelledByNumber,
    cancelsNumber: row.cancelsNumber,
  };
}

/** The buyer of an issued invoice, as the contact linking expects it. */
function buyerAsContact(input: InvoiceInput): ExtractedContactData {
  const { buyer } = input;
  return {
    name: buyer.name,
    addressLine1: buyer.address.street,
    addressLine2: buyer.address.street2 ?? null,
    postalCode: buyer.address.postalCode,
    city: buyer.address.city,
    country: buyer.address.country,
    vatId: buyer.vatId ?? null,
    email: buyer.contact?.email ?? null,
  };
}

/** What the inbox's search finds an issued invoice by. */
function searchTextOf(input: InvoiceInput): string {
  return [input.number, input.buyer.name, ...(input.notes ?? []), ...input.lines.map((line) => [line.name, line.description].filter(Boolean).join(" "))].join("\n");
}

const textEncoder = new TextEncoder();

export function createInvoiceUseCases(deps: InvoiceUseCaseDeps): InvoiceUseCases {
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? (() => crypto.randomUUID());

  async function requireWorkspace(workspaceId: string): Promise<WorkspaceRow> {
    const workspace = await deps.repos.workspace.findById(workspaceId);
    if (!workspace) throw new UseCaseError(INVOICE_ERROR.notFound);
    return workspace;
  }

  async function requireDraft(workspaceId: string, draftId: string): Promise<InvoiceDraftRow> {
    const draft = await deps.repos.invoice.findDraft(workspaceId, draftId);
    if (!draft) throw new UseCaseError(INVOICE_ERROR.notFound);
    return draft;
  }

  /** The draft as it would be issued today, with a stand-in number. */
  function draftInput(seller: SellerProfile, content: InvoiceDraftContent, number: string): InvoiceInput {
    return buildInvoiceInput({ number, issueDate: issueDateFor(now()), seller, content });
  }

  async function check(seller: SellerProfile, content: InvoiceDraftContent): Promise<InvoiceDraftCheck> {
    const own = checkDraft(content);
    const library = await deps.renderer.check(draftInput(seller, content, DRAFT_PREVIEW_NUMBER));
    return { violations: [...own, ...library.violations], totals: library.totals, sellerMissing: missingSellerFields(seller) };
  }

  /** Removes objects written by a transaction that then failed. Best effort: an orphaned object
   * under the workspace prefix is harmless and goes with the workspace at the latest. */
  async function discard(keys: string[]): Promise<void> {
    await Promise.all(
      keys.map((key) =>
        deps.objectStorage.deleteObject(key).catch((err: unknown) => {
          console.error("[invoicing] failed to delete an object after a failed transaction", { key, err });
        }),
      ),
    );
  }

  type IssueInput = {
    workspaceId: string;
    type: InvoiceType;
    userId: string;
    userEmail: string;
    /** Builds the input once the number is known, from the transaction-bound repositories. */
    build: (repos: Repositories, number: string, issueDate: string) => Promise<{ input: InvoiceInput; contactId: string | null; cancels: InvoiceWithCounterpart | null }>;
    /** Runs inside the transaction once the invoice row exists (drafts deleted, events added). */
    after: (repos: Repositories, invoiceId: string, cancels: InvoiceWithCounterpart | null) => Promise<void>;
  };

  /** The one write path both finalizing and cancelling go through (see this file's header). */
  async function issue({ workspaceId, type, userId, userEmail, build, after }: IssueInput): Promise<{ invoiceId: string }> {
    await deps.documents.precheckQuota(workspaceId);

    const invoiceId = generateId();
    const written: string[] = [];
    let documentId: string;
    let buyer: ExtractedContactData;
    try {
      ({ documentId, buyer } = await deps.uow.transaction(async (repos) => {
        const workspace = await repos.workspace.lockForUpdate(workspaceId);
        if (!workspace) throw new UseCaseError(INVOICE_ERROR.notFound);

        const issueDate = issueDateFor(now());
        const year = yearOfIsoDate(issueDate);
        const sequence = await repos.invoice.allocateSequence(workspaceId, year);
        const number = formatInvoiceNumber(year, sequence);
        const { input, contactId, cancels } = await build(repos, number, issueDate);

        const rendered = await deps.renderer.render(input);
        const xmlBytes = textEncoder.encode(rendered.xml);
        const pdfStorageKey = invoiceFileKey({ workspaceId, invoiceId, format: "pdf" });
        const xmlStorageKey = invoiceFileKey({ workspaceId, invoiceId, format: "xml" });
        await deps.objectStorage.putObject({ key: pdfStorageKey, body: rendered.pdf, contentType: "application/pdf" });
        written.push(pdfStorageKey);
        await deps.objectStorage.putObject({ key: xmlStorageKey, body: xmlBytes, contentType: "application/xml" });
        written.push(xmlStorageKey);

        const document = await deps.documents.createForIssuedInvoice(repos, {
          workspaceId,
          issuedByUserId: userId,
          fileName: invoiceFileName({ number, type, format: "pdf" }),
          pdfBytes: rendered.pdf,
          pageCount: rendered.pageCount,
          invoiceNumber: number,
          issueDate,
          dueDate: input.dueDate ?? null,
          totalAmountCents: rendered.totals.grossCents,
          currency: input.currency ?? INVOICE_CURRENCY,
          paymentIban: input.payment?.iban ?? null,
          sellerName: input.seller.name,
          title: type === "invoice" ? `Rechnung ${number}` : `Stornorechnung ${number} zu Rechnung ${cancels?.number ?? ""}`.trim(),
          summary:
            type === "invoice"
              ? `Ausgangsrechnung ${number} an ${input.buyer.name}, in Digipost ausgestellt.`
              : `Stornorechnung ${number} an ${input.buyer.name}, storniert Rechnung ${cancels?.number ?? ""} vollständig.`,
          searchText: searchTextOf(input),
          cancelsDocumentId: cancels?.documentId ?? null,
        });
        written.push(document.storageKey);

        await repos.invoice.insertInvoice({
          id: invoiceId,
          workspaceId,
          number,
          year,
          sequence,
          type,
          cancelsInvoiceId: cancels?.id ?? null,
          issueDate,
          dueDate: type === "invoice" ? (input.dueDate ?? null) : null,
          currency: input.currency ?? INVOICE_CURRENCY,
          netCents: rendered.totals.netCents,
          vatCents: rendered.totals.vatCents,
          grossCents: rendered.totals.grossCents,
          buyerName: input.buyer.name,
          contactId,
          einvoiceInput: input,
          pdfStorageKey,
          xmlStorageKey,
          pdfSha256: fileHash(rendered.pdf),
          xmlSha256: fileHash(xmlBytes),
          documentId: document.documentId,
          createdByUserId: userId,
          createdByEmail: userEmail,
        });
        await repos.invoice.insertEvent({ workspaceId, invoiceId, kind: "issued", relatedInvoiceId: cancels?.id ?? null, actorUserId: userId, actorEmail: userEmail });
        await after(repos, invoiceId, cancels);

        return { documentId: document.documentId, buyer: buyerAsContact(input) };
      }));
    } catch (err) {
      await discard(written);
      if (err instanceof InvoiceValidationError) throw new InvoiceInvalidError(err.violations);
      // The partial unique index on `cancels_invoice_id`: a second cancellation of the same
      // invoice that raced past the check inside the transaction.
      if (isDbError(err, "unique") && type === "cancellation") throw new UseCaseError(INVOICE_ERROR.alreadyCancelled);
      throw err;
    }

    await deps.documents.linkIssuedInvoiceCounterparty({ workspaceId, documentId, buyer });
    return { invoiceId };
  }

  return {
    async getEditorContext(workspaceId) {
      const workspace = await requireWorkspace(workspaceId);
      const seller = toSellerProfile(workspace);
      const contacts = await deps.repos.contact.list(workspaceId, { page: 1, pageSize: CONTACT_PICKER_LIMIT });
      return {
        seller: { name: seller.name, ibans: seller.ibans, missing: missingSellerFields(seller) },
        contacts: contacts.items.map((contact) => ({
          id: contact.id,
          name: contact.name,
          addressLine1: contact.addressLine1,
          addressLine2: contact.addressLine2,
          postalCode: contact.postalCode,
          city: contact.city,
          country: contact.country,
          vatId: contact.vatId,
          email: contact.email,
        })),
      };
    },

    async listDrafts(workspaceId) {
      const workspace = await requireWorkspace(workspaceId);
      const seller = toSellerProfile(workspace);
      const rows = await deps.repos.invoice.listDrafts(workspaceId);
      return Promise.all(
        rows.map(async (row) => {
          const content = parseStoredDraftContent(row.content);
          const { totals } = await deps.renderer.check(draftInput(seller, content, DRAFT_PREVIEW_NUMBER));
          return { id: row.id, buyerName: content.buyer.name, grossCents: totals?.grossCents ?? null, lineCount: content.lines.length, updatedAt: row.updatedAt.toISOString() };
        }),
      );
    },

    async getDraft(workspaceId, draftId) {
      const row = await deps.repos.invoice.findDraft(workspaceId, draftId);
      return row ? toDraftView(row) : null;
    },

    async createDraft({ workspaceId, userId }) {
      const workspace = await requireWorkspace(workspaceId);
      const content = emptyDraftContent();
      content.paymentIban = workspace.companyIbans[0] ?? "";
      const row = await deps.repos.invoice.createDraft({ workspaceId, createdByUserId: userId, contactId: null, content });
      return { id: row.id };
    },

    async updateDraft({ workspaceId, draftId, content }) {
      // Re-validated here as well: the use case is the last line of defense (§5.4).
      const parsed = invoiceDraftContentSchema.safeParse(content);
      if (!parsed.success) throw new InvoiceInvalidError([{ rule: "DP-INV-000", path: "", message: "The draft does not have the expected shape." }]);
      // A contact id from the client is only kept when it names a contact of THIS workspace.
      const contactId = parsed.data.contactId ? ((await deps.repos.contact.findById(workspaceId, parsed.data.contactId))?.id ?? null) : null;
      const row = await deps.repos.invoice.updateDraft(workspaceId, draftId, { contactId, content: { ...parsed.data, contactId } });
      if (!row) throw new UseCaseError(INVOICE_ERROR.notFound);
      return toDraftView(row);
    },

    async deleteDraft(workspaceId, draftId) {
      const deleted = await deps.repos.invoice.deleteDraft(workspaceId, draftId);
      if (!deleted) throw new UseCaseError(INVOICE_ERROR.notFound);
    },

    async checkDraft(workspaceId, draftId) {
      const draft = await requireDraft(workspaceId, draftId);
      const workspace = await requireWorkspace(workspaceId);
      return check(toSellerProfile(workspace), parseStoredDraftContent(draft.content));
    },

    async renderDraftPreview(workspaceId, draftId) {
      const draft = await requireDraft(workspaceId, draftId);
      const workspace = await requireWorkspace(workspaceId);
      try {
        const rendered = await deps.renderer.render(draftInput(toSellerProfile(workspace), parseStoredDraftContent(draft.content), DRAFT_PREVIEW_NUMBER), { watermark: "ENTWURF" });
        return rendered.pdf;
      } catch (err) {
        if (err instanceof InvoiceValidationError) throw new InvoiceInvalidError(err.violations);
        throw err;
      }
    },

    async finalizeDraft({ workspaceId, draftId, userId, userEmail }) {
      // Checked before the transaction, so an invalid draft never takes a number or a lock.
      const draft = await requireDraft(workspaceId, draftId);
      const seller = toSellerProfile(await requireWorkspace(workspaceId));
      if (missingSellerFields(seller).length > 0) throw new UseCaseError(INVOICE_ERROR.companyProfileIncomplete);
      const checked = await check(seller, parseStoredDraftContent(draft.content));
      if (checked.violations.length > 0) throw new InvoiceInvalidError(checked.violations);

      return issue({
        workspaceId,
        type: "invoice",
        userId,
        userEmail,
        async build(repos, number, issueDate) {
          // Re-read with the workspace locked: a second "Festschreiben" of the same draft (two
          // tabs, a double click) waits for the first, then finds the draft gone.
          const current = await repos.invoice.findDraft(workspaceId, draftId);
          if (!current) throw new UseCaseError(INVOICE_ERROR.notFound);
          const workspace = await repos.workspace.findById(workspaceId);
          if (!workspace) throw new UseCaseError(INVOICE_ERROR.notFound);
          const content = parseStoredDraftContent(current.content);
          return { input: buildInvoiceInput({ number, issueDate, seller: toSellerProfile(workspace), content }), contactId: current.contactId, cancels: null };
        },
        async after(repos) {
          await repos.invoice.deleteDraft(workspaceId, draftId);
        },
      });
    },

    async cancelInvoice({ workspaceId, invoiceId, userId, userEmail }) {
      const original = await deps.repos.invoice.findInvoice(workspaceId, invoiceId);
      if (!original) throw new UseCaseError(INVOICE_ERROR.notFound);
      if (original.type !== "invoice") throw new UseCaseError(INVOICE_ERROR.notCancellable);
      if (original.cancelledById) throw new UseCaseError(INVOICE_ERROR.alreadyCancelled);

      return issue({
        workspaceId,
        type: "cancellation",
        userId,
        userEmail,
        async build(repos, number, issueDate) {
          if (await repos.invoice.findCancellationOf(workspaceId, invoiceId)) throw new UseCaseError(INVOICE_ERROR.alreadyCancelled);
          const current = await repos.invoice.findInvoice(workspaceId, invoiceId);
          if (!current) throw new UseCaseError(INVOICE_ERROR.notFound);
          return { input: buildCancellationInput({ original: current.einvoiceInput, number, issueDate }), contactId: current.contactId, cancels: current };
        },
        async after(repos, cancellationId) {
          await repos.invoice.insertEvent({ workspaceId, invoiceId, kind: "cancelled", relatedInvoiceId: cancellationId, actorUserId: userId, actorEmail: userEmail });
        },
      });
    },

    async listInvoices(workspaceId) {
      const rows = await deps.repos.invoice.listInvoices(workspaceId, INVOICE_LIST_LIMIT);
      return rows.map(toListItem);
    },

    async getInvoice(workspaceId, invoiceId) {
      const row = await deps.repos.invoice.findInvoice(workspaceId, invoiceId);
      if (!row) return null;
      const [events, document] = await Promise.all([
        deps.repos.invoice.listEvents(workspaceId, invoiceId),
        row.documentId ? deps.repos.document.findById(workspaceId, row.documentId) : Promise.resolve(null),
      ]);
      return {
        ...toListItem(row),
        dueDate: row.dueDate,
        netCents: row.netCents,
        vatCents: row.vatCents,
        cancelledById: row.cancelledById,
        cancelsId: row.cancelsInvoiceId,
        documentId: document?.id ?? null,
        pdfSha256: row.pdfSha256,
        xmlSha256: row.xmlSha256,
        createdAt: row.createdAt.toISOString(),
        events: events.map((event) => ({ kind: event.kind, actorEmail: event.actorEmail, at: event.createdAt.toISOString() })),
      };
    },

    async getInvoiceFile(workspaceId, invoiceId, format) {
      const row = await deps.repos.invoice.findInvoice(workspaceId, invoiceId);
      if (!row) return null;
      const bytes = await deps.objectStorage.getObject(format === "pdf" ? row.pdfStorageKey : row.xmlStorageKey);
      const expected = format === "pdf" ? row.pdfSha256 : row.xmlSha256;
      if (fileHash(bytes) !== expected) {
        // Served anyway (the user needs their file), but loudly: an archived invoice whose bytes
        // no longer match the hash stored when it was issued is an integrity incident.
        console.error("[invoicing] stored invoice file does not match its hash", { workspaceId, invoiceId, format });
      }
      return { bytes, fileName: invoiceFileName({ number: row.number, type: row.type, format }), contentType: format === "pdf" ? "application/pdf" : "application/xml" };
    },

    async *archiveEntries(workspaceId) {
      const rows = await deps.repos.invoice.listForArchive(workspaceId);
      for (const row of rows) {
        yield { name: `rechnungen/${invoiceFileName({ number: row.number, type: row.type, format: "pdf" })}`, bytes: await deps.objectStorage.getObject(row.pdfStorageKey) };
        yield { name: `rechnungen/${invoiceFileName({ number: row.number, type: row.type, format: "xml" })}`, bytes: await deps.objectStorage.getObject(row.xmlStorageKey) };
      }
    },

    countIssued(workspaceId) {
      return deps.repos.invoice.countInvoices(workspaceId);
    },
  };
}
