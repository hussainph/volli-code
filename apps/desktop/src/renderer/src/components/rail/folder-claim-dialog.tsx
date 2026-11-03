/**
 * "Is this folder a project you already have?" (VC-430)
 *
 * The trap this closes is the one the ticket opens with. A project whose folder
 * was renamed keeps a row that points at a path which no longer resolves. The
 * board breaks, and the thing a person reaches for is the `+` tile: add the
 * folder where the work actually is. That makes a SECOND project — a new id,
 * an empty board, none of the first one's tickets, settings or history — and
 * nothing on screen says so. The first project is still there, still broken.
 *
 * Volli cannot answer this on its own. The old path is gone, so there is no
 * folder left to compare the new one against; only the person knows whether
 * `~/code/volli` is the `~/volli` that Volli has lost. So it asks, and it asks
 * only when the question is real: a project's registered folder has to be
 * missing for a candidate to exist at all.
 *
 * Both answers are here, and neither is the default: nothing is added and
 * nothing is relinked until one is chosen.
 */
import * as React from "react";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { FolderPlusIcon } from "@phosphor-icons/react/dist/csr/FolderPlus";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { projectRelinkNotices, projectRelinkNoticeText } from "@volli/shared";
import type { ProjectRelinkAftermath } from "@volli/shared";

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
import { useProjectsStore } from "@renderer/stores/projects";

/**
 * Mounted once, beside the rail, rather than at either entry point: the `+`
 * tile and the empty sidebar's "Add Project" raise the same question, and the
 * claim lives in the store so one surface can answer it for both.
 */
export function FolderClaimDialog() {
  const claim = useProjectsStore((state) => state.folderClaim);
  const addAsNew = useProjectsStore((state) => state.resolveClaimAsNewProject);
  const relinkTo = useProjectsStore((state) => state.resolveClaimAsRelink);
  const dismiss = useProjectsStore((state) => state.dismissFolderClaim);
  const [busy, setBusy] = React.useState(false);
  // Set when a relink chosen here left something behind. The claim is gone by
  // then, so this is what keeps the dialog on screen long enough to say so.
  const [aftermath, setAftermath] = React.useState<ProjectRelinkAftermath | null>(null);

  async function choose(run: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  }

  const notices = aftermath === null ? [] : projectRelinkNotices(aftermath);
  const open = claim !== null || aftermath !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setAftermath(null);
        dismiss();
      }}
    >
      <DialogContent>
        {aftermath === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Is this a project you already have?</DialogTitle>
              <DialogDescription>
                Volli can't find the folder for the project
                {(claim?.candidates.length ?? 0) > 1 ? "s" : ""} below. If you moved or renamed one
                of them, relink it instead of adding a second copy — its tickets, settings and
                history stay with it.
              </DialogDescription>
            </DialogHeader>

            <p className="truncate text-ui text-muted-foreground" title={claim?.path}>
              {claim?.path}
            </p>

            <div className="flex flex-col gap-2">
              {claim?.candidates.map((candidate) => (
                <Button
                  key={candidate.id}
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void choose(async () => {
                      const settled = await relinkTo(candidate.id);
                      // Keep the dialog up only when the move left something a
                      // person has to know about; otherwise it just worked.
                      if (settled.ok && projectRelinkNotices(settled.aftermath).length > 0) {
                        setAftermath(settled.aftermath);
                      }
                    })
                  }
                >
                  <ArrowsLeftRightIcon />
                  This is {candidate.name}
                  <span className="truncate text-ui text-muted-foreground">{candidate.path}</span>
                </Button>
              ))}
            </div>

            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => dismiss()}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => void choose(addAsNew)}>
                <FolderPlusIcon />
                Add as a new project
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Relinked</DialogTitle>
              <DialogDescription>
                The move is saved. Some of it could not follow on its own:
              </DialogDescription>
            </DialogHeader>
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
            <DialogFooter>
              <Button onClick={() => setAftermath(null)}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
