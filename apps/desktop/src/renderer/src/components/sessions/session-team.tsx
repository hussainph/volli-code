/** Owner/audience marks and one Share confirm, hosted outside ephemeral menus. */
import * as React from "react";
import { create } from "zustand";
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { ShareNetworkIcon } from "@phosphor-icons/react/dist/csr/ShareNetwork";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import {
  useSessionTeam,
  shareWithWorkspace,
  useCloudTeamStore,
  retryCloudTeam,
} from "@renderer/lib/cloud-team";
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

const useShareRequest = create<{
  request: { sessionId: string; projectId: string | null; workspaceId: string } | null;
}>(() => ({ request: null }));

export function SessionTeamMark({ sessionId }: { sessionId: string | null }) {
  const team = useSessionTeam(sessionId);
  if (team === null) return null;
  const Icon = team.private ? LockSimpleIcon : UsersIcon;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-label text-muted-foreground">
      {!team.canAct && team.ownerName !== "Unknown" ? (
        <span aria-label={`Owner: ${team.ownerName}`} title={team.ownerName}>
          {team.initials}
        </span>
      ) : null}
      <Icon weight="bold" className="size-3" aria-label={team.visibilityLabel} />
    </span>
  );
}

/** Menus carry only intent; their unmount cannot dismiss the confirm. */
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
  if (!team?.canShare || sessionId === null || workspace === null) return null;
  const open = () =>
    useShareRequest.setState({ request: { sessionId, projectId, workspaceId: workspace.id } });
  return menu === "context" ? (
    <ContextMenuItem icon={ShareNetworkIcon} disabled={!writable} onSelect={open}>
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
        <DropdownMenuItem disabled={!writable} onSelect={open}>
          <ShareNetworkIcon />
          Share with workspace…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** App-shell resident: exactly one irreversible confirm across all row/header entry points. */
export function SessionShareDialog() {
  const request = useShareRequest((state) => state.request);
  const workspace = useCloudWorkspaceStore((state) => state.workspace);
  const team = useSessionTeam(request?.sessionId ?? null);
  const writable = useCanWrite(request?.projectId ?? null);
  const [busy, setBusy] = React.useState(false);
  const valid =
    request !== null && workspace?.id === request.workspaceId && team?.canShare === true;
  const close = () => useShareRequest.setState({ request: null });
  React.useEffect(() => {
    if (!valid) useShareRequest.setState({ request: null });
  }, [valid]);
  const share = async () => {
    if (request === null) return;
    setBusy(true);
    try {
      await shareWithWorkspace(request.sessionId);
      close();
    } catch (error) {
      toastError(error instanceof Error ? error.message : "Couldn’t share this Session.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog
      open={valid}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Share with workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            Everyone in {workspace?.name} can read this chat and its subagents. You can’t make it
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
  );
}

export function SessionTeamHeader({
  sessionId,
  projectId,
}: {
  sessionId: string | null;
  projectId: string | null;
}) {
  const error = useCloudTeamStore((state) => state.readError);
  return (
    <div className="absolute top-2 left-4 z-10 flex items-center gap-2 rounded-full bg-background px-2">
      <SessionTeamMark sessionId={sessionId} />
      <SessionShare sessionId={sessionId} projectId={projectId} menu="header" />
      {error === null ? null : (
        <>
          <span role="status" className="text-ui text-muted-foreground">
            {error}
          </span>
          <Button size="xs" variant="ghost" onClick={retryCloudTeam}>
            Retry
          </Button>
        </>
      )}
    </div>
  );
}
