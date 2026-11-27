# Several admins per workspace, and never none

Document type: decision
Lifecycle: active
Owner: src/modules/workspaces
Scope: How many admins a workspace may have, how an admin is made or unmade, and what keeps a
workspace from ending up without one
Canonical responsibility: Active source for the "at least one admin" rule, the promote/demote
flow on `/dashboard/team`, and who receives the admin notices
Maintenance triggers:
- A role beyond `admin`/`member` is introduced, or the admin bundle is split
- Something other than the use cases below starts changing `workspace_members.role` or deleting
  admin memberships (for example a user-account deletion flow)
- Invitations start creating admins directly
Last verified: 2026-11-27, implemented against `src/persistence/use-cases/workspaces-use-cases.ts`,
`src/modules/workspaces`, `src/persistence/composition/job-handlers.ts` and migration 0035

## Status

Accepted. Supersedes the "exactly one admin per workspace" rule of
decisions/0014-workspaces-and-access.md (point 1) and the "an admin cannot leave" part of
decisions/0027-hardening-and-deletion.md's member self-removal.

## Context

decisions/0014 allowed exactly one admin per workspace, enforced by the partial unique index
`workspace_members_one_admin_key` (unique on `workspace_id` where `role = 'admin'`). Finance is
admin-only by design (`finance.read`/`finance.manage`, decisions/0024): a bank statement exposes
salaries and private debits, so there is no member-level way to see it. A company run by two
co-founders therefore had to choose which of them may see its own finances. The real need is two
admins, not a weaker finance permission.

With one admin, several rules followed from the index: the admin could not leave
(`cannot_leave_as_admin`), removing a member could never remove the admin (the only admin is the
caller, and removing yourself was already refused), and the admin notices (quota warning,
E-Mail-Eingang rejection notice) went to "the" admin.

## Decision

1. **At least one admin, any number of them.** The partial unique index is dropped (migration
   `0035_cuddly_lady_deathstrike.sql`, generated from the schema). Every workspace still starts
   with its creator as admin (`createForUser`).
2. **Promote and demote on `/dashboard/team`.** An admin makes a member an admin ("Zum Admin
   machen") or takes an admin's rights away ("Admin-Rechte entziehen", with a confirmation),
   through `setMemberRoleAction` and `WorkspaceUseCases.setMemberRole`. The action requires
   `members.manage` (the same admin bundle as inviting and removing members) and takes the
   workspace from the caller's resolved membership (`requirePermission`); the member id only
   selects within it, and a member of another workspace is `not_found`. An admin may demote
   themself while another admin remains. Setting the role a member already has is a no-op
   success. A real change writes one audit line, `workspace.member_role_changed` with the
   workspace id, the acting membership id, the changed membership id and the new role
   (`src/platform/observability`'s `logAuditEvent`, no personal data).
3. **The last admin is protected in the use cases, under the workspace row lock.** Every
   operation that can take away an admin (`setMemberRole` to `member`, `removeMember`,
   `leaveWorkspace`) runs in one transaction that first takes `lockForUpdate` on the workspace
   row, then counts the admins (`WorkspaceMemberRepository.countAdmins`) and refuses with the
   stable code `last_admin` when the target is an admin and no other admin exists. The lock makes
   every such decision for one workspace serialize: two admins demoting each other, leaving, or
   removing each other at the same moment end with exactly one admin, the second request getting
   `last_admin`. `last_admin` replaces `cannot_leave_as_admin`.
4. **No database-level "at least one admin" check.** A deferred constraint trigger in the style
   of `src/persistence/sql/ledger_balanced_entries/` was considered and not added: membership rows
   also disappear through two cascades, the workspace deletion (which must remove every admin)
   and `workspace_members.user_id`'s `on delete cascade` from `auth.user`, and a trigger would
   have to special-case both. Every application path that changes roles or deletes a single
   membership goes through the three use cases above, the lock makes them race-free, and the
   database tests prove it (`src/persistence/tests/workspaces-several-admins.db.test.ts`).
5. **Leaving and removing.** Any member may leave, an admin included, as long as another admin
   remains; the last admin promotes someone first or deletes the workspace. An admin may remove
   another admin (never themself, `cannot_remove_self`). The team page offers "Arbeitsbereich
   verlassen" and "Admin-Rechte entziehen" on the caller's own row only while another admin
   exists; the use cases re-check it regardless.
6. **Workspace deletion is unchanged.** Any admin may delete the workspace (`workspace.manage`),
   with the typed name confirmation and, once invoices were issued, the archive confirmation
   (decisions/0079).
7. **Invitations still create members.** An invited person joins as `member`; an admin promotes
   them afterwards. Inviting as admin would add a role choice to the invitation row and form for
   a step that takes one click after acceptance.
8. **Admin notices go to every admin.** `getWorkspaceWithAdminContact` became
   `getWorkspaceWithAdminContacts`, returning every admin's e-mail address, oldest membership
   first. The quota warning (decisions/0017) and the E-Mail-Eingang rejection notice
   (decisions/0075) are sent to each admin as a separate message (no admin sees another's address
   in `to`). Each admin can act on either notice, so none of them should miss it. If one send
   fails, the others are still tried and the job then fails and is retried, which can repeat the
   notice for an admin who already got it; both notices are informational, so a rare duplicate
   is accepted over a missed one.

The MCP server has no tool that lists or changes members, so nothing there changes;
`list_workspaces` already reports the caller's own role per workspace.

## Consequences

- Positive: two co-founders can both see and manage finance without loosening the admin-only
  finance rule.
- Positive: a workspace can no longer lose its only admin through any application path,
  including concurrent requests.
- Negative: the invariant lives in application code plus a lock, not in a constraint. A future
  path that changes `workspace_members.role` or deletes an admin's membership row without going
  through `setMemberRole`/`removeMember`/`leaveWorkspace` would bypass it; this ADR's maintenance
  triggers name that.
- Negative: a user-account deletion (none exists in the product today) would cascade away that
  user's admin memberships without the check. Such a flow must refuse, or ask for a successor,
  when the user is a workspace's last admin.
- Neutral: a demoted admin's open page keeps its rendered controls until the next request; every
  action re-checks `members.manage`, so nothing beyond what the server allows can happen.

## Supersedes / Superseded By
- Supersedes decisions/0014-workspaces-and-access.md, point 1, on "exactly one admin per
  workspace" (its one-workspace-per-user half was already superseded by
  decisions/0070-several-workspaces-per-user.md).
- Supersedes decisions/0027-hardening-and-deletion.md's "the use case rejects the workspace's own
  admin with `cannot_leave_as_admin`" in its member self-removal section.
