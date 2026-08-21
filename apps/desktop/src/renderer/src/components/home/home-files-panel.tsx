import * as React from "react";
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowUUpLeft";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { errorMessage, type DirEntry, type Project } from "@volli/shared";

import { useDirectoryWatch } from "@renderer/hooks/use-directory-watch";
import {
  RAIL_PANEL_INSET,
  RailFaultBanner,
  RailPanelSkeleton,
} from "@renderer/components/ticket/rail-panel-parts";
import { TicketFilesList } from "@renderer/components/ticket/ticket-files-panel";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";
import { useProjectsStore } from "@renderer/stores/projects";

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
  cwd,
  entries,
  onPreviewFile,
  onPinFile,
  onOpenDirectory,
}: {
  cwd: string;
  entries: readonly DirEntry[];
  onPreviewFile(relPath: string): void;
  onPinFile(relPath: string): void;
  onOpenDirectory(relPath: string): void;
}) {
  return (
    <TicketFilesList
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
  const [rootsSynced, setRootsSynced] = React.useState(false);
  const [filtering, setFiltering] = React.useState(false);
  const [query, setQuery] = React.useState("");
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
    let live = true;
    requestId.current += 1;
    setCwd("");
    setEntries([]);
    setError(null);
    setLoaded(false);
    setRootsSynced(false);

    void window.api.projects
      .syncRoots(useProjectsStore.getState().projects.map((candidate) => candidate.path))
      .catch(() => {
        // The listing below carries the actionable failure. Root sync is
        // idempotently repeated by AppShell, so it gets no second alert here.
      })
      .then(() => {
        if (!live) return;
        setRootsSynced(true);
        void loadDir("", true);
      });

    return () => {
      live = false;
      requestId.current += 1;
    };
  }, [project.id, loadDir]);

  useDirectoryWatch(project.id, rootsSynced && loaded ? cwd : null, () => {
    void loadDir(cwd);
  });

  const needle = query.trim().toLowerCase();
  const visibleEntries = entries.filter(
    (entry) => needle === "" || entry.name.toLowerCase().includes(needle),
  );

  function navigateUp() {
    const slash = cwd.lastIndexOf("/");
    void loadDir(slash === -1 ? "" : cwd.slice(0, slash), true);
  }

  return (
    <div data-testid="home-files-panel" className="flex min-h-0 flex-1 flex-col">
      <header className={cn("flex shrink-0 flex-col gap-2 pt-1 pb-4", RAIL_PANEL_INSET)}>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-ui font-medium">Project files</p>
            {cwd === "" ? (
              <p className="truncate font-mono text-ui text-muted-foreground">{project.name}</p>
            ) : (
              <button
                type="button"
                data-testid="home-files-up"
                onClick={navigateUp}
                aria-label={`Leave ${cwd}`}
                className="flex min-w-0 items-center gap-1 font-mono text-ui text-muted-foreground hover:text-foreground"
              >
                <ArrowUUpLeftIcon className="size-3 shrink-0" />
                <span className="truncate">{cwd}</span>
              </button>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Filter files"
                aria-pressed={filtering}
                onClick={() =>
                  setFiltering((open) => {
                    if (open) setQuery("");
                    return !open;
                  })
                }
              >
                <MagnifyingGlassIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Filter files</TooltipContent>
          </Tooltip>
        </div>
        {filtering ? (
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter files"
            placeholder="Filter files…"
            className="h-7 text-ui"
          />
        ) : null}
      </header>

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
