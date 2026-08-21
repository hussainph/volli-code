import * as React from "react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { FileIcon } from "@phosphor-icons/react/dist/csr/File";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import type { DirEntry, Project } from "@volli/shared";

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
import { useDirectoryWatch } from "@renderer/hooks/use-directory-watch";
import { useProjectRootsReady } from "@renderer/hooks/use-project-roots-sync";
import { toProjectRelPath } from "@renderer/lib/project-rel-path";
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
  // Gates BOTH the root listing and the root watch: `listDirectory` and
  // `watchDir` each resolve their path against the main-process allowlist, so
  // arming either first would reject a freshly added project as "outside known
  // projects" — and the watch has nothing that would retry it, leaving the
  // level permanently unwatched behind a spurious "live updates are
  // unavailable". Home's navigator waits on the same gate.
  const rootsReady = useProjectRootsReady();

  React.useEffect(() => {
    // No run-once guard here: StrictMode's dev-only mount→cleanup→mount cycle
    // must re-fetch on the second run, because `cancelled` discards the first
    // run's result. A run-once ref alongside this cleanup deadlocks the tree
    // on its loading skeleton (the one fetch resolves already-cancelled).
    if (!rootsReady) return;
    let cancelled = false;
    void (async () => {
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
  }, [project.path, rootsReady]);

  // The root level is always open, so it is always watched once the roots are
  // ready. `""` is the root relPath the dir-watch API expects (main rejects
  // "."); `null` until then means "watch nothing yet".
  useDirectoryWatch(project.id, rootsReady ? "" : null, () => {
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
    return <div className="truncate px-2 py-1 text-ui text-destructive">{listing.error}</div>;
  }

  // NOT `EMPTY_INLINE`. This renders at every depth, in the slot a child row
  // would occupy, beside the two skeleton rows the loading branch draws — so it
  // takes the TREE ROW's geometry, not the panel empty's, and a centred block
  // here would ignore the indent that says WHICH folder is empty. The `italic`
  // it used to carry was the only one in the app, and that did go.
  if (listing.length === 0) {
    return <div className="px-2 py-1 text-ui text-muted-foreground">Empty</div>;
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
        <FileIcon />
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
            <FolderIcon />
            <span>{name}</span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* Tighter than stock (mx-3.5 px-2.5): real repos nest deep, and at
              ~48px/level names vanish by depth four even in a wide sidebar. */}
          <SidebarMenuSub className="mr-0 ml-4 pr-0 pl-1">
            <ListingRows listing={children} parentPath={path} project={project} />
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}
