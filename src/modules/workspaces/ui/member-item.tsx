"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { removeMemberAction, setMemberRoleAction } from "../actions";
import type { WorkspaceMemberListItem } from "../core/types";
import type { WorkspaceActionErrorCode } from "../core/error-codes";

type Role = WorkspaceMemberListItem["role"];

/** One row of `/dashboard/team`. For a caller with `members.manage`: "Zum Admin machen" on a
 * member, "Admin-Rechte entziehen" (with a confirmation) on an admin, including the caller's own
 * row as long as another admin remains (decisions/0082-several-admins-per-workspace.md), and
 * "Entfernen" on everyone but the caller. The server re-checks all of it (`last_admin`); hiding a
 * button here is only convenience. */
export function MemberItem({
  member,
  isSelf,
  canManageMembers,
  otherAdminExists,
  onRemoved,
  onRoleChanged,
}: {
  member: WorkspaceMemberListItem;
  isSelf: boolean;
  canManageMembers: boolean;
  /** Whether some admin other than this row's member exists - demoting the last admin is
   * refused, so the button is not offered then. */
  otherAdminExists: boolean;
  onRemoved: (id: string) => void;
  onRoleChanged: (id: string, role: Role, selfChanged: boolean) => void;
}) {
  const t = useTranslations("Team.members");
  const tErrors = useTranslations("Team.errors");
  const [confirming, setConfirming] = useState<"remove" | "demote" | null>(null);
  const [errorCode, setErrorCode] = useState<WorkspaceActionErrorCode>();
  const [pending, startTransition] = useTransition();

  const formattedDate = new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(member.joinedAt));

  function confirmRemove() {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await removeMemberAction({ memberId: member.id });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        setConfirming(null);
        return;
      }
      onRemoved(member.id);
    });
  }

  function changeRole(role: Role) {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await setMemberRoleAction({ memberId: member.id, role });
      setConfirming(null);
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      onRoleChanged(member.id, result.data.role, result.data.selfChanged);
    });
  }

  const canPromote = canManageMembers && member.role === "member";
  const canDemote = canManageMembers && member.role === "admin" && otherAdminExists;
  const canRemove = canManageMembers && !isSelf;

  let controls: React.ReactNode = null;
  if (confirming === "remove") {
    controls = (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t("removeConfirm")}</span>
        <Button type="button" variant="destructive" size="sm" disabled={pending} aria-busy={pending} onClick={confirmRemove}>
          {t("removeConfirmYes")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirming(null)}>
          {t("cancel")}
        </Button>
      </div>
    );
  } else if (confirming === "demote") {
    controls = (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{isSelf ? t("demoteSelfConfirm") : t("demoteConfirm")}</span>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={pending}
          aria-busy={pending}
          onClick={() => changeRole("member")}
        >
          {t("demoteConfirmYes")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirming(null)}>
          {t("cancel")}
        </Button>
      </div>
    );
  } else if (canPromote || canDemote || canRemove) {
    controls = (
      <div className="flex flex-wrap items-center gap-2">
        {canPromote ? (
          <Button type="button" variant="outline" size="sm" disabled={pending} aria-busy={pending} onClick={() => changeRole("admin")}>
            {t("promote")}
          </Button>
        ) : null}
        {canDemote ? (
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirming("demote")}>
            {t("demote")}
          </Button>
        ) : null}
        {canRemove ? (
          <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => setConfirming("remove")}>
            {t("remove")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
            <span>
              {member.name}
              {isSelf ? ` (${t("you")})` : ""}
            </span>
            <span
              data-testid="member-role"
              className={
                member.role === "admin"
                  ? "rounded-full bg-primary px-2 py-0.5 text-xs font-normal text-primary-foreground"
                  : "rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-foreground"
              }
            >
              {member.role === "admin" ? t("roleAdmin") : t("roleMember")}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">{member.email}</p>
          <p className="text-sm text-muted-foreground">{t("joinedAt", { date: formattedDate })}</p>
        </div>
        {controls}
      </div>
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {tErrors(errorCode)}
        </p>
      ) : null}
    </li>
  );
}
