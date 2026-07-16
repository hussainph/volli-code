import * as React from "react";
import type { Project } from "@volli/shared";

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
import { useProjectsStore } from "@renderer/stores/projects";
import { sessionPanes, useSessionsStore } from "@renderer/stores/sessions";
import { busySessionInfo, describeBusy } from "@renderer/terminal/close-guard";

interface RemoveProjectDialogProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The live pane ids removing `projectId` would kill: its scratch sessions PLUS
 * every ticket session whose scope belongs to it (mirrors
 * `killProjectTicketSessions`'s enumeration). Only panes still live (no exit
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

  React.useEffect(() => {
    if (!open) {
      setBusyProcesses([]);
      return;
    }
    let cancelled = false;
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
            This removes the project from Volli; the folder on disk is untouched.
            {busyProcesses.length > 0 && (
              <span className="mt-2 block text-destructive">
                {describeBusy(busyProcesses, " — removing the project will end")}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => removeProject(project.id)}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
