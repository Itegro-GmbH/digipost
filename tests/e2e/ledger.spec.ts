// The ledger end to end (decisions/0080-ledger-double-entry-bookkeeping.md): an admin finds the
// disabled ledger from "Finanzen", enables the books on /dashboard/buchhaltung, the "Buchhaltung"
// nav section appears, a manual entry (the share capital) is booked through the editor and shows
// up in the journal, on "Konten" (2900) and on its Kontenblatt; the reports and settings pages
// render. A member never sees the section and gets the not-found page, even with the ledger
// enabled.
import { expect, test } from "./helpers/fixtures";
import { createTestUser, loginAs } from "./helpers/auth";
import { deleteUserById, ownerQuery, uniqueEmail } from "./helpers/db";
import { addMemberToWorkspace } from "./helpers/workspace";

test("admin enables the ledger and books the share capital through the editor", { tag: "@smoke" }, async ({ page, adminUser }) => {
  void adminUser;
  await page.goto("/dashboard/finance");
  await page.getByRole("link", { name: /Buchhaltung \(intern\)/ }).click();
  await expect(page).toHaveURL(/\/dashboard\/buchhaltung$/);
  await expect(page.getByRole("group", { name: "Buchhaltung" })).toHaveCount(0);
  await page.getByRole("button", { name: "Buchhaltung aktivieren" }).click();

  await expect(page.getByRole("heading", { name: /Zeiträume \d{4}/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: "Zu prüfen" })).toBeVisible();

  await page.goto("/dashboard/buchhaltung/buchung/neu");
  await page.getByRole("tab", { name: "Umbuchung" }).click();
  const from = page.getByRole("combobox", { name: "Von Konto" });
  await from.fill("2900");
  await from.press("Enter");
  const to = page.getByRole("combobox", { name: "Auf Konto" });
  await to.fill("1800");
  await to.press("Enter");
  await page.getByLabel("Betrag", { exact: true }).fill("4167,00");
  await page.getByLabel("Buchungstext").fill("Stammeinlage Luca");
  await expect(page.getByRole("table", { name: "So wird gebucht" }).getByText("Ausgeglichen")).toBeVisible();
  await page.getByRole("button", { name: "Buchen" }).click();

  await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/buchhaltung\/buchung\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Stammeinlage Luca" })).toBeVisible();
  await expect(page.getByText("Gebucht", { exact: true }).first()).toBeVisible();

  await page.goto("/dashboard/buchhaltung/journal");
  await expect(page.getByRole("link", { name: "Stammeinlage Luca" })).toBeVisible();

  await page.goto("/dashboard/buchhaltung/zu-pruefen");
  await expect(page.getByRole("heading", { name: "Zu prüfen" })).toBeVisible();

  // "Konten": the share capital on 2900, positive in the plain view, Haben in the expert view.
  const nav = page.getByRole("group", { name: "Buchhaltung" });
  await nav.getByRole("link", { name: "Konten" }).click();
  await expect(page.getByRole("heading", { name: "Konten", level: 1 })).toBeVisible();
  const capitalRow = page.getByRole("row").filter({ has: page.getByRole("link", { name: /Gezeichnetes Kapital/ }) });
  await expect(capitalRow.getByRole("link", { name: /^Stand: 4\.167,00/ })).toBeVisible();
  await expect(page.getByText(/Summe Soll 4\.167,00\s€ = Summe Haben 4\.167,00\s€/)).toBeVisible();
  await page.getByRole("link", { name: "Soll/Haben" }).click();
  await expect(capitalRow.getByRole("link", { name: /^Saldo: 4\.167,00\s€ H/ })).toBeVisible();

  // Its Kontenblatt: the entry with its counter account and the running balance.
  await capitalRow.getByRole("link", { name: /Gezeichnetes Kapital/ }).click();
  await expect(page.getByRole("heading", { name: /Gezeichnetes Kapital/, level: 1 })).toBeVisible();
  const sheetRow = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Stammeinlage Luca" }) });
  await expect(sheetRow.getByRole("link", { name: /1800/ })).toBeVisible();
  await expect(sheetRow.getByText(/4\.167,00\s€ H/)).toBeVisible();

  // Reports and settings render for the admin.
  await nav.getByRole("link", { name: "Auswertungen" }).click();
  await expect(page).toHaveURL(/\/auswertungen\/ust/);
  await expect(page.getByRole("heading", { name: "Auswertungen", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Zeiträume und Meldungen" }).click();
  await expect(page.getByRole("heading", { name: "Umsatzsteuer-Voranmeldungen" })).toBeVisible();
  await page.getByRole("link", { name: "Abgleich Steuerberaterin" }).click();
  await expect(page.getByRole("heading", { name: "Summen- und Saldenliste hochladen" })).toBeVisible();
  await nav.getByRole("link", { name: "Einstellungen" }).click();
  await expect(page.getByRole("button", { name: "Kontenplan aktualisieren" })).toBeVisible();
  await page.getByRole("link", { name: "Kontenplan" }).click();
  await expect(page.getByText("Gezeichnetes Kapital").first()).toBeVisible();
});

test("a member never sees the Buchhaltung section and is forbidden on its routes", async ({ browser, baseURL, adminUser }) => {
  await ownerQuery(`insert into public.ledger_settings (workspace_id, enabled, start_date) values ($1, true, '2026-01-01')`, [adminUser.workspace.id]);
  const memberContext = await browser.newContext();
  try {
    const memberPage = await memberContext.newPage();
    const memberUser = await createTestUser("ledger-member", uniqueEmail("ledger-member"));
    await addMemberToWorkspace(adminUser.workspace.id, memberUser.id);
    await loginAs(memberContext, memberUser, baseURL!);

    await memberPage.goto("/dashboard");
    await expect(memberPage.getByRole("group", { name: "Buchhaltung" })).toHaveCount(0);
    for (const path of [
      "/dashboard/buchhaltung",
      "/dashboard/buchhaltung/zu-pruefen",
      "/dashboard/buchhaltung/journal",
      "/dashboard/buchhaltung/konten",
      "/dashboard/buchhaltung/konten/2900",
      "/dashboard/buchhaltung/auswertungen/ust",
      "/dashboard/buchhaltung/auswertungen/zeitraeume",
      "/dashboard/buchhaltung/einstellungen",
    ]) {
      await memberPage.goto(path);
      await expect(memberPage.getByText("This page could not be found.")).toBeVisible();
    }
    await deleteUserById(memberUser.id);
  } finally {
    await memberContext.close();
  }
});
