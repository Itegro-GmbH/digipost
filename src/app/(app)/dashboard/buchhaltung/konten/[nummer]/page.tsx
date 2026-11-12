import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";

import { accountSheetSearch, isCreditNormal, openItemAccountType, parseAccountSheetSearchParams } from "@/modules/ledger";
import { AccountSheetTable, LedgerTabs, OpenItemsClient, type OpenItemLineView } from "@/modules/ledger/client";
import {
  getLedgerAccountSheetProjection,
  getLedgerMatchSuggestionsProjection,
  getLedgerOpenItemsProjection,
  isLedgerEnabledProjection,
  listLedgerAccountsProjection,
} from "@/modules/ledger/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { buttonVariants, Input, Label } from "@/shared/ui-primitives";

function formatCents(cents: number): string {
  return new Intl.NumberFormat("de", { style: "currency", currency: "EUR" }).format(cents / 100);
}

/**
 * The Kontenblatt of one account (decisions/0080 UI concept B, screen B): every line in the
 * period (`?von=&bis=`) with the running balance, counter accounts, entry and document links.
 * Proposals are listed dashed and count only with `?vorschlaege=1` ("Vorschläge einrechnen").
 * An open-item account has a second tab, `?tab=offen`, for matching its open items. Admin-only
 * (`finance.read`), ledger enabled, and an account number of the caller's own chart, else
 * `notFound()`.
 */
export default async function LedgerAccountSheetPage({ params, searchParams }: PageProps<"/dashboard/buchhaltung/konten/[nummer]">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();
  const workspaceId = access.workspace.id;
  if (!(await isLedgerEnabledProjection(workspaceId))) notFound();
  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  const { nummer } = await params;
  if (!/^\d{4,8}$/.test(nummer)) notFound();
  const today = new Date().toISOString().slice(0, 10);
  const values = parseAccountSheetSearchParams(await searchParams, today);

  const [t, accounts] = await Promise.all([getTranslations("Ledger"), listLedgerAccountsProjection(workspaceId)]);
  const account = accounts.find((candidate) => candidate.number === nummer);
  if (!account) notFound();
  const tab = account.openItems ? values.tab : "blatt";
  const base = `/dashboard/buchhaltung/konten/${account.number}`;
  const accountNames = Object.fromEntries(accounts.map((candidate) => [candidate.number, candidate.name]));

  const [sheet, openItems, suggestions] = await Promise.all([
    tab === "blatt" ? getLedgerAccountSheetProjection(workspaceId, account.number, values.von, values.bis, values.vorschlaege) : Promise.resolve(null),
    tab === "offen" ? getLedgerOpenItemsProjection(workspaceId, account.number, today) : Promise.resolve(null),
    tab === "offen" ? getLedgerMatchSuggestionsProjection(workspaceId, account.id) : Promise.resolve([]),
  ]);

  const lineView = (line: { lineId: string; entryId: string; bookingDate: string; text: string | null; entryText: string; amountCents: number; documentId: string | null }): OpenItemLineView => ({
    lineId: line.lineId,
    entryId: line.entryId,
    bookingDate: line.bookingDate,
    text: line.text ?? line.entryText,
    amountCents: line.amountCents,
    documentId: line.documentId,
  });
  const headerBalance = sheet ? sheet.closingCents : (openItems?.balanceCents ?? 0);
  const natural = isCreditNormal(account.kind) ? -headerBalance : headerBalance;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link href={`/dashboard/buchhaltung/konten?von=${values.von}&bis=${values.bis}`} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft aria-hidden className="size-4" />
          {t("sheet.back")}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="flex flex-wrap items-baseline gap-2 text-xl font-semibold text-foreground">
              {account.name}
              <span className="font-mono text-sm font-normal text-muted-foreground">{account.number}</span>
            </h1>
            {account.description ? <p className="max-w-prose text-sm text-muted-foreground">{account.description}</p> : null}
            <p className="text-sm text-muted-foreground">
              {t(`groups.${account.group}`)}, {t(`accountKinds.${account.kind}`)}
              {account.archived ? `, ${t("sheet.archived")}` : null}
            </p>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <p className="text-xs text-muted-foreground">{t(tab === "offen" ? "sheet.balanceToday" : "sheet.balanceAt", { date: new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(`${values.bis}T00:00:00`)) })}</p>
            <p className="text-xl font-semibold tabular-nums text-foreground">{formatCents(natural)}</p>
          </div>
        </div>
      </div>

      {account.openItems ? (
        <LedgerTabs
          label={t("sheet.tabsLabel")}
          items={[
            { href: `${base}${accountSheetSearch(values, { tab: "blatt" })}`, label: t("sheet.tabs.sheet"), active: tab === "blatt" },
            { href: `${base}${accountSheetSearch(values, { tab: "offen" })}`, label: t("sheet.tabs.openItems"), active: tab === "offen" },
          ]}
        />
      ) : null}

      {sheet ? (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <form method="get" className="flex flex-wrap items-end gap-3" aria-label={t("sheet.filtersLabel")}>
              <div className="flex flex-col gap-1">
                <Label htmlFor="sheet-from" className="text-xs text-muted-foreground">
                  {t("filters.from")}
                </Label>
                <Input id="sheet-from" type="date" name="von" defaultValue={values.von} className="w-fit" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="sheet-to" className="text-xs text-muted-foreground">
                  {t("filters.to")}
                </Label>
                <Input id="sheet-to" type="date" name="bis" defaultValue={values.bis} className="w-fit" />
              </div>
              {values.vorschlaege ? <input type="hidden" name="vorschlaege" value="1" /> : null}
              <button type="submit" className={buttonVariants({ variant: "outline" })}>
                {t("filters.show")}
              </button>
            </form>
            <LedgerTabs
              variant="toggle"
              label={t("sheet.proposalsLabel")}
              items={[
                { href: `${base}${accountSheetSearch(values, { vorschlaege: false })}`, label: t("sheet.onlyBooked"), active: !values.vorschlaege },
                { href: `${base}${accountSheetSearch(values, { vorschlaege: true })}`, label: t("sheet.withProposals"), active: values.vorschlaege },
              ]}
            />
          </div>
          {sheet.rows.length === 0 && sheet.openingCents === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{t("sheet.empty")}</p>
          ) : (
            <AccountSheetTable sheet={sheet} accountNames={accountNames} countProposals={values.vorschlaege} sheetQuery={`?von=${values.von}&bis=${values.bis}`} />
          )}
          <p className="text-xs text-muted-foreground">{t(values.vorschlaege ? "sheet.proposalsCounted" : "sheet.proposalsNotCounted")}</p>
        </>
      ) : null}

      {openItems ? (
        <OpenItemsClient
          accountNumber={account.number}
          accountType={openItemAccountType(account)}
          balanceCents={openItems.balanceCents}
          status={openItems.status}
          unmatched={openItems.unmatched.map(lineView)}
          matches={openItems.matches.map((match) => ({ id: match.id, kind: match.kind, note: match.note, sumCents: match.sumCents, lines: match.lines.map(lineView) }))}
          suggestions={suggestions.map((suggestion) => ({ reason: suggestion.reason, lineIds: suggestion.lineIds, amountCents: suggestion.amountCents }))}
          canManage={canManage}
        />
      ) : null}
    </div>
  );
}
