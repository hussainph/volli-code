import * as React from "react";
import { errorMessage, type DirEntry, type Project } from "@volli/shared";

import { useDirectoryWatch } from "@renderer/hooks/use-directory-watch";
import { useProjectRootsReady } from "@renderer/hooks/use-project-roots-sync";
import { useFileNavigatorMutations } from "@renderer/components/files/use-navigator-mutations";
import type { FileNavigatorControls } from "@renderer/components/files/use-navigator-mutations";
import { FilesNavigatorHeader } from "@renderer/components/files/navigator-header";
import {
  navigatorScopeKey,
  useRememberedNavigatorView,
} from "@renderer/components/files/navigator-scope-state";
import {
  NewFileRailAction,
  RAIL_PANEL_MARGIN,
  RailHeadingReadStatus,
  RailPanelSkeleton,
  RailReadFaultBody,
  railNavigatorMatch,
} from "@renderer/components/ticket/rail-panel-parts";
import {
  railReadCanClaimEmpty,
  railReadFeedback,
  type RailReadState,
} from "@renderer/components/ticket/rail-read-feedback";
import { cn } from "@renderer/lib/utils";
import { TicketFilesList } from "@renderer/components/ticket/ticket-files-panel";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** Join one Main-checkout listing entry to the current project-relative folder. */
function joinRel(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/** Resolve one project-relative folder to the absolute path the listing IPC accepts. */
function absoluteDirectory(projectPath: string, relPath: string): string {
  return relPath === "" ? projectPath : `${projectPath}/${relPath}`;
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

/**
 * Project Files in Home's rail.
 *
 * This is the ticket Files navigator one scope up: one current-folder listing,
 * an inline filter, Up in the path line, and preview/pin file gestures. Reads
 * the Main checkout through `volli:list-directory`; the current level stays
 * live through the non-recursive dir-watch seam in
 * `hooks/use-directory-watch.ts` — one level at a time, never a subtree.
 */
export function HomeFilesPanel(props: {
  project: Project;
  onPreviewFile(relPath: string): void;
  onPinFile(relPath: string): void;
}) {
  // THE PROJECT IS THE IDENTITY, spent as a `key` so switching projects is one
  // SYNCHRONOUS swap. `HomeRail` is mounted once and handed the new project
  // (`home-surface.tsx`), so clearing the rows in an effect left one frame where
  // the previous checkout's listing, its read state and its fault stood under
  // the new project's name and its New-file action. A new key is a new instance:
  // its state starts empty in the same commit, and the old instance's teardown
  // — the request counter and the directory watch — runs there, so neither a
  // late listing nor a live watcher can reach the project that replaced it.
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
  // The folder, the filter and its words, remembered per project for this run
  // of the app (`files/navigator-scope-state.ts`) — the rail unmounts this page
  // on a tab switch, and walking back to the repository root every time was
  // the audit's low-priority finding against it.
  const [view, setView] = useRememberedNavigatorView(
    navigatorScopeKey("files", { projectId: project.id }),
  );
  const { cwd, filtering, query } = view;
  const viewRef = React.useRef(view);
  viewRef.current = view;
  const rememberCwd = React.useCallback(
    (next: string) => setView({ ...viewRef.current, cwd: next }),
    [setView],
  );

  const [entries, setEntries] = React.useState<DirEntry[]>([]);
  const [detail, setDetail] = React.useState<string | null>(null);
  const [read, setRead] = React.useState<RailReadState>({
    hasData: false,
    pending: true,
    failed: false,
  });
  // `volli:list-directory` answers only for a path main already knows as a
  // project root, and child effects run before their parent's — so AppShell's
  // own mirror would land AFTER this panel's first listing. The shared hook is
  // the same gate the primary file tree waits on, spelled once.
  const rootsReady = useProjectRootsReady();
  // A fast folder change can overtake an older listing read. Only the newest
  // request may name the current folder or replace its rows.
  const requestId = React.useRef(0);

  const loadDir = React.useCallback(
    async (nextCwd: string) => {
      const request = ++requestId.current;
      setRead((prev) => ({ ...prev, pending: true }));
      try {
        const result = await window.api.fs.listDirectory(absoluteDirectory(project.path, nextCwd));
        if (request !== requestId.current) return;
        if (!result.ok) {
          setDetail(result.error);
          // Last-good rows stay; the heading carries the caveat.
          setRead((prev) => ({ hasData: prev.hasData, pending: false, failed: true }));
          return;
        }
        setDetail(null);
        setEntries(result.entries);
        setRead({ hasData: true, pending: false, failed: false });
        rememberCwd(nextCwd);
      } catch (readError) {
        if (request !== requestId.current) return;
        setDetail(errorMessage(readError));
        setRead((prev) => ({ hasData: prev.hasData, pending: false, failed: true }));
      }
    },
    [project.path, rememberCwd],
  );

  React.useEffect(() => {
    if (!rootsReady) return;
    requestId.current += 1;
    setEntries([]);
    setDetail(null);
    setRead({ hasData: false, pending: true, failed: false });
    // Whatever folder THIS project's navigator was left at — read through the
    // ref so a filter keystroke cannot re-trigger the listing.
    void loadDir(viewRef.current.cwd);

    return () => {
      requestId.current += 1;
    };
  }, [loadDir, rootsReady]);

  // The watch lives and dies with this panel — the remembered folder above is
  // plain data and keeps nothing alive once the page unmounts.
  useDirectoryWatch(project.id, read.hasData ? cwd : null, () => {
    void loadDir(cwd);
  });

  // The creation track at Home scope (VC-191): no ticketId, so every verb
  // resolves against the MAIN checkout — the same checkout this listing reads.
  // The dir-watch above would eventually notice a create or a delete on its
  // own; refreshing explicitly is what makes the row appear WITH the gesture
  // rather than a debounce later.
  const controls = useFileNavigatorMutations({
    scope: { projectId: project.id },
    cwd,
    host: {
      refresh: () => void loadDir(cwd),
      openCreated: (relPath) => useWorkspaceStore.getState().pinHomeFile(project.id, relPath),
      renameTab: (from, to) => useWorkspaceStore.getState().renameHomeFile(project.id, from, to),
    },
  });

  // On the whole project-relative path, like the ticket navigator: the same
  // magnifier cannot mean two different things on two drawings of one panel.
  const visibleEntries = entries.filter((entry) =>
    railNavigatorMatch(query, joinRel(cwd, entry.name)),
  );

  function navigateUp() {
    const slash = cwd.lastIndexOf("/");
    void loadDir(slash === -1 ? "" : cwd.slice(0, slash));
  }

  const feedback = railReadFeedback(read, "Files");

  return (
    <div data-testid="home-files-panel" className="flex min-h-0 flex-1 flex-col">
      {/* The same one line the ticket navigator draws, minus the paperclip:
          attachments belong to a Ticket, and this scope has none. */}
      <FilesNavigatorHeader
        status={
          <RailHeadingReadStatus
            word
            feedback={feedback}
            onRetry={() => void loadDir(cwd)}
            testId="home-files-read-status"
          />
        }
        actions={
          <NewFileRailAction
            disabled={!controls.canWrite}
            onNewFile={() => controls.startDraft("file")}
          />
        }
        root={project.name}
        cwd={cwd}
        upTestId="home-files-up"
        filtering={filtering}
        query={query}
        onToggleFilter={() =>
          setView({ ...view, filtering: !filtering, query: filtering ? "" : query })
        }
        onQueryChange={(next) => setView({ ...view, query: next })}
        onNavigateUp={navigateUp}
      />

      {feedback?.place === "body" && feedback.kind === "reading" ? (
        <RailPanelSkeleton label="files" testId="home-files-loading" />
      ) : (
        <>
          <RailReadFaultBody
            feedback={feedback}
            detail={detail}
            onRetry={() => void loadDir(cwd)}
            testId="home-files-error"
            className={cn("mb-2 shrink-0", RAIL_PANEL_MARGIN)}
          />
          <HomeFilesList
            projectId={project.id}
            cwd={cwd}
            entries={visibleEntries}
            controls={controls}
            canClaimEmpty={railReadCanClaimEmpty(read)}
            emptyLabel={query.trim() === "" ? "Nothing here yet" : "No matches"}
            onPreviewFile={onPreviewFile}
            onPinFile={onPinFile}
            onOpenDirectory={(relPath) => void loadDir(relPath)}
          />
        </>
      )}
    </div>
  );
}
