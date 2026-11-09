// Unit test (WEBAPP_TEMPLATE_SPEC.md §10.2: no DB, no network). `@/platform/auth/server`,
// `@/persistence/composition/request-services` and `next/headers` are mocked by the module
// paths this code actually imports, the same pattern `tests/require-session-access.test.ts`
// uses.
//
// decisions/0070-several-workspaces-per-user.md: the cases that matter most here are the
// cookie ones. The active-workspace cookie is client input, so every assertion below about a
// cookie that names a workspace the caller is NOT a member of is a security assertion, not a
// UX one: it must resolve to the deterministic fallback and grant nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/auth/server", () => ({
  getCurrentUser: vi.fn(),
}));

const listMembershipsForUser = vi.fn();
vi.mock("@/persistence/composition/request-services", () => ({
  getRequestServices: () => ({ workspaces: { listMembershipsForUser } }),
}));

let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name && cookieValue ? { value: cookieValue } : undefined) }),
}));

import { getCurrentUser } from "@/platform/auth/server";
import { PERMISSIONS } from "@/platform/access";
import { getWorkspaceAccess, resolveAccess } from "@/platform/access/server/get-workspace-access";
import { runAsDelegatedPrincipal } from "@/platform/access/server/delegated-principal";

const USER = { id: "u1", email: "admin@example.test" };

const OLDEST = {
  membershipId: "m1",
  role: "admin" as const,
  workspace: { id: "11111111-1111-4111-8111-111111111111", name: "Muster GmbH", tier: "free", createdAt: new Date(0) },
};
const SECOND = {
  membershipId: "m2",
  role: "member" as const,
  workspace: { id: "22222222-2222-4222-8222-222222222222", name: "Zweite GmbH", tier: "free", createdAt: new Date(1) },
};
/** A workspace this user is NOT a member of - only ever used as a cookie value. */
const FOREIGN_WORKSPACE_ID = "99999999-9999-4999-8999-999999999999";

beforeEach(() => {
  cookieValue = undefined;
  listMembershipsForUser.mockReset();
});

describe("resolveAccess and the active-workspace cookie", () => {
  it("falls back to the oldest membership and grants nothing when the cookie names a workspace the user is not a member of", async () => {
    cookieValue = FOREIGN_WORKSPACE_ID;
    listMembershipsForUser.mockResolvedValue([OLDEST, SECOND]);

    const access = await resolveAccess(USER);

    expect(access).toMatchObject({
      membershipId: OLDEST.membershipId,
      role: "admin",
      workspace: { id: OLDEST.workspace.id },
    });
    // The forged id never reaches the resolved access, in any field.
    expect(JSON.stringify(access)).not.toContain(FOREIGN_WORKSPACE_ID);
  });

  it("is indistinguishable from the same request with no cookie at all", async () => {
    listMembershipsForUser.mockResolvedValue([OLDEST, SECOND]);
    const withoutCookie = await resolveAccess(USER);

    cookieValue = FOREIGN_WORKSPACE_ID;
    const withForgedCookie = await resolveAccess(USER);

    expect(withForgedCookie).toEqual(withoutCookie);
  });

  it("ignores a malformed cookie value without ever querying for it", async () => {
    cookieValue = "not-a-uuid'; drop table workspaces;--";
    listMembershipsForUser.mockResolvedValue([OLDEST, SECOND]);

    await expect(resolveAccess(USER)).resolves.toMatchObject({ workspace: { id: OLDEST.workspace.id } });
    // The membership list is the ONLY query a resolution ever makes: a cookie value that is
    // not a uuid is dropped before it could reach the database at all.
    expect(listMembershipsForUser).toHaveBeenCalledTimes(1);
    expect(listMembershipsForUser).toHaveBeenCalledWith(USER.id);
  });

  it("uses the cookie's workspace when the user really is a member of it", async () => {
    cookieValue = SECOND.workspace.id;
    listMembershipsForUser.mockResolvedValue([OLDEST, SECOND]);

    await expect(resolveAccess(USER)).resolves.toMatchObject({
      membershipId: SECOND.membershipId,
      role: "member",
      workspace: { id: SECOND.workspace.id, name: "Zweite GmbH" },
    });
  });

  it("applies the cookie's workspace's own role, not the fallback's", async () => {
    cookieValue = SECOND.workspace.id;
    listMembershipsForUser.mockResolvedValue([OLDEST, SECOND]);

    // Admin in the oldest workspace, plain member in the active one: the permission bundle
    // must follow the ACTIVE workspace.
    await expect(resolveAccess(USER)).resolves.toMatchObject({
      permissions: [PERMISSIONS.documentsRead, PERMISSIONS.documentsWrite, PERMISSIONS.invoicesManage],
    });
  });

  it("falls back to the oldest membership when there is no cookie", async () => {
    listMembershipsForUser.mockResolvedValue([OLDEST, SECOND]);

    await expect(resolveAccess(USER)).resolves.toMatchObject({ workspace: { id: OLDEST.workspace.id } });
  });

  it("returns null when the user has no membership at all", async () => {
    listMembershipsForUser.mockResolvedValue([]);

    await expect(resolveAccess(USER)).resolves.toBeNull();
  });

  it("returns null even when a cookie names a workspace, if the user has no membership at all", async () => {
    cookieValue = FOREIGN_WORKSPACE_ID;
    listMembershipsForUser.mockResolvedValue([]);

    await expect(resolveAccess(USER)).resolves.toBeNull();
  });
});

describe("getWorkspaceAccess", () => {
  it("returns unauthenticated when there is no session", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    await expect(getWorkspaceAccess()).resolves.toEqual({ status: "error", errorCode: "unauthenticated" });
  });

  it("returns no_workspace when the signed-in user has no membership", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(USER);
    listMembershipsForUser.mockResolvedValue([]);

    await expect(getWorkspaceAccess()).resolves.toEqual({ status: "error", errorCode: "no_workspace" });
  });

  it("returns ok with the role's permission bundle for a member with a workspace", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(USER);
    listMembershipsForUser.mockResolvedValue([OLDEST]);

    const result = await getWorkspaceAccess();

    expect(result).toEqual({
      status: "ok",
      access: {
        user: USER,
        membershipId: "m1",
        role: "admin",
        workspace: { id: OLDEST.workspace.id, name: "Muster GmbH", tier: "free" },
        permissions: expect.arrayContaining(Object.values(PERMISSIONS)),
      },
    });
  });

  it("gives a member role only the document permissions and writing invoices", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(USER);
    listMembershipsForUser.mockResolvedValue([{ ...OLDEST, role: "member" }]);

    const result = await getWorkspaceAccess();

    expect(result).toMatchObject({
      status: "ok",
      access: { permissions: [PERMISSIONS.documentsRead, PERMISSIONS.documentsWrite, PERMISSIONS.invoicesManage] },
    });
  });
});

// decisions/0078-mcp-server.md: an MCP tool call runs as the OAuth token's user, never as the
// session cookie's, and the workspace it names is only ever SELECTED among that user's own
// memberships - with no silent fallback to another workspace.
describe("getWorkspaceAccess inside a delegated (MCP) principal", () => {
  const TOKEN_USER = { id: "u-token", email: "token@example.test" };

  it("resolves the token's user and never consults the session or the cookie", async () => {
    vi.mocked(getCurrentUser).mockReset();
    vi.mocked(getCurrentUser).mockRejectedValue(new Error("the session must not be read"));
    cookieValue = SECOND.workspace.id;
    listMembershipsForUser.mockResolvedValue([OLDEST, SECOND]);

    const result = await runAsDelegatedPrincipal({ user: TOKEN_USER, clientId: "client-1" }, () => getWorkspaceAccess());

    expect(listMembershipsForUser).toHaveBeenCalledWith(TOKEN_USER.id);
    expect(getCurrentUser).not.toHaveBeenCalled();
    // Default = oldest membership; the cookie naming SECOND is ignored.
    expect(result).toMatchObject({ status: "ok", access: { user: TOKEN_USER, workspace: { id: OLDEST.workspace.id }, role: "admin" } });
  });

  it("selects the named workspace with that workspace's own role", async () => {
    listMembershipsForUser.mockResolvedValue([OLDEST, SECOND]);

    const result = await runAsDelegatedPrincipal({ user: TOKEN_USER, clientId: "c", workspaceId: SECOND.workspace.id }, () => getWorkspaceAccess());

    expect(result).toMatchObject({ status: "ok", access: { workspace: { id: SECOND.workspace.id }, role: "member" } });
  });

  it("refuses a workspace that is not one of the user's memberships instead of falling back", async () => {
    listMembershipsForUser.mockResolvedValue([OLDEST, SECOND]);

    const result = await runAsDelegatedPrincipal({ user: TOKEN_USER, clientId: "c", workspaceId: FOREIGN_WORKSPACE_ID }, () => getWorkspaceAccess());

    expect(result).toEqual({ status: "error", errorCode: "no_workspace" });
  });

  it("does not leak the principal outside its own call chain", async () => {
    vi.mocked(getCurrentUser).mockReset();
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    await runAsDelegatedPrincipal({ user: TOKEN_USER, clientId: "c" }, async () => undefined);

    await expect(getWorkspaceAccess()).resolves.toEqual({ status: "error", errorCode: "unauthenticated" });
  });
});
