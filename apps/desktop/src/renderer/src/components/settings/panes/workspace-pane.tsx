/** The Workspace roster, invitations and sharing policy, only mounted in a cloud launch. */
import * as React from "react";
import { BuildingsIcon } from "@phosphor-icons/react/dist/csr/Buildings";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { EnvelopeIcon } from "@phosphor-icons/react/dist/csr/Envelope";
import { ShareNetworkIcon } from "@phosphor-icons/react/dist/csr/ShareNetwork";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import {
  canInviteAs,
  canReissueInvite,
  canRevokeInvite,
  decideMemberChange,
  type MemberRole,
  type MembershipFacts,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import {
  CommitField,
  Empty,
  PrefRow,
  PrefSection,
  SectionAction,
} from "@renderer/components/settings/kit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { ListRow } from "@renderer/components/ui/list-row";
import { Segmented } from "@renderer/components/ui/segmented";
import { Switch } from "@renderer/components/ui/switch";
import { toastError } from "@renderer/lib/toast";
import { CLOUD_READ_ONLY } from "@renderer/stores/cloud-board/source";
import type { Loaded } from "./use-runners";
import { useWorkspace, type CreatedInvite, type Member, type PendingInvite } from "./use-workspace";

const ROLES: readonly MemberRole[] = ["member", "admin", "owner"];
const roleLabel = (role: MemberRole) => role[0]!.toUpperCase() + role.slice(1);
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "That didn’t work.";
const facts = (workspaceId: string, member: Member): MembershipFacts => ({
  workspaceId: workspaceId as WorkspaceId,
  userId: member.userId as UserId,
  role: member.role,
  status: member.status,
});

function ReadState<T>({
  view,
  loading,
  offline,
  children,
}: {
  view: Loaded<T>;
  loading: string;
  offline: boolean;
  children: (value: T) => React.ReactNode;
}) {
  if (view.kind === "failed") return <Empty>{view.message}</Empty>;
  if (view.kind === "loading")
    return <Empty>{offline ? "Volli Cloud is offline." : loading}</Empty>;
  return children(view.value);
}

type InviteDraft = { email: string | null; role: MemberRole; created?: CreatedInvite };

export function WorkspacePane(props: Parameters<typeof useWorkspace>[0] = {}) {
  const state = useWorkspace(props);
  const { workspace, members, policy, invites, mine, viewer, commands, readOnly, workspaceId } =
    state;
  const [busy, setBusy] = React.useState(false);
  // The ref closes the double-click window before React commits the disabled controls.
  const pending = React.useRef(false);
  const [confirm, setConfirm] = React.useState<Member | "leave" | null>(null);
  const [draft, setDraft] = React.useState<InviteDraft | null>(null);
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    setDraft(null);
    setConfirm(null);
  }, [workspaceId]);
  const locked = readOnly || busy;
  const rows = members.kind === "ready" ? members.value : [];
  const me =
    viewer.kind === "ready" ? rows.find((m) => m.userId === viewer.value?.userId) : undefined;
  const actor = me === undefined || workspaceId === null ? null : facts(workspaceId, me);
  const activeOwners = rows.filter((m) => m.role === "owner" && m.status === "active").length;
  const admin = actor?.role === "owner" || actor?.role === "admin";
  const allowedRoles =
    actor === null || policy.kind !== "ready"
      ? []
      : ROLES.filter((role) => canInviteAs(actor, actor.workspaceId, actor, role, policy.value));
  const canLeave =
    actor !== null && decideMemberChange(actor, actor, { kind: "leave" }, activeOwners) === null;
  const failed = [workspace, members, policy, invites, mine, viewer].some(
    (view) => view.kind === "failed",
  );
  const retry = failed ? <SectionAction label="Retry" onAct={state.retry} /> : undefined;
  const perform = async (run: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await run();
    } catch (error) {
      toastError(messageOf(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const showInvite = (next: InviteDraft) => {
    setCopied(false);
    setDraft(next);
  };
  const inviteFacts = (invite: PendingInvite) => ({
    workspaceId: workspaceId as WorkspaceId,
    invitedByUserId: invite.invitedByUserId as UserId,
    role: invite.role,
  });

  return (
    <>
      <PrefSection title="Workspace" icon={BuildingsIcon} action={retry}>
        {workspaceId === null ? (
          <Empty>No Workspace selected.</Empty>
        ) : (
          <ReadState view={workspace} loading="Loading Workspace…" offline={readOnly}>
            {(value) => (
              <>
                <PrefRow label="Name" htmlFor="workspace-name">
                  {admin ? (
                    <CommitField
                      id="workspace-name"
                      value={value.name}
                      disabled={locked}
                      onCommit={async (name) => {
                        try {
                          const result = await commands.rename(name);
                          return { ok: true, value: result.name };
                        } catch (error) {
                          return { ok: false, error: messageOf(error) };
                        }
                      }}
                    />
                  ) : (
                    <span className="text-ui">{value.name}</span>
                  )}
                </PrefRow>
                <PrefRow label="Your role">
                  <span className="text-ui">{roleLabel(value.role)}</span>
                </PrefRow>
                <PrefRow label="Membership">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={locked || !canLeave}
                    onClick={() => setConfirm("leave")}
                  >
                    Leave…
                  </Button>
                </PrefRow>
                {actor?.role === "owner" && !canLeave ? (
                  <p className="text-ui text-muted-foreground">
                    Make someone else an owner before leaving.
                  </p>
                ) : null}
              </>
            )}
          </ReadState>
        )}
        {viewer.kind === "failed" ? <Empty>{viewer.message}</Empty> : null}
        {readOnly && workspace.kind === "ready" ? (
          <p role="status" className="text-ui text-muted-foreground">
            {CLOUD_READ_ONLY}
          </p>
        ) : null}
      </PrefSection>
      {workspaceId !== null ? (
        <>
          <PrefSection
            title="Members"
            icon={UsersIcon}
            action={
              allowedRoles.length > 0 ? (
                <SectionAction
                  label="Invite"
                  disabled={locked}
                  onAct={() => showInvite({ email: "", role: "member" })}
                />
              ) : undefined
            }
          >
            <ReadState view={members} loading="Loading members…" offline={readOnly}>
              {(value) => (
                <>
                  {value.map((member) => {
                    const target = facts(workspaceId, member);
                    const roles =
                      actor === null
                        ? []
                        : ROLES.filter(
                            (role) =>
                              role !== member.role &&
                              decideMemberChange(
                                actor,
                                target,
                                { kind: "set_role", role },
                                activeOwners,
                              ) === null,
                          );
                    const remove =
                      actor !== null &&
                      decideMemberChange(actor, target, { kind: "remove" }, activeOwners) === null;
                    return (
                      <ListRow
                        key={member.userId}
                        density="two-line"
                        primary={member.displayName}
                        secondary={member.email ?? undefined}
                        trailing={
                          <span className="text-ui text-muted-foreground">
                            {roleLabel(member.role)}
                            {member.status === "suspended" ? " · Suspended" : ""}
                            {member.userId === me?.userId ? " · You" : ""}
                          </span>
                        }
                        onActivate={null}
                        actions={
                          roles.length > 0 || remove ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label={`More for ${member.displayName}`}
                                  disabled={locked}
                                >
                                  <DotsThreeIcon weight="bold" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {roles.map((role) => (
                                  <DropdownMenuItem
                                    key={role}
                                    onSelect={() =>
                                      void perform(() => commands.setRole(member.userId, role))
                                    }
                                  >
                                    <UserCircleIcon />
                                    {roleLabel(role)}
                                  </DropdownMenuItem>
                                ))}
                                {remove ? (
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onSelect={() => setConfirm(member)}
                                  >
                                    <TrashIcon />
                                    Remove…
                                  </DropdownMenuItem>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : undefined
                        }
                      />
                    );
                  })}
                  {value.length === 1 && value[0]?.userId === me?.userId ? (
                    <Empty>Just you so far.</Empty>
                  ) : null}
                </>
              )}
            </ReadState>
          </PrefSection>
          {invites.kind !== "ready" || invites.value.length > 0 ? (
            <PrefSection title="Invites" icon={EnvelopeIcon}>
              <ReadState view={invites} loading="Loading invites…" offline={readOnly}>
                {(value) =>
                  value.map((invite) => (
                    <ListRow
                      key={invite.inviteId}
                      density="two-line"
                      primary={invite.email ?? "Single-use code"}
                      secondary={[roleLabel(invite.role), previewLabel(invite.preview)]
                        .filter(Boolean)
                        .join(" · ")}
                      onActivate={null}
                      actions={
                        <div className="flex gap-2">
                          {actor !== null &&
                          policy.kind === "ready" &&
                          canReissueInvite(
                            actor,
                            actor,
                            inviteFacts(invite),
                            invite.role,
                            policy.value,
                          ) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={locked}
                              onClick={() =>
                                void perform(async () => {
                                  const created = await commands.newCode(invite);
                                  showInvite({ email: invite.email, role: invite.role, created });
                                })
                              }
                            >
                              New code
                            </Button>
                          ) : null}
                          {actor !== null && canRevokeInvite(actor, actor, inviteFacts(invite)) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={locked}
                              onClick={() => void perform(() => commands.revoke(invite.inviteId))}
                            >
                              Revoke
                            </Button>
                          ) : null}
                        </div>
                      }
                    />
                  ))
                }
              </ReadState>
            </PrefSection>
          ) : null}
          <PrefSection title="Sharing" icon={ShareNetworkIcon}>
            <ReadState view={policy} loading="Loading sharing…" offline={readOnly}>
              {(value) => (
                <>
                  <PrefRow label="Make everything shared" htmlFor="workspace-share-all">
                    <Switch
                      id="workspace-share-all"
                      aria-label="Make everything shared"
                      checked={value.shareAll}
                      disabled={locked || !admin}
                      onCheckedChange={(shareAll) =>
                        void perform(() => commands.setPolicy({ shareAll }, value.revision))
                      }
                    />
                  </PrefRow>
                  <PrefRow label="Who can invite">
                    <Segmented
                      ariaLabel="Who can invite"
                      value={value.whoCanInvite}
                      options={[
                        { key: "members", label: "Members" },
                        { key: "admins", label: "Admins" },
                      ]}
                      disabled={locked || !admin}
                      onChange={(whoCanInvite) =>
                        void perform(() => commands.setPolicy({ whoCanInvite }, value.revision))
                      }
                    />
                  </PrefRow>
                </>
              )}
            </ReadState>
          </PrefSection>
        </>
      ) : null}
      {mine.kind !== "ready" || mine.value.length > 0 ? (
        <PrefSection title="Invitations to you" icon={EnvelopeIcon}>
          <ReadState view={mine} loading="Loading invitations…" offline={readOnly}>
            {(value) =>
              value.map((invite) => (
                <ListRow
                  key={invite.inviteId}
                  density="two-line"
                  primary={invite.workspaceName}
                  secondary={`${roleLabel(invite.role)} · From ${invite.invitedByName}`}
                  onActivate={null}
                  actions={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={locked}
                      onClick={() => void perform(() => commands.join(invite.inviteId))}
                    >
                      Join
                    </Button>
                  }
                />
              ))
            }
          </ReadState>
        </PrefSection>
      ) : null}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "leave" ? "Leave this Workspace?" : `Remove ${confirm?.displayName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "leave"
                ? "Your shared work stays; your private chats are hidden."
                : "Their shared work stays; their private chats are hidden."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              disabled={locked}
              onClick={() => {
                const target = confirm;
                if (target !== null)
                  void perform(() =>
                    target === "leave" ? commands.leave() : commands.remove(target.userId),
                  );
              }}
            >
              {confirm === "leave" ? "Leave" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {draft !== null ? (
        <InviteDialog
          key={draft.created?.token ?? "new"}
          draft={draft}
          name={workspace.kind === "ready" ? workspace.value.name : "Workspace"}
          roles={allowedRoles}
          locked={locked}
          copied={copied}
          onClose={() => setDraft(null)}
          onCreate={(email, role) =>
            void perform(async () => {
              const created = await commands.create(email, role);
              showInvite({ email, role, created });
            })
          }
          onCopy={(message) =>
            void perform(async () => {
              await navigator.clipboard.writeText(message);
              setCopied(true);
            })
          }
        />
      ) : null}
    </>
  );
}

function previewLabel(preview: string | undefined): string | null {
  if (preview === "granted" || preview === "sponsored" || preview === "already_granted")
    return "They can join now";
  if (preview === "needs_access") return "They need preview access from Volli first";
  // An older API, or a future verdict we cannot interpret: never invent a claim about access.
  return null;
}

function InviteDialog({
  draft,
  name,
  roles,
  locked,
  copied,
  onClose,
  onCreate,
  onCopy,
}: {
  draft: InviteDraft;
  name: string;
  roles: readonly MemberRole[];
  locked: boolean;
  copied: boolean;
  onClose(): void;
  onCreate(email: string | null, role: MemberRole): void;
  onCopy(message: string): void;
}) {
  const [kind, setKind] = React.useState<"email" | "code">(draft.email === null ? "code" : "email");
  const [email, setEmail] = React.useState(draft.email ?? "");
  const [role, setRole] = React.useState(draft.role);
  const created = draft.created;
  // TODO(VC-971 PR 1 / PR 3): add code-redemption instructions when sign-in / switcher can receive it.
  const message =
    draft.email === null
      ? `Volli Workspace invite: ${name}. Single-use code: ${created?.token ?? ""}`
      : `Join ${name} on Volli: install Volli from volli.app, open Settings → Account, and sign in with ${draft.email}. Open Settings → Workspace → Invitations to you and choose Join.`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {created === undefined ? "Invite to Workspace" : "Invite created"}
          </DialogTitle>
          <DialogDescription>
            People you invite see every project here and its ticket Sessions, including moved
            history. Private chats stay private.
          </DialogDescription>
        </DialogHeader>
        {created === undefined ? (
          <div className="flex flex-col gap-4">
            <Segmented<"email" | "code">
              ariaLabel="Invite type"
              value={kind}
              options={[
                { key: "email", label: "Email" },
                { key: "code", label: "Code" },
              ]}
              disabled={locked}
              onChange={setKind}
            />
            <form
              id="workspace-invite"
              onSubmit={(event) => {
                event.preventDefault();
                if (!locked && roles.includes(role))
                  onCreate(kind === "code" ? null : email.trim(), role);
              }}
            >
              {kind === "email" ? (
                <div className="flex flex-col gap-2">
                  <label className="text-ui" htmlFor="invite-email">
                    Email
                  </label>
                  <Input
                    id="invite-email"
                    type="email"
                    required
                    value={email}
                    disabled={locked}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
              ) : null}
            </form>
            <PrefRow label="Role">
              <Segmented<MemberRole>
                ariaLabel="Invite role"
                value={role}
                options={roles.map((key) => ({ key, label: roleLabel(key) }))}
                disabled={locked}
                onChange={setRole}
              />
            </PrefRow>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {previewLabel(created.preview) !== null ? (
              <p role="status" className="text-ui">
                {previewLabel(created.preview)}
              </p>
            ) : null}
            {draft.email === null ? (
              <Input aria-label="Invite code" value={created.token} readOnly />
            ) : null}
            <p className="text-ui wrap-anywhere select-text">{message}</p>
          </div>
        )}
        <DialogFooter>
          {created === undefined ? (
            <Button
              size="sm"
              type="submit"
              form="workspace-invite"
              disabled={
                locked || !roles.includes(role) || (kind === "email" && email.trim() === "")
              }
            >
              Create invite
            </Button>
          ) : (
            <Button size="sm" disabled={locked} onClick={() => onCopy(message)}>
              {copied ? "Copied" : "Copy invite"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
