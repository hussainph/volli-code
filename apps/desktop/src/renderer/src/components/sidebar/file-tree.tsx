import * as React from "react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { FileIcon } from "@phosphor-icons/react/dist/csr/File";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { errorMessage, type DirEntry, type Project } from "@volli/shared";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
} from "@renderer/components/ui/sidebar";
import { toastError } from "@renderer/lib/toast";
import { toProjectRelPath } from "@renderer/lib/project-rel-path";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore } from "@renderer/stores/workspace";

import {
  errorListing,
  isListingError,
  shouldFetchListing,
  shouldRetryListing,
  toListing,
  type Listing,
} from "./listing";

interface FileTreeProps {
  project: Project;
}

/**
 * `projectId` + `relPath` as one map key. The separator only has to be absent
 * from the PREFIX for the key to be unambiguous, and a project id is a UUID —
 * so a relPath containing a space (a real file name) still keys correctly.
 */
function dirKey(projectId: string, relPath: string): string {
  return `${projectId} ${relPath}`;
}

const dirListeners = new Map<string, Set<() => void>>();
let dirChangedSubscription: (() => void) | null = null;

/**
 * ONE `onDirChanged` IPC subscription for the whole tree, fanned out by
 * directory. A per-node subscription would be simpler, but an expanded tree
 * routinely holds a few dozen open levels and each one would add an
 * `ipcRenderer` listener on the same channel — straight past Node's
 * max-listeners warning threshold for a purely bookkeeping reason. The single
 * subscription is created with the first watched level and torn down with the
 * last.
 */
function subscribeDirChanged(projectId: string, relPath: string, listener: () => void): () => void {
  const key = dirKey(projectId, relPath);
  const listeners = dirListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  dirListeners.set(key, listeners);
  dirChangedSubscription ??= window.api.files.onDirChanged((event) => {
    for (const notify of dirListeners.get(dirKey(event.projectId, event.relPath)) ?? []) notify();
  });

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) dirListeners.delete(key);
    if (dirListeners.size === 0) {
      dirChangedSubscription?.();
      dirChangedSubscription = null;
    }
  };
}

/**
 * Keeps ONE expanded directory live: a non-recursive main-process watcher plus
 * the subscription that re-lists just that level when it changes. Non-recursive
 * by design (CONCEPT #54) — the renderer never hydrates a repository into
 * state, it only refreshes the levels the user has actually opened.
 *
 * Pass `relPath: null` for a collapsed (or out-of-project) level: nothing is
 * watched, and an already-registered watch is torn down by the cleanup. A
 * failed `watchDir` is never swallowed and never breaks the level — the listing
 * that is already on screen stays usable, it just won't refresh itself.
 */
function useDirectoryWatch(projectId: string, relPath: string | null, refresh: () => void): void {
  // The refresh closure changes identity every render; re-registering the
  // watcher for that would churn a main-process fs watch per keystroke
  // elsewhere in the app.
  const refreshRef = React.useRef(refresh);
  refreshRef.current = refresh;

  React.useEffect(() => {
    if (relPath === null) return;
    const label = relPath === "" ? "the project root" : relPath;
    let live = true;
    // Teardown is deliberately fire-and-forget: a failed unwatch means the
    // watcher was never installed or has already died with the window, neither
    // of which the user can act on. Swallowing keeps it off the unhandled-
    // rejection channel instead of leaving a bare `void` promise.
    const dropWatch = (): void => {
      void window.api.files.unwatchDir({ projectId, relPath }).catch(() => {});
    };
    void window.api.files
      .watchDir({ projectId, relPath })
      .then((result) => {
        if (!live) {
          // `watchDir` is async in main, so it can install its watcher AFTER
          // this effect's cleanup already sent the unwatch — that watcher would
          // then belong to nobody and live until the window dies. Undo it.
          if (result.ok) dropWatch();
          return;
        }
        if (!result.ok) {
          toastError(`Live updates for ${label} are unavailable: ${result.error}`);
        }
      })
      .catch((error: unknown) => {
        if (live) {
          toastError(`Live updates for ${label} are unavailable: ${errorMessage(error)}`);
        }
      });
    const unsubscribe = subscribeDirChanged(projectId, relPath, () => refreshRef.current());
    return () => {
      live = false;
      unsubscribe();
      dropWatch();
    };
  }, [projectId, relPath]);
}

/**
 * Fetches ONE level into the caller's state — the shape every listing read
 * shares (a level expanding, and every watch-driven refresh). The caller owns
 * the skeleton: this only ever writes the settled result, so a refresh can
 * replace a live listing in place without flashing "loading".
 */
function loadListing(path: string, setListing: (listing: Listing) => void): void {
  window.api.fs
    .listDirectory(path)
    .then((result) => {
      setListing(toListing(result));
    })
    .catch((error: unknown) => {
      setListing(errorListing(error));
    });
}

/**
 * sidebar-11's recursive file tree, adapted to fetch each level lazily over
 * IPC instead of from a static literal. Render with `key={project.id}` from
 * the parent so switching projects remounts: listings refetch fresh (they are
 * filesystem truth and go stale), while which directories you had open is
 * restored from the workspace store — coming back to a project shouldn't
 * hand you a collapsed tree.
 *
 * The tree walks ABSOLUTE paths (that is what `listDirectory` and the store's
 * `expandedDirs` speak) while every file API downstream — preview/pin, watch —
 * speaks project-relative paths, so each level converts once via
 * {@link toProjectRelPath}.
 */
export function FileTree({ project }: FileTreeProps) {
  const [root, setRoot] = React.useState<Listing>("loading");
  // Gates the root WATCH on the same root-sync the root listing waits for.
  // `watchDir` resolves its path against the main-process allowlist too, so
  // arming it first would toast a spurious "live updates are unavailable" for a
  // freshly added project and leave the level permanently unwatched — the watch
  // effect has nothing that would retry it. Flipping this true re-runs that
  // effect with a real relPath, which is what actually arms the watcher.
  const [rootsSynced, setRootsSynced] = React.useState(false);

  React.useEffect(() => {
    // No run-once guard here: StrictMode's dev-only mount→cleanup→mount cycle
    // must re-fetch on the second run, because `cancelled` discards the first
    // run's result. A run-once ref alongside this cleanup deadlocks the tree
    // on its loading skeleton (the one fetch resolves already-cancelled).
    let cancelled = false;
    void (async () => {
      // Register fs roots BEFORE the first listing. This effect runs in a
      // descendant of AppShell, and React fires child effects before parent
      // effects, so AppShell's root-sync would otherwise land AFTER this
      // listDirectory — the main-process allowlist would still be stale and
      // reject a freshly added project's path as "outside known projects".
      // syncRoots is idempotent, so re-asserting the full current set is safe.
      try {
        await window.api.projects.syncRoots(
          useProjectsStore.getState().projects.map((p) => p.path),
        );
      } catch {
        // A failed sync just surfaces as the listing error below — nothing to do.
      }
      // Released even when the sync threw: AppShell mirrors the same roots, so
      // the allowlist may well be current regardless. Arming the watch and
      // reporting a real failure beats never watching at all.
      if (!cancelled) setRootsSynced(true);
      try {
        const result = await window.api.fs.listDirectory(project.path);
        if (!cancelled) setRoot(toListing(result));
      } catch (error: unknown) {
        if (!cancelled) setRoot(errorListing(error));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [project.path]);

  // The root level is always open, so it is always watched once the roots are
  // synced. `""` is the root relPath the dir-watch API expects (main rejects
  // "."); `null` until then means "watch nothing yet".
  useDirectoryWatch(project.id, rootsSynced ? "" : null, () => {
    loadListing(project.path, setRoot);
  });

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Files</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <ListingRows listing={root} parentPath={project.path} project={project} />
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Loading/error/empty/entries states, shared by the root and every nested level. */
function ListingRows({
  listing,
  parentPath,
  project,
}: {
  listing: Listing;
  parentPath: string;
  project: Project;
}) {
  if (listing === "loading" || listing === undefined) {
    return (
      <>
        <SidebarMenuSkeleton showIcon />
        <SidebarMenuSkeleton showIcon />
      </>
    );
  }

  if (isListingError(listing)) {
    return <div className="truncate px-2 py-1 text-xs text-destructive">{listing.error}</div>;
  }

  if (listing.length === 0) {
    return <div className="px-2 py-1 text-xs text-muted-foreground italic">Empty</div>;
  }

  return (
    <>
      {listing.map((entry) => (
        <FileTreeNode
          key={entry.name}
          name={entry.name}
          kind={entry.kind}
          path={`${parentPath}/${entry.name}`}
          project={project}
        />
      ))}
    </>
  );
}

interface FileTreeNodeProps {
  name: string;
  kind: DirEntry["kind"];
  path: string;
  project: Project;
}

function FileTreeNode({ name, kind, path, project }: FileTreeNodeProps) {
  if (kind === "file") {
    return <FileNode name={name} path={path} project={project} />;
  }

  return <DirectoryNode name={name} path={path} project={project} />;
}

/**
 * A file row: the entry point into the Project Files workbench. Single click
 * opens it in the replaceable preview slot, double click pins it — the
 * preview-tab semantics decision #56 settled. A real `<button>`, because it is
 * genuinely actionable and has to be reachable by keyboard.
 */
function FileNode({ name, path, project }: { name: string; path: string; project: Project }) {
  const relPath = toProjectRelPath(project.path, path);
  const previewProjectFile = useWorkspaceStore((state) => state.previewProjectFile);
  const pinProjectFile = useWorkspaceStore((state) => state.pinProjectFile);
  const active = useWorkspaceStore(
    (state) =>
      relPath !== null && state.byProject[project.id]?.projectFiles.activeRelPath === relPath,
  );

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        data-testid="file-tree-file"
        data-rel-path={relPath ?? undefined}
        isActive={active}
        // A path that doesn't resolve inside the project can't be opened; the
        // row stays visible (it is real on disk) but inert rather than lying.
        disabled={relPath === null}
        onClick={() => {
          if (relPath !== null) previewProjectFile(project.id, relPath);
        }}
        onDoubleClick={() => {
          if (relPath !== null) pinProjectFile(project.id, relPath);
        }}
      >
        <FileIcon weight="fill" />
        <span>{name}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function DirectoryNode({ name, path, project }: { name: string; path: string; project: Project }) {
  const projectId = project.id;
  const expanded = useWorkspaceStore(
    (state) => state.byProject[projectId]?.expandedDirs.includes(path) ?? false,
  );
  const setDirExpanded = useWorkspaceStore((state) => state.setDirExpanded);
  const [children, setChildren] = React.useState<Listing>(undefined);
  const relPath = toProjectRelPath(project.path, path);

  // The single fetch path: runs when a level is expanded but not yet fetched —
  // whether the user just opened it or it remounted already-expanded from the
  // workspace store after a project switch. A loaded listing is reused across
  // collapse/expand of THIS node; its descendants unmount with the collapsed
  // content (stock Radix) and refetch fresh when it reopens, which is fine —
  // listings are filesystem truth. No cancellation flag, deliberately:
  // `shouldFetch` flips false as soon as the listing leaves `undefined`, so
  // a cleanup-driven cancel would discard the very fetch it started (the
  // StrictMode deadlock the root fetch's comment describes); a duplicate
  // StrictMode fetch is idempotent and last-write-wins.
  const shouldFetch = shouldFetchListing(expanded, children);
  React.useEffect(() => {
    if (!shouldFetch) return;
    setChildren("loading");
    loadListing(path, setChildren);
  }, [shouldFetch, path]);

  // Only an OPEN level is watched — a collapsed one has nothing on screen to
  // keep fresh, and it refetches from scratch when it reopens anyway. The
  // refresh deliberately skips the "loading" skeleton: replacing a live listing
  // in place is what makes a file appearing on disk feel like a live tree.
  // No root-sync gate is needed here (unlike the root level): a nested node only
  // exists once the root listing resolved, which happens after FileTree awaited
  // syncRoots — so the allowlist is already current by the time this mounts.
  useDirectoryWatch(projectId, expanded ? relPath : null, () => {
    loadListing(path, setChildren);
  });

  function handleOpenChange(open: boolean) {
    setDirExpanded(projectId, path, open);
    // Resetting to `undefined` re-arms the fetch effect.
    if (shouldRetryListing(open, children)) {
      setChildren(undefined);
    }
  }

  return (
    <SidebarMenuItem>
      <Collapsible
        className="group/collapsible [&[data-state=open]>button>svg:first-child]:rotate-90"
        open={expanded}
        onOpenChange={handleOpenChange}
      >
        <CollapsibleTrigger asChild>
          <SidebarMenuButton data-testid="file-tree-dir" data-rel-path={relPath ?? undefined}>
            <CaretRightIcon weight="bold" className="transition-transform" />
            <FolderIcon weight="fill" />
            <span>{name}</span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* Tighter than stock (mx-3.5 px-2.5): real repos nest deep, and at
              ~48px/level names vanish by depth four even in a wide sidebar. */}
          <SidebarMenuSub className="mr-0 ml-3 pr-0 pl-1.5">
            <ListingRows listing={children} parentPath={path} project={project} />
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}
