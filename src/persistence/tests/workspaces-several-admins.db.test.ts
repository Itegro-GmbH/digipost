// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3, `pnpm test:docker` reference,
// `pnpm test:db` on the host against `docker/compose.yml`).
//
// decisions/0082-several-admins-per-workspace.md: a workspace may have several admins, and it
// always keeps at least one. The database no longer limits admins (the partial unique index is
// dropped); "at least one" is the use cases' job, made race-free by the workspace row lock. The
// concurrency cases below are the reason this file exists: two admins taking each other's (or
// their own) admin rights away at the same moment must leave exactly one admin, never zero.
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { user } from "@/persistence/schema/auth";
import { workspaceMembers } from "@/persistence/schema/workspaces";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { createWorkspaceUseCases, WORKSPACE_ERROR } from "@/persistence/use-cases/workspaces-use-cases";

const db = getDb();

function makeUseCases() {
  return createWorkspaceUseCases({ repos: createDrizzleRepositories(db), uow: createDrizzleUnitOfWork(db) });
}

async function createTestUser(label: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({ name: "Test User", email: `${label}-${randomUUID()}@example.test`, emailVerified: false })
    .returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return row.id;
}

/** A workspace created through `createForUser` (its creator is the first admin) plus a second
 * member added directly with `secondRole`. */
async function workspaceWithTwo(secondRole: "admin" | "member") {
  const cases = makeUseCases();
  const repos = createDrizzleRepositories(db);
  const founder = await createTestUser("founder");
  const cofounder = await createTestUser("cofounder");
  const { workspace } = await cases.createForUser({ userId: founder, name: "Zwei Gründer GmbH" });
  const founderMembership = await repos.workspaceMember.findByWorkspaceAndUser(workspace.id, founder);
  if (!founderMembership) throw new Error("createForUser did not create the founder's membership");
  const cofounderMembership = await repos.workspaceMember.create({ workspaceId: workspace.id, userId: cofounder, role: secondRole });
  return { cases, workspaceId: workspace.id, founderId: founderMembership.id, cofounderId: cofounderMembership.id };
}

async function adminCount(workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")));
  return rows.length;
}

function expectOneLastAdminRejection(results: PromiseSettledResult<unknown>[]) {
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toBeInstanceOf(UseCaseError);
  expect((rejected[0]?.reason as UseCaseError).code).toBe(WORKSPACE_ERROR.lastAdmin);
}

describe("several admins per workspace (decisions/0082-several-admins-per-workspace.md)", () => {
  it("promotes a member to a second admin and demotes them again", async () => {
    const { cases, workspaceId, cofounderId } = await workspaceWithTwo("member");

    await cases.setMemberRole({ workspaceId, memberId: cofounderId, role: "admin" });
    expect(await adminCount(workspaceId)).toBe(2);

    await cases.setMemberRole({ workspaceId, memberId: cofounderId, role: "member" });
    expect(await adminCount(workspaceId)).toBe(1);
  });

  it("refuses to demote the last admin, leaving the row unchanged", async () => {
    const { cases, workspaceId, founderId } = await workspaceWithTwo("member");

    await expect(cases.setMemberRole({ workspaceId, memberId: founderId, role: "member" })).rejects.toMatchObject({
      code: WORKSPACE_ERROR.lastAdmin,
    });
    expect(await adminCount(workspaceId)).toBe(1);
  });

  it("never changes a member of another workspace (workspace-scoped update)", async () => {
    const first = await workspaceWithTwo("member");
    const second = await workspaceWithTwo("member");

    await expect(
      first.cases.setMemberRole({ workspaceId: first.workspaceId, memberId: second.cofounderId, role: "admin" }),
    ).rejects.toMatchObject({ code: WORKSPACE_ERROR.notFound });
    expect(await adminCount(second.workspaceId)).toBe(1);
  });

  it("lets one of two admins leave, but not the remaining one", async () => {
    const { cases, workspaceId, founderId, cofounderId } = await workspaceWithTwo("admin");

    await cases.leaveWorkspace({ workspaceId, membershipId: cofounderId });
    await expect(cases.leaveWorkspace({ workspaceId, membershipId: founderId })).rejects.toMatchObject({
      code: WORKSPACE_ERROR.lastAdmin,
    });
    expect(await adminCount(workspaceId)).toBe(1);
  });

  // The race the workspace row lock exists for. Repeated a few times so the two transactions
  // genuinely overlap at least once; without the lock both would read "2 admins" and both
  // commit, leaving the workspace with none.
  for (let round = 1; round <= 5; round++) {
    it(`two admins demoting each other at the same moment leave exactly one admin (round ${round})`, async () => {
      const { cases, workspaceId, founderId, cofounderId } = await workspaceWithTwo("admin");

      const results = await Promise.allSettled([
        cases.setMemberRole({ workspaceId, memberId: cofounderId, role: "member" }),
        cases.setMemberRole({ workspaceId, memberId: founderId, role: "member" }),
      ]);

      expectOneLastAdminRejection(results);
      expect(await adminCount(workspaceId)).toBe(1);
    });
  }

  it("two admins leaving at the same moment leave exactly one admin", async () => {
    const { cases, workspaceId, founderId, cofounderId } = await workspaceWithTwo("admin");

    const results = await Promise.allSettled([
      cases.leaveWorkspace({ workspaceId, membershipId: founderId }),
      cases.leaveWorkspace({ workspaceId, membershipId: cofounderId }),
    ]);

    expectOneLastAdminRejection(results);
    expect(await adminCount(workspaceId)).toBe(1);
  });

  it("two admins removing each other at the same moment leave exactly one admin", async () => {
    const { cases, workspaceId, founderId, cofounderId } = await workspaceWithTwo("admin");

    const results = await Promise.allSettled([
      cases.removeMember({ workspaceId, actorMembershipId: founderId, memberId: cofounderId }),
      cases.removeMember({ workspaceId, actorMembershipId: cofounderId, memberId: founderId }),
    ]);

    expectOneLastAdminRejection(results);
    expect(await adminCount(workspaceId)).toBe(1);
  });

  it("a demotion racing a leave leaves exactly one admin", async () => {
    const { cases, workspaceId, founderId, cofounderId } = await workspaceWithTwo("admin");

    const results = await Promise.allSettled([
      cases.setMemberRole({ workspaceId, memberId: founderId, role: "member" }),
      cases.leaveWorkspace({ workspaceId, membershipId: cofounderId }),
    ]);

    expectOneLastAdminRejection(results);
    expect(await adminCount(workspaceId)).toBe(1);
  });
});
