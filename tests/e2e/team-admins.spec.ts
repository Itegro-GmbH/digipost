// Several admins per workspace, end to end (decisions/0082-several-admins-per-workspace.md):
// the admin makes a member a second admin on `/dashboard/team`, that co-admin now gets the
// admin-only areas (the "Finanzen" navigation group is the reason the feature exists), and the
// admin takes the rights away again through the confirmation. The last admin is never offered
// "Admin-Rechte entziehen" or "Arbeitsbereich verlassen" for their own row.
import { expect, test } from "./helpers/fixtures";
import { createTestUser, loginAs } from "./helpers/auth";
import { deleteUserById, uniqueEmail } from "./helpers/db";
import { addMemberToWorkspace } from "./helpers/workspace";

test("an admin promotes a member to co-admin and takes the rights away again", async ({ page, browser, baseURL, adminUser }) => {
  const coFounderEmail = uniqueEmail("co-founder");
  const coFounder = await createTestUser("co-founder", coFounderEmail);
  const coFounderContext = await browser.newContext();
  try {
    await addMemberToWorkspace(adminUser.workspace.id, coFounder.id);

    await page.goto("/dashboard/team");
    const ownRow = page.locator("li").filter({ hasText: adminUser.email });
    const coFounderRow = page.locator("li").filter({ hasText: coFounderEmail });
    await expect(coFounderRow.getByTestId("member-role")).toHaveText("Mitglied");

    // The only admin: no way to drop their own rights or leave.
    await expect(ownRow.getByRole("button", { name: "Admin-Rechte entziehen" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Arbeitsbereich verlassen" })).toHaveCount(0);

    await coFounderRow.getByRole("button", { name: "Zum Admin machen" }).click();
    await expect(coFounderRow.getByTestId("member-role")).toHaveText("Administrator");
    // With a second admin, the first may now drop their own rights or leave.
    await expect(ownRow.getByRole("button", { name: "Admin-Rechte entziehen" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Arbeitsbereich verlassen" })).toBeVisible();

    // The co-founder sees finance now.
    await loginAs(coFounderContext, coFounder, baseURL!);
    const coFounderPage = await coFounderContext.newPage();
    await coFounderPage.goto("/dashboard");
    await expect(coFounderPage.getByRole("group", { name: "Finanzen" })).toBeVisible();

    // Taking the rights away needs a confirmation.
    await coFounderRow.getByRole("button", { name: "Admin-Rechte entziehen" }).click();
    await expect(coFounderRow.getByText("Admin-Rechte entziehen?", { exact: false })).toBeVisible();
    await coFounderRow.getByRole("button", { name: "Ja, entziehen" }).click();
    await expect(coFounderRow.getByTestId("member-role")).toHaveText("Mitglied");
    await expect(ownRow.getByRole("button", { name: "Admin-Rechte entziehen" })).toHaveCount(0);

    await coFounderPage.goto("/dashboard");
    await expect(coFounderPage.getByRole("group", { name: "Finanzen" })).toHaveCount(0);
  } finally {
    await coFounderContext.close();
    await deleteUserById(coFounder.id);
  }
});

test("an admin who demotes themself loses the team controls at once", async ({ page, adminUser }) => {
  const coFounder = await createTestUser("co-admin", uniqueEmail("co-admin"));
  try {
    await addMemberToWorkspace(adminUser.workspace.id, coFounder.id);

    await page.goto("/dashboard/team");
    const ownRow = page.locator("li").filter({ hasText: adminUser.email });
    const coFounderRow = page.locator("li").filter({ hasText: coFounder.email });
    await coFounderRow.getByRole("button", { name: "Zum Admin machen" }).click();
    await expect(coFounderRow.getByTestId("member-role")).toHaveText("Administrator");

    await ownRow.getByRole("button", { name: "Admin-Rechte entziehen" }).click();
    await expect(ownRow.getByText("Ihre eigenen Admin-Rechte entziehen?", { exact: false })).toBeVisible();
    await ownRow.getByRole("button", { name: "Ja, entziehen" }).click();

    await expect(ownRow.getByTestId("member-role")).toHaveText("Mitglied");
    // The page re-renders from the server: no invite form, no member controls any more.
    await expect(page.getByRole("button", { name: "Einladen" })).toHaveCount(0);
    await expect(coFounderRow.getByRole("button", { name: "Admin-Rechte entziehen" })).toHaveCount(0);
  } finally {
    await deleteUserById(coFounder.id);
  }
});
