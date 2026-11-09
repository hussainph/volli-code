import type { DirEntry, Project } from "@volli/shared";
import { FileTreeNavigator } from "@renderer/components/files/file-tree-navigator";
import type { FileNavigatorControls } from "@renderer/components/files/use-navigator-mutations";
import { TicketFilesList } from "@renderer/components/ticket/ticket-files-panel";
import { useProjectUiStore } from "@renderer/stores/project-ui";

/** Join one Main-checkout listing entry to the current project-relative folder. */
function joinRel(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/**
 * Home's Main-checkout listing in the ticket rail's established navigator
 * drawing: one flat current-folder list, click-to-preview and double-click-to-pin.
 */
export function HomeFilesList({
  projectId,
  cwd,
  entries,
  controls,
  canClaimEmpty,
  emptyLabel,
  onPreviewFile,
  onPinFile,
  onOpenDirectory,
}: {
  projectId: string;
  cwd: string;
  entries: readonly DirEntry[];
  /** The create/rename/duplicate/delete controller (VC-191); absent in fixtures. */
  controls?: FileNavigatorControls;
  /** Whether a read has landed — see {@link TicketFilesList}. */
  canClaimEmpty?: boolean;
  emptyLabel?: string;
  onPreviewFile(relPath: string): void;
  onPinFile(relPath: string): void;
  onOpenDirectory(relPath: string): void;
}) {
  return (
    <TicketFilesList
      projectId={projectId}
      referenced={[]}
      worktree={entries.map((entry) => ({
        relPath: joinRel(cwd, entry.name),
        kind: entry.kind === "dir" ? "directory" : "file",
      }))}
      controls={controls}
      canClaimEmpty={canClaimEmpty}
      emptyLabel={emptyLabel}
      onPreviewFile={onPreviewFile}
      onPinFile={onPinFile}
      onOpenDirectory={onOpenDirectory}
    />
  );
}

/** The shared tree rooted in the project's main checkout. */
export function HomeFilesPanel(props: {
  project: Project;
  onPreviewFile(relPath: string): void;
  onPinFile(relPath: string): void;
}) {
  return <HomeFilesScope key={props.project.id} {...props} />;
}

function HomeFilesScope({
  project,
  onPreviewFile,
  onPinFile,
}: {
  project: Project;
  onPreviewFile(relPath: string): void;
  onPinFile(relPath: string): void;
}) {
  return (
    <div data-testid="home-files-panel" className="flex min-h-0 flex-1 flex-col">
      <FileTreeNavigator
        projectId={project.id}
        root={project.name}
        onOpen={onPreviewFile}
        onPin={onPinFile}
        onRename={(from, to) => useProjectUiStore.getState().renameHomeFile(project.id, from, to)}
      />
    </div>
  );
}
