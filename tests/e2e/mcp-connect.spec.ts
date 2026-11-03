// The MCP server's browser half (decisions/0078-mcp-server.md): an AI client registers (RFC 7591),
// sends the signed-in user to authorize, the consent page names the client and the account, a
// click on "Zulassen" sends the browser back to the client with a code, and the connection then
// shows up on "KI-Verbindungen", where "Verbindung trennen" removes it. The client's redirect URI
// (a loopback callback, as Claude Code or Cursor use) is answered by Playwright itself.
import { createHash, randomBytes } from "node:crypto";

import { expect, test } from "./helpers/fixtures";

const REDIRECT_URI = "http://127.0.0.1:53682/callback";
const CLIENT_NAME = "E2E KI-Assistent";

test("connects an AI client through the consent page and disconnects it again", { tag: "@smoke" }, async ({ page, request, baseURL, adminUser }) => {
  const registration = await request.post("/api/auth/oauth2/register", {
    data: {
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  expect(registration.ok()).toBe(true);
  const { client_id: clientId } = (await registration.json()) as { client_id: string };

  await page.route(`${REDIRECT_URI}**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>callback</p>" }));

  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL("/api/auth/oauth2/authorize", baseURL);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid offline_access digipost",
    state: "e2e-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: new URL("/api/mcp", baseURL).toString(),
  }))
    authorize.searchParams.set(key, value);

  await page.goto(authorize.toString());
  await expect(page).toHaveURL(/\/oauth\/consent\?/);
  await expect(page.getByRole("heading", { name: `${CLIENT_NAME} mit Digipost verbinden?` })).toBeVisible();
  await expect(page.getByText(`Angemeldet als ${adminUser.email}.`)).toBeVisible();
  await expect(page.getByText(adminUser.workspace.name)).toBeVisible();

  await page.getByTestId("consent-accept").click();
  await expect.poll(() => page.url(), { timeout: 10_000 }).toContain(REDIRECT_URI);
  const callback = new URL(page.url());
  expect(callback.searchParams.get("code")).toBeTruthy();
  expect(callback.searchParams.get("state")).toBe("e2e-state");

  await page.goto("/dashboard/settings/ai-clients");
  await expect(page.getByRole("heading", { name: "KI-Verbindungen", level: 1 })).toBeVisible();
  await expect(page.getByTestId("mcp-url")).toHaveText(new URL("/api/mcp", baseURL).toString());
  const row = page.getByTestId("ai-client-row").filter({ hasText: CLIENT_NAME });
  await expect(row).toBeVisible();

  await row.getByTestId("ai-client-revoke").click();
  await row.getByTestId("ai-client-revoke-confirm").click();
  await expect(page.getByTestId("ai-clients-empty")).toBeVisible();
});
