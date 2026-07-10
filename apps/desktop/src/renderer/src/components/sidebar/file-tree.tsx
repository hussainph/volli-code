import * as React from "react";
import { ChevronRight, File, Folder } from "lucide-react";
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
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** One directory level's listing state. `undefined` = not fetched yet. */
type Listing = DirEntry[] | "loading" | { error: string } | undefined;

interface FileTreeProps {
  project: Project;
}

/**
 * sidebar-11's recursive file tree, adapted to fetch each level lazily over
 * IPC instead of from a static literal. Render with `key={project.id}` from
 * the parent so switching projects remounts: listings refetch fresh (they are
 * filesystem truth and go stale), while which directories you had open is
 * restored from the workspace store — coming back to a project shouldn't
 * hand you a collapsed tree.
 */
export function FileTree({ project }: FileTreeProps) {
  const [root, setRoot] = React.useState<Listing>("loading");

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
      try {
        const result = await window.api.fs.listDirectory(project.path);
        if (!cancelled) setRoot(result.ok ? result.entries : { error: result.error });
      } catch (error: unknown) {
        if (!cancelled) setRoot({ error: errorMessage(error) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [project.path]);

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Files</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <ListingRows listing={root} parentPath={project.path} projectId={project.id} />
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Loading/error/empty/entries states, shared by the root and every nested level. */
function ListingRows({
  listing,
  parentPath,
  projectId,
}: {
  listing: Listing;
  parentPath: string;
  projectId: string;
}) {
  if (listing === "loading" || listing === undefined) {
    return (
      <>
        <SidebarMenuSkeleton showIcon />
        <SidebarMenuSkeleton showIcon />
      </>
    );
  }

  if (!Array.isArray(listing)) {
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
          projectId={projectId}
        />
      ))}
    </>
  );
}

interface FileTreeNodeProps {
  name: string;
  kind: DirEntry["kind"];
  path: string;
  projectId: string;
}

function FileTreeNode({ name, kind, path, projectId }: FileTreeNodeProps) {
  if (kind === "file") {
    return (
      <SidebarMenuButton className="data-[active=true]:bg-transparent">
        <File />
        <span>{name}</span>
      </SidebarMenuButton>
    );
  }

  return <DirectoryNode name={name} path={path} projectId={projectId} />;
}

function DirectoryNode({
  name,
  path,
  projectId,
}: {
  name: string;
  path: string;
  projectId: string;
}) {
  const expanded = useWorkspaceStore(
    (state) => state.byProject[projectId]?.expandedDirs.includes(path) ?? false,
  );
  const setDirExpanded = useWorkspaceStore((state) => state.setDirExpanded);
  const [children, setChildren] = React.useState<Listing>(undefined);

  // The single fetch path: runs when a level is expanded but not yet fetched —
  // whether the user just opened it or it remounted already-expanded from the
  // workspace store after a project switch. A loaded listing is reused across
  // collapse/expand. No cancellation flag, deliberately: `shouldFetch` flips
  // false as soon as the listing leaves `undefined`, so a cleanup-driven
  // cancel would discard the very fetch it started (the StrictMode deadlock
  // the root fetch's comment describes); a duplicate StrictMode fetch is
  // idempotent and last-write-wins.
  const shouldFetch = expanded && children === undefined;
  React.useEffect(() => {
    if (!shouldFetch) return;
    setChildren("loading");
    window.api.fs
      .listDirectory(path)
      .then((result) => {
        setChildren(result.ok ? result.entries : { error: result.error });
      })
      .catch((error: unknown) => {
        setChildren({ error: errorMessage(error) });
      });
  }, [shouldFetch, path]);

  function handleOpenChange(open: boolean) {
    setDirExpanded(projectId, path, open);
    // A cached ERROR is retried on the next expand — a transient failure
    // (e.g. losing the root-sync race, or a momentary EACCES/EMFILE)
    // shouldn't stick until the whole tree is remounted. Resetting to
    // `undefined` re-arms the fetch effect.
    if (open && !Array.isArray(children) && typeof children === "object") {
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
          <SidebarMenuButton>
            <ChevronRight className="transition-transform" />
            <Folder />
            <span>{name}</span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* Tighter than stock (mx-3.5 px-2.5): real repos nest deep, and at
              ~48px/level names vanish by depth four even in a wide sidebar. */}
          <SidebarMenuSub className="mr-0 ml-3 pr-0 pl-1.5">
            <ListingRows listing={children} parentPath={path} projectId={projectId} />
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}
