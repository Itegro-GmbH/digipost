"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import type { PendingInvitationListItem, WorkspaceMemberListItem } from "../core/types";
import { InviteMemberForm } from "./invite-member-form";
import { InvitationItem } from "./invitation-item";
import { LeaveWorkspaceButton } from "./leave-workspace-button";
import { MemberItem } from "./member-item";

/** The `/dashboard/team` page's client island. Holds members/invitations as local state,
 * seeded from the server-rendered read model, updated directly from each Server Action's
 * own response data (instant feedback, WEBAPP_TEMPLATE_SPEC.md §8's ~100ms rule). Everyone
 * sees the member list and pending invitations; only `canManageMembers` (the caller's own
 * `members.manage` permission, resolved server-side by `src/platform/access`) renders the
 * invite form and the revoke/remove/promote/demote controls. */
export function TeamPageClient({
  members: initialMembers,
  invitations: initialInvitations,
  canManageMembers,
  currentMembershipId,
}: {
  members: WorkspaceMemberListItem[];
  invitations: PendingInvitationListItem[];
  canManageMembers: boolean;
  currentMembershipId: string;
}) {
  const t = useTranslations("Team");
  const [members, setMembers] = useState(initialMembers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const router = useRouter();
  // F5 (decisions/0027-hardening-and-deletion.md), relaxed by
  // decisions/0082-several-admins-per-workspace.md: "Arbeitsbereich verlassen" is offered to
  // everyone but the LAST admin - that one promotes someone else first or deletes the workspace
  // (the danger zone on `/dashboard/settings/company`). Derived from the member list itself
  // (already scoped to this workspace) rather than a separate prop, so it always agrees with
  // what the list actually shows; the use case re-checks it (`last_admin`).
  const currentMember = members.find((m) => m.id === currentMembershipId);
  const adminCount = members.filter((m) => m.role === "admin").length;
  const canLeave = currentMember !== undefined && (currentMember.role !== "admin" || adminCount > 1);

  function handleInvited(invitation: PendingInvitationListItem) {
    setInvitations((current) => [invitation, ...current]);
  }

  function handleRevoked(id: string) {
    setInvitations((current) => current.filter((i) => i.id !== id));
  }

  function handleRemoved(id: string) {
    setMembers((current) => current.filter((m) => m.id !== id));
  }

  function handleRoleChanged(id: string, role: WorkspaceMemberListItem["role"], selfChanged: boolean) {
    setMembers((current) => current.map((m) => (m.id === id ? { ...m, role } : m)));
    // The caller's own permissions changed (they demoted themself): `canManageMembers` and the
    // navigation come from the server, so re-render from there.
    if (selfChanged) router.refresh();
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {canManageMembers ? <InviteMemberForm onInvited={handleInvited} /> : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t("members.heading")}</h2>
        <ul className="flex flex-col gap-2">
          {members.map((member) => (
            <MemberItem
              key={member.id}
              member={member}
              isSelf={member.id === currentMembershipId}
              canManageMembers={canManageMembers}
              otherAdminExists={members.some((m) => m.role === "admin" && m.id !== member.id)}
              onRemoved={handleRemoved}
              onRoleChanged={handleRoleChanged}
            />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t("invitations.heading")}</h2>
        {invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("invitations.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {invitations.map((invitation) => (
              <InvitationItem
                key={invitation.id}
                invitation={invitation}
                canManageMembers={canManageMembers}
                onRevoked={handleRevoked}
              />
            ))}
          </ul>
        )}
      </section>

      {canLeave ? (
        <section className="flex flex-col gap-3">
          <LeaveWorkspaceButton />
        </section>
      ) : null}
    </div>
  );
}
