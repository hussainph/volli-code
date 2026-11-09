import * as React from "react";
import type { Project } from "@volli/shared";
import { FolderOpenIcon } from "@renderer/components/ui/icon";

import { Spinner } from "@renderer/components/ui/spinner";

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
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { sessionPanes, useSessionsStore } from "@renderer/stores/sessions";
import { busySessionInfo } from "@renderer/terminal/close-guard";

import { openTurnCount, removeProjectBusyLines, runningShellCount } from "./remove-project-busy";
import { PathText } from "@renderer/components/ui/path-text";

interface RemoveProjectDialogProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The live pane ids removing `projectId` would kill: its Board Sessions PLUS
 * every ticket session whose scope belongs to it (mirrors
 * `forgetProjectSessions`'s enumeration). Only panes still live (no exit
 * code) — an exited pane has no PTY left to end.
 */
function liveSessionIdsForProject(projectId: string): string[] {
  const ids: string[] = [];
  for (const [ownerId, container] of Object.entries(useSessionsStore.getState().byOwner)) {
    const belongsToProject =
      ownerId === projectId ||
      container.tabs.some(
        (tab) => tab.scope.kind === "ticket" && tab.scope.projectId === projectId,
      );
    if (!belongsToProject) continue;
    for (const tab of container.tabs) {
      for (const pane of sessionPanes(tab.layout)) {
        if (pane.exitCode === null) ids.push(pane.sessionId);
      }
    }
  }
  return ids;
}

export function RemoveProjectDialog({ project, open, onOpenChange }: RemoveProjectDialogProps) {
  const removeProject = useProjectsStore((state) => state.removeProject);
  // Busy foreground processes across the project's live sessions, filled in when
  // the (fail-open) probe resolves — the dialog renders immediately regardless.
  const [busyProcesses, setBusyProcesses] = React.useState<string[]>([]);
  const [removing, setRemoving] = React.useState(false);
  // The structured Sessions and background shells the host also stops (VC-796),
  // read from what this window already holds.
  const openTurns = useProjectSessionsStore((state) =>
    openTurnCount(state.byProject[project.id]?.chat),
  );
  const runningShells = useBackgroundShellsStore((state) =>
    runningShellCount(state.byId, project.id),
  );
  const busyLines = removeProjectBusyLines({ busyProcesses, openTurns, runningShells });

  React.useEffect(() => {
    if (!open) {
      setBusyProcesses([]);
      return;
    }
    let cancelled = false;
    // Fail-open like the probe: a listing that cannot be read counts nothing.
    void useProjectSessionsStore.getState().ensure(project.id);
    void busySessionInfo(liveSessionIdsForProject(project.id)).then((busy) => {
      if (!cancelled) setBusyProcesses(busy.map((entry) => entry.process));
    });
    return () => {
      cancelled = true;
    };
  }, [open, project.id]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {project.name} from Volli?</AlertDialogTitle>
          <AlertDialogDescription>
            {/* Removal detaches the project (VC-822): nothing is deleted. */}
            The folder, its tickets and its Sessions are kept.
            {busyLines.map((line) => (
              <span key={line} className="mt-2 block text-destructive">
                {line}
              </span>
            ))}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-w-0 items-center gap-2 rounded-control border border-border bg-muted/30 px-2 py-2">
          <FolderOpenIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <PathText path={project.path} className="text-ui" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={removing}
            onClick={(event) => {
              event.preventDefault();
              if (removing) return;
              setRemoving(true);
              void removeProject(project.id)
                .then(() => onOpenChange(false))
                .finally(() => setRemoving(false));
            }}
          >
            {removing ? <Spinner /> : null}
            {removing ? "Removing" : "Remove project"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
