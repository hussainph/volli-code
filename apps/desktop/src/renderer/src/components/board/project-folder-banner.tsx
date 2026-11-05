/**
 * The board's recovery path for a project folder that is no longer there
 * (VC-430).
 *
 * Without it, a renamed folder is a project that looks perfectly healthy and
 * fails at everything: the file tree is empty, a Session will not start, every
 * git action errors, and none of those failures says the one true thing —
 * the folder moved. The board is where this belongs because the board is the
 * project's landing page; a person meets it before they meet the surface that
 * would otherwise fail on them.
 *
 * ONE ACTION, and it is the one that fixes it (CLAUDE.md: a fault surface
 * shows what is wrong and the one action that clears it). The path is here
 * because it is the clue, not because it is a measurement.
 */
import * as React from "react";
import { FolderOpenIcon, WarningIcon } from "@renderer/components/ui/icon";

import { RelinkProjectDialog } from "@renderer/components/rail/relink-project-dialog";
import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import { useProjectFolder } from "@renderer/hooks/use-project-folder";
import { useProjectsStore } from "@renderer/stores/projects";

/**
 * Takes an id rather than the row: the board is handed a `projectId` and a
 * `ticketPrefix`, and widening its props to carry a whole project so one
 * banner can read two fields would put a re-render on every board for every
 * theme or setting write that touches the row.
 */
export function ProjectFolderBanner({ projectId }: { projectId: string }) {
  const project = useProjectsStore((state) => state.projects.find((row) => row.id === projectId));
  const state = useProjectFolder(projectId, project?.path ?? null);
  const [relinkOpen, setRelinkOpen] = React.useState(false);

  // `null` is "we have not looked yet" or "we could not look" — neither is
  // evidence of a missing folder, and neither earns a banner.
  if (project === undefined || state === null || state === "present") return null;

  return (
    <div className="px-gutter pb-4">
      <Notice
        tone="error"
        icon={WarningIcon}
        announce
        title={state === "missing" ? "Project folder not found" : "Project path isn't a folder"}
        expandable={false}
        copyText=""
        detail={
          <span className="flex min-w-0 items-center gap-2 rounded-control border border-border bg-card px-2 py-1 text-foreground">
            <FolderOpenIcon aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{project.path}</span>
          </span>
        }
        actions={
          <Button size="sm" variant="outline" onClick={() => setRelinkOpen(true)}>
            <FolderOpenIcon />
            Relink folder
          </Button>
        }
      />
      <RelinkProjectDialog
        project={project}
        folderMissing
        open={relinkOpen}
        onOpenChange={setRelinkOpen}
      />
    </div>
  );
}
