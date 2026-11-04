/**
 * Reconnecting a project to the folder it moved to (VC-430).
 *
 * The recovery a renamed folder has no other door to. Removing the project and
 * adding the new folder is the thing a person reaches for, and it is exactly
 * wrong: it mints a different project and strands every ticket, setting and
 * Session on the old one. This dialog is the supported path — same project,
 * new location.
 *
 * It exists as a dialog rather than a bare folder picker for two reasons, each
 * of which is content a picker cannot hold. Before: the folder Volli is
 * looking for, which is usually the only clue a person has to where they put
 * it. After: what the move could not take with it — Sessions still running in
 * the old directory, worktrees git could not reconnect. A relink that warned
 * about those in a toast would be a warning nobody reads.
 */
import * as React from "react";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import {
  errorMessage,
  projectRelinkNotices,
  projectRelinkNoticeText,
  type Project,
  type ProjectRelinkAftermath,
} from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Notice } from "@renderer/components/ui/notice";
import { Spinner } from "@renderer/components/ui/spinner";
import { toastError } from "@renderer/lib/toast";
import { useProjectsStore } from "@renderer/stores/projects";

interface RelinkProjectDialogProps {
  project: Project;
  /** True when the registered folder has been confirmed gone — changes the framing only. */
  folderMissing?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RelinkProjectDialog({
  project,
  folderMissing = false,
  open,
  onOpenChange,
}: RelinkProjectDialogProps) {
  const relink = useProjectsStore((state) => state.relink);
  const [busy, setBusy] = React.useState(false);
  // What the completed move left behind, or `null` while nothing has moved
  // yet. Its presence is what turns this from a chooser into a report.
  const [aftermath, setAftermath] = React.useState<ProjectRelinkAftermath | null>(null);

  // Every open starts from the chooser: a report left over from the last
  // relink would describe a move this one has not made.
  React.useEffect(() => {
    if (open) setAftermath(null);
  }, [open]);

  async function chooseAndRelink(): Promise<void> {
    setBusy(true);
    try {
      const picked = await window.api.projects.pickFolder();
      if (picked.canceled) return;
      const settled = await relink(project.id, picked.path);
      if (!settled.ok) {
        // The sentence is already on screen as a toast. What is decided here is
        // whether there is anything left for this dialog to do: `unchanged`
        // means the project ALREADY points at the folder that was chosen, so
        // the chooser has nothing to offer and closing is the honest answer.
        // Every other refusal leaves a different folder to pick.
        if (settled.refusal === "unchanged") onOpenChange(false);
        return;
      }
      // Nothing to report is not a report: close, and let the surfaces that
      // were broken simply work again.
      if (projectRelinkNotices(settled.aftermath).length === 0) onOpenChange(false);
      else setAftermath(settled.aftermath);
    } catch (error) {
      toastError(`Couldn't open folder picker: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const notices = aftermath === null ? [] : projectRelinkNotices(aftermath);

  // A state, not a reassurance: the folder button is the explanation.
  const description =
    aftermath !== null ? "These items need attention:" : folderMissing ? "Folder not found" : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...(description === null ? { "aria-describedby": undefined } : {})}>
        <DialogHeader>
          <DialogTitle>
            {aftermath === null ? `Relink ${project.name}` : `${project.name} is relinked`}
          </DialogTitle>
          {description === null ? null : <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {aftermath === null ? (
          <div className="flex min-w-0 items-center gap-2 rounded-control border border-border bg-muted/30 px-2 py-2">
            <FolderOpenIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 font-mono text-ui text-foreground [overflow-wrap:anywhere]">
              {project.path}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {notices.map((notice) => (
              <Notice
                key={notice}
                tone="neutral"
                icon={WarningIcon}
                layout="stack"
                title={projectRelinkNoticeText(notice, aftermath)}
              />
            ))}
          </div>
        )}

        <DialogFooter>
          {aftermath === null ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => void chooseAndRelink()}>
                {busy ? <Spinner /> : <FolderOpenIcon />}
                {busy ? "Relinking" : "Choose folder"}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
