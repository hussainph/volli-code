import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { WorkspaceIdentityEditor } from "@renderer/components/workspace-identity/editor";
import { useProjectsStore } from "@renderer/stores/projects";

/** Window-level, shared by the rail and empty-state native picker doors. */
export function NewProjectDialog() {
  const draft = useProjectsStore((state) => state.newProjectDraft);
  const busy = useProjectsStore((state) => state.creatingProject);
  const projects = useProjectsStore((state) => state.projects);
  const create = useProjectsStore((state) => state.createDraftProject);
  const dismiss = useProjectsStore((state) => state.dismissNewProject);
  const usedGlyphs = projects.flatMap((project) => {
    const choice = project.workspaceIdentity?.choice;
    return choice?.kind === "glyph" ? [choice.name] : [];
  });
  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[calc(100svh-4rem)] w-[calc(100vw-2rem)] overflow-y-auto p-0 sm:max-w-workbench"
        showCloseButton={!busy}
      >
        <DialogTitle className="sr-only">New workspace</DialogTitle>
        {draft && (
          <WorkspaceIdentityEditor
            key={draft.seed}
            defaultName={draft.defaultName}
            seed={draft.seed}
            folderPath={draft.path}
            usedGlyphs={usedGlyphs}
            busy={busy}
            onCommit={create}
            onCancel={dismiss}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
