/** The same owner/audience marks on listing rows and the chat's header corner. */
import * as React from "react";
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { ShareNetworkIcon } from "@phosphor-icons/react/dist/csr/ShareNetwork";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { useSessionTeam, shareWithWorkspace } from "@renderer/lib/cloud-team";
import { useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";
import { useCanWrite } from "@renderer/components/hosts/use-hosts";
import { toastError } from "@renderer/lib/toast";
import { Button } from "@renderer/components/ui/button";
import { ContextMenuItem } from "@renderer/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@renderer/components/ui/alert-dialog";

export function SessionTeamMark({ sessionId }: { sessionId: string | null }) {
  const team = useSessionTeam(sessionId);
  if (team === null) return null;
  const Icon = team.private ? LockSimpleIcon : UsersIcon;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-label text-muted-foreground">
      {!team.canAct ? (
        <span aria-label={`Owner: ${team.ownerName}`} title={team.ownerName}>
          {team.initials}
        </span>
      ) : null}
      <Icon weight="bold" className="size-3" aria-label={team.visibilityLabel} />
    </span>
  );
}

export function SessionEndedLabel({ sessionId }: { sessionId: string | null }) {
  const team = useSessionTeam(sessionId);
  return team?.ended ? <span className="text-ui text-muted-foreground">{team.ended}</span> : null;
}

/** Both entry points use one irreversible confirm; no optimistic privacy change. */
export function SessionShare({
  sessionId,
  projectId,
  menu = "context",
}: {
  sessionId: string | null;
  projectId: string | null;
  menu?: "context" | "header";
}) {
  const team = useSessionTeam(sessionId);
  const workspace = useCloudWorkspaceStore((state) => state.workspace);
  const writable = useCanWrite(projectId);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  if (!team?.canShare || sessionId === null || workspace === null) return null;
  const share = async () => {
    setBusy(true);
    try {
      await shareWithWorkspace(sessionId);
      setOpen(false);
    } catch (error) {
      toastError(error instanceof Error ? error.message : "Couldn’t share this Session.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {menu === "context" ? (
        <ContextMenuItem
          icon={ShareNetworkIcon}
          disabled={!writable}
          onSelect={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          Share with workspace…
        </ContextMenuItem>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Session sharing">
              <DotsThreeIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!writable} onSelect={() => setOpen(true)}>
              <ShareNetworkIcon />
              Share with workspace…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Share with workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              Everyone in {workspace.name} can read this chat and its subagents. You can’t make it
              private again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !writable}
              onClick={(event) => {
                event.preventDefault();
                void share();
              }}
            >
              Share
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function SessionTeamHeader({
  sessionId,
  projectId,
}: {
  sessionId: string | null;
  projectId: string | null;
}) {
  return (
    <div className="absolute top-2 left-4 z-10 flex items-center gap-2 rounded-full bg-background px-2">
      <SessionTeamMark sessionId={sessionId} />
      <SessionShare sessionId={sessionId} projectId={projectId} menu="header" />
    </div>
  );
}
