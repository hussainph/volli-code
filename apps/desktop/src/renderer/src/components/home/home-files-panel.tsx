import * as React from "react";
import { errorMessage, type DirEntry, type Project } from "@volli/shared";

import { useDirectoryWatch } from "@renderer/hooks/use-directory-watch";
import { useProjectRootsReady } from "@renderer/hooks/use-project-roots-sync";
import {
  RailFaultBanner,
  RailNavigatorHeader,
  RailPanelSkeleton,
  railNavigatorMatch,
} from "@renderer/components/ticket/rail-panel-parts";
import { TicketFilesList } from "@renderer/components/ticket/ticket-files-panel";

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
  onPreviewFile,
  onPinFile,
  onOpenDirectory,
}: {
  projectId: string;
  cwd: string;
  entries: readonly DirEntry[];
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
 * live through the same non-recursive dir-watch seam as the primary file tree.
 */
export function HomeFilesPanel({
  project,
  onPreviewFile,
  onPinFile,
}: {
  project: Project;
  onPreviewFile(relPath: string): void;
  onPinFile(relPath: string): void;
}) {
  const [cwd, setCwd] = React.useState("");
  const [entries, setEntries] = React.useState<DirEntry[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [filtering, setFiltering] = React.useState(false);
  const [query, setQuery] = React.useState("");
  // `volli:list-directory` answers only for a path main already knows as a
  // project root, and child effects run before their parent's — so AppShell's
  // own mirror would land AFTER this panel's first listing. The shared hook is
  // the same gate the primary file tree waits on, spelled once.
  const rootsReady = useProjectRootsReady();
  // A fast folder change can overtake an older listing read. Only the newest
  // request may name the current folder or replace its rows.
  const requestId = React.useRef(0);

  const loadDir = React.useCallback(
    async (nextCwd: string, showLoading = false) => {
      const request = ++requestId.current;
      if (showLoading) setLoaded(false);
      try {
        const result = await window.api.fs.listDirectory(absoluteDirectory(project.path, nextCwd));
        if (request !== requestId.current) return;
        if (!result.ok) {
          setError(result.error);
          setLoaded(true);
          return;
        }
        setError(null);
        setEntries(result.entries);
        setCwd(nextCwd);
        setLoaded(true);
      } catch (readError) {
        if (request !== requestId.current) return;
        setError(errorMessage(readError));
        setLoaded(true);
      }
    },
    [project.path],
  );

  React.useEffect(() => {
    if (!rootsReady) return;
    requestId.current += 1;
    setCwd("");
    setEntries([]);
    setError(null);
    setLoaded(false);
    void loadDir("", true);

    return () => {
      requestId.current += 1;
    };
  }, [project.id, loadDir, rootsReady]);

  useDirectoryWatch(project.id, loaded ? cwd : null, () => {
    void loadDir(cwd);
  });

  // On the whole project-relative path, like the ticket navigator: the same
  // magnifier cannot mean two different things on two drawings of one panel.
  const visibleEntries = entries.filter((entry) =>
    railNavigatorMatch(query, joinRel(cwd, entry.name)),
  );

  function navigateUp() {
    const slash = cwd.lastIndexOf("/");
    void loadDir(slash === -1 ? "" : cwd.slice(0, slash), true);
  }

  return (
    <div data-testid="home-files-panel" className="flex min-h-0 flex-1 flex-col">
      {/* The mono sub-line names the project at the top level — the Main
          checkout is what Home's navigator is rooted in, the way the ticket's
          names its branch. */}
      <RailNavigatorHeader
        title="Project files"
        root={project.name}
        cwd={cwd}
        upTestId="home-files-up"
        filtering={filtering}
        query={query}
        onToggleFilter={() =>
          setFiltering((open) => {
            if (open) setQuery("");
            return !open;
          })
        }
        onQueryChange={setQuery}
        onNavigateUp={navigateUp}
      />

      {error !== null ? (
        <RailFaultBanner
          testId="home-files-error"
          label="Folder unreadable"
          error={error}
          onRetry={() => void loadDir(cwd, true)}
        />
      ) : null}

      {!loaded ? (
        <RailPanelSkeleton label="files" testId="home-files-loading" />
      ) : (
        <HomeFilesList
          projectId={project.id}
          cwd={cwd}
          entries={visibleEntries}
          onPreviewFile={onPreviewFile}
          onPinFile={onPinFile}
          onOpenDirectory={(relPath) => void loadDir(relPath, true)}
        />
      )}
    </div>
  );
}
