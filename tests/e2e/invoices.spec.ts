// Writing invoices end to end (decisions/0079-outgoing-invoices.md): the missing company profile,
// a draft written, checked and finalized into `<year>-0001`, its files and inbox document, the
// full cancellation as `<year>-0002`, and a plain member's access.
import { createTestUser, loginAs } from "./helpers/auth";
import { deleteUserById, ownerQuery, uniqueEmail } from "./helpers/db";
import { expect, test } from "./helpers/fixtures";
import { addMemberToWorkspace, setCompanyProfileForInvoices } from "./helpers/workspace";

const YEAR = new Intl.DateTimeFormat("en", { timeZone: "Europe/Berlin", year: "numeric" }).format(new Date());

test("an incomplete company profile is named before anything can be issued", async ({ page, adminUser }) => {
  void adminUser;
  await page.goto("/dashboard/invoices");
  await expect(page.getByRole("heading", { name: "Rechnungen", level: 1 })).toBeVisible();
  await expect(page.getByText("In den Firmendaten fehlen noch Angaben")).toBeVisible();
  await expect(page.getByText("USt-IdNr. oder Steuernummer", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Firmendaten ergänzen" })).toBeVisible();
});

test("an invoice is written, finalized, and then fully cancelled", { tag: "@smoke" }, async ({ page, adminUser }) => {
  test.setTimeout(120_000);
  await setCompanyProfileForInvoices(adminUser.workspace.id);

  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Rechnungen", exact: true }).click();
  await page.getByRole("button", { name: "Neue Rechnung" }).click();
  await expect(page.getByRole("heading", { name: "Rechnung schreiben", level: 1 })).toBeVisible();

  await page.getByLabel("Name / Firma", { exact: true }).fill("Kunde KG");
  await page.getByLabel("Straße und Hausnummer", { exact: true }).fill("Weg 2");
  await page.getByLabel("Postleitzahl", { exact: true }).fill("50667");
  await page.getByLabel("Ort", { exact: true }).fill("Köln");
  await page.getByLabel("Bezeichnung", { exact: true }).fill("Beratung");
  await page.getByLabel("Menge", { exact: true }).fill("2");
  await page.getByLabel("Einzelpreis netto (EUR)", { exact: true }).fill("95,00");
  await page.getByLabel("Leistungsdatum", { exact: true }).fill(`${YEAR}-01-15`);

  await page.getByRole("button", { name: "Speichern und prüfen" }).click();
  await expect(page.getByText("Die Rechnung ist vollständig und kann festgeschrieben werden.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^226,10\s€$/)).toBeVisible();

  await page.getByRole("button", { name: "Festschreiben", exact: true }).click();
  await page.getByRole("button", { name: "Ja, festschreiben" }).click();
  await expect(page.getByRole("heading", { name: `Rechnung ${YEAR}-0001`, level: 1 })).toBeVisible({ timeout: 60_000 });
  const invoiceUrl = page.url();

  // The archived files.
  const invoiceId = invoiceUrl.split("/").pop()!;
  const pdf = await page.request.get(`/api/invoices/${invoiceId}/file?format=pdf&download=1`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  const xml = await page.request.get(`/api/invoices/${invoiceId}/file?format=xml`);
  expect(await xml.text()).toContain(`<ram:ID>${YEAR}-0001</ram:ID>`);

  // The inbox document, already processed, counted like an upload.
  const documents = await ownerQuery<{ kind: string; direction: string; status: string; total_amount_cents: number }>(
    `select kind, direction, status, total_amount_cents from public.documents where workspace_id = $1 and invoice_number = $2`,
    [adminUser.workspace.id, `${YEAR}-0001`],
  );
  expect(documents).toEqual([{ kind: "outgoing_invoice", direction: "outgoing", status: "done", total_amount_cents: 22610 }]);

  await page.getByRole("button", { name: "Stornieren", exact: true }).click();
  await page.getByRole("button", { name: "Ja, stornieren" }).click();
  await expect(page.getByRole("heading", { name: `Stornorechnung ${YEAR}-0002`, level: 1 })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: `Storno zu ${YEAR}-0001` })).toBeVisible();

  await page.goto(invoiceUrl);
  await expect(page.getByRole("link", { name: `Storniert durch ${YEAR}-0002` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stornieren", exact: true })).toHaveCount(0);

  await page.goto("/dashboard/invoices");
  await expect(page.getByRole("link", { name: `${YEAR}-0001` })).toBeVisible();
  await expect(page.getByRole("link", { name: `${YEAR}-0002` })).toBeVisible();
  await expect(page.getByRole("cell", { name: /^-226,10\s€$/ })).toBeVisible();
});

test("a plain member writes invoices too", async ({ browser, baseURL, adminUser }) => {
  const memberContext = await browser.newContext();
  const member = await createTestUser("invoice-member", uniqueEmail("invoice-member"));
  try {
    await addMemberToWorkspace(adminUser.workspace.id, member.id);
    await setCompanyProfileForInvoices(adminUser.workspace.id);
    await loginAs(memberContext, member, baseURL!);
    const page = await memberContext.newPage();

    await page.goto("/dashboard/invoices");
    // A member cannot edit the company profile, so the list never links there for them.
    await expect(page.getByRole("link", { name: "Firmendaten ergänzen" })).toHaveCount(0);
    await page.getByRole("button", { name: "Neue Rechnung" }).click();
    await expect(page.getByRole("heading", { name: "Rechnung schreiben", level: 1 })).toBeVisible();
  } finally {
    await memberContext.close();
    await deleteUserById(member.id);
  }
});

test("a workspace with issued invoices is deleted only after confirming they were downloaded", async ({ page, adminUser }) => {
  // One issued invoice, inserted directly: this spec is about the danger zone, not issuing.
  const invoiceId = crypto.randomUUID();
  await ownerQuery(
    `insert into public.invoices (id, workspace_id, number, year, sequence, type, issue_date, currency, net_cents, vat_cents, gross_cents,
                                  buyer_name, einvoice_input, pdf_storage_key, xml_storage_key, pdf_sha256, xml_sha256)
     values ($1, $2, '2026-0001', 2026, 1, 'invoice', '2026-11-05', 'EUR', 100, 19, 119, 'Kunde KG', '{}'::jsonb, 'k.pdf', 'k.xml', 'a', 'b')`,
    [invoiceId, adminUser.workspace.id],
  );

  await page.goto("/dashboard/settings/company");
  await page.getByRole("button", { name: "Arbeitsbereich löschen" }).click();
  await page.getByLabel("Name des Arbeitsbereichs").fill(adminUser.workspace.name);
  await expect(page.getByText("wurde 1 Rechnung ausgestellt", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: /Alle Rechnungen herunterladen/ })).toHaveAttribute("href", "/api/invoices/export");

  const submit = page.getByRole("button", { name: "Endgültig löschen" });
  await expect(submit).toBeDisabled();
  await page.getByLabel("Ich habe die Rechnung heruntergeladen und bewahre sie selbst auf.").check();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page).toHaveURL(/\/onboarding$/, { timeout: 30_000 });
  expect(await ownerQuery(`select id from public.invoices where id = $1`, [invoiceId])).toEqual([]);
});
