/**
 * The Project Files workbench (CONCEPT #54/#55/#56), rooted exclusively in the
 * selected project's Main checkout.
 *
 * This first-class nav consumer is intentionally thin now that Home presents
 * the same FileWorkspaceState and FileView in its mixed strip. The shared
 * controller owns dirty-model seeding, conflict-guarded close, and Monaco view
 * state; this page contributes only its dedicated file-only tab strip and empty
 * state. VC-122 may retire this consumer without touching that substrate.
 */
import * as React from "react";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import type { Project } from "@volli/shared";

import { FileTabStrip } from "@renderer/components/files/file-tab-strip";
import { FileSaveGuardDialog } from "@renderer/components/files/save-guard-dialog";
import { useProjectFileWorkspace } from "@renderer/components/files/use-project-file-workspace";
import { FileView } from "@renderer/components/ticket/file-view";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { cn } from "@renderer/lib/utils";
import { useWorkspaceStore } from "@renderer/stores/workspace";

export function FilesPage() {
  const project = useSelectedProject();
  return project === null ? null : <FilesWorkbench key={project.id} project={project} />;
}

function FilesWorkbench({ project }: { project: Project }) {
  const projectId = project.id;
  const activateProjectFile = useWorkspaceStore((state) => state.activateProjectFile);
  const pinProjectFile = useWorkspaceStore((state) => state.pinProjectFile);
  const closeProjectFile = useWorkspaceStore((state) => state.closeProjectFile);
  const closeFileFromPage = React.useCallback(
    (relPath: string) => closeProjectFile(projectId, relPath),
    [closeProjectFile, projectId],
  );
  const workspace = useProjectFileWorkspace(projectId, closeFileFromPage);
  const activeRelPath = workspace.files.activeRelPath;

  return (
    <div data-testid="files-workbench" className="flex min-h-0 flex-1 flex-col">
      <FileTabStrip
        tabs={workspace.files.tabs}
        activeRelPath={activeRelPath}
        dirtyPaths={workspace.dirtyPaths}
        onSelect={(relPath) => activateProjectFile(projectId, relPath)}
        onPin={(relPath) => pinProjectFile(projectId, relPath)}
        onClose={(relPath) => void workspace.requestClose(relPath)}
        onCloseOthers={(keep) => void workspace.requestCloseOthers(keep)}
      />

      {activeRelPath === null ? (
        <NoOpenFile />
      ) : (
        <FileView
          key={activeRelPath}
          projectId={projectId}
          relPath={activeRelPath}
          initialViewState={workspace.viewStates[activeRelPath]}
          onViewStateChange={workspace.handleViewStateChange}
          onDirtyChange={workspace.handleDirtyChange}
        />
      )}

      <FileSaveGuardDialog
        relPath={workspace.pendingRelPath}
        onCancel={workspace.cancelClose}
        onChoose={workspace.chooseClose}
      />
    </div>
  );
}

function NoOpenFile() {
  return (
    <div data-testid="files-empty-state" className={cn("flex-1", EMPTY_PAGE)}>
      <FoldersIcon className="size-8 text-muted-foreground" />
      <h2 className="text-heading font-semibold">Files</h2>
      <p className="text-sm text-muted-foreground">Select a file in the sidebar.</p>
    </div>
  );
}
