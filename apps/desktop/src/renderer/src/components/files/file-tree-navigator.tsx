import * as React from "react";
import { ArrowClockwiseIcon as ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowsInLineVerticalIcon as ArrowsInLineVertical } from "@phosphor-icons/react/dist/csr/ArrowsInLineVertical";
import { errorMessage } from "@volli/shared";
import { FileTree } from "./file-tree";
import type { FileEntry } from "./file-tree-model";
import { FilesNavigatorHeader } from "./navigator-header";
import { navigatorScopeKey, useRememberedNavigatorView } from "./navigator-scope-state";
import { useFileNavigatorMutations, type FileNavigatorHost } from "./use-navigator-mutations";
import { useDirectoryWatch } from "@renderer/hooks/use-directory-watch";
import { Button } from "@renderer/components/ui/button";
import {
  NewFileRailAction,
  RailHeadingReadStatus,
  RailPanelSkeleton,
  RailReadFaultBody,
} from "@renderer/components/ticket/rail-panel-parts";
import {
  railReadFeedback,
  type RailReadState,
} from "@renderer/components/ticket/rail-read-feedback";

const NO_REFERENCES: readonly FileEntry[] = [];
const NO_DIRECTORIES: readonly string[] = [];
// The file-only index cannot name an empty directory just created here. Keep
// host-confirmed creations as plain, bounded scope memory, never a watch.
const createdDirectories = new Map<string, readonly string[]>();
function rememberDirectories(key: string, paths: readonly string[]) {
  createdDirectories.delete(key);
  if (paths.length) createdDirectories.set(key, paths.slice(-64));
  while (createdDirectories.size > 24)
    createdDirectories.delete(createdDirectories.keys().next().value!);
}

function DirectoryWatch({
  projectId,
  path,
  refresh,
}: {
  projectId: string;
  path: string;
  refresh(): void;
}) {
  useDirectoryWatch(projectId, path, refresh);
  return null;
}

/** Real, gitignore-respecting index; no recursive renderer filesystem walk.
 * Scope is a keyed instance so an old read cannot appear under a new checkout.
 */
export function FileTreeNavigator(props: {
  projectId: string;
  ticketId?: string;
  root: string;
  available?: boolean;
  selected?: string | null;
  referenced?: readonly FileEntry[];
  attachmentMenu?: React.ReactNode;
  onOpen(path: string): void;
  onPin(path: string): void;
  onRename(from: string, to: string): void;
  onCreated?(path: string): void;
}) {
  return (
    <NavigatorScope
      key={`${props.projectId}:${props.ticketId ?? "main"}:${props.available !== false}`}
      {...props}
    />
  );
}

function NavigatorScope({
  projectId,
  ticketId,
  root,
  available = true,
  selected,
  referenced = NO_REFERENCES,
  attachmentMenu,
  onOpen,
  onPin,
  onRename,
  onCreated,
}: React.ComponentProps<typeof FileTreeNavigator>) {
  const scope = React.useMemo(() => ({ projectId, ticketId }), [projectId, ticketId]);
  const scopeKey = navigatorScopeKey("files", scope);
  const [view, setView] = useRememberedNavigatorView(scopeKey);
  const [directories, setDirectories] = React.useState(
    () => createdDirectories.get(scopeKey) ?? NO_DIRECTORIES,
  );
  function updateDirectories(paths: readonly string[]) {
    rememberDirectories(scopeKey, paths);
    setDirectories(createdDirectories.get(scopeKey) ?? NO_DIRECTORIES);
  }
  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [truncated, setTruncated] = React.useState(false);
  const [detail, setDetail] = React.useState<string | null>(null);
  const [read, setRead] = React.useState<RailReadState>({
    hasData: !available,
    pending: available,
    failed: false,
  });
  const [expandedPaths, setExpandedPaths] = React.useState<readonly string[]>([]);
  const [treeEpoch, setTreeEpoch] = React.useState(0);
  const request = React.useRef(0);
  const refresh = React.useCallback(async () => {
    if (!available) return;
    const current = ++request.current;
    setRead((before) => ({ ...before, pending: true }));
    try {
      const result = await window.api.files.index(scope);
      if (current !== request.current) return;
      if (!result.ok) throw new Error(result.error);
      setEntries(result.files.map((file) => ({ path: file.relPath })));
      setDirectories(createdDirectories.get(scopeKey) ?? NO_DIRECTORIES);
      setTruncated(result.truncated);
      setDetail(null);
      setRead({ hasData: true, pending: false, failed: false });
    } catch (error) {
      if (current !== request.current) return;
      setDetail(errorMessage(error));
      setRead((before) => ({ hasData: before.hasData, pending: false, failed: true }));
    }
  }, [available, scope, scopeKey]);
  React.useEffect(() => {
    void refresh();
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    // Ticket's repository footer owns the recursive worktree watch. Listen,
    // never take/release its per-window lease from this second navigator.
    const unsubscribe = ticketId
      ? window.api.worktree.onChanged((event) => {
          if (event.ticketId === ticketId) void refresh();
        })
      : () => {};
    return () => {
      request.current += 1;
      unsubscribe();
      window.removeEventListener("focus", focus);
    };
  }, [refresh, ticketId]);
  const host: FileNavigatorHost = {
    refresh: () => void refresh(),
    openCreated: onCreated ?? onPin,
    renameTab: (from, to) => {
      updateDirectories(
        directories.map((path) =>
          path === from
            ? to
            : path.startsWith(`${from}/`)
              ? `${to}${path.slice(from.length)}`
              : path,
        ),
      );
      onRename(from, to);
    },
    createdDirectory: (path) => updateDirectories([...directories, path]),
    removed: (removed) =>
      updateDirectories(
        directories.filter((path) => path !== removed && !path.startsWith(`${removed}/`)),
      ),
  };
  const mutations = useFileNavigatorMutations({ scope, cwd: view.cwd, host });
  const feedback = railReadFeedback(read, "Files");
  const merged = React.useMemo(() => {
    const paths = new Map(entries.map((file) => [file.path, file]));
    for (const path of directories) paths.set(path, { path, directory: true });
    for (const reference of referenced)
      paths.set(reference.path, { ...paths.get(reference.path), ...reference, referenced: true });
    return [...paths.values()];
  }, [entries, referenced, directories]);
  const watchedPaths = new Set([""]);
  for (const path of expandedPaths) {
    const parts = path.split("/");
    parts.forEach((_, index) => watchedPaths.add(parts.slice(0, index + 1).join("/")));
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-tree-navigator">
      <FilesNavigatorHeader
        root={root}
        cwd={view.cwd}
        upTestId="file-tree-up"
        filtering={view.filtering}
        query={view.query}
        onToggleFilter={() =>
          setView({ ...view, filtering: !view.filtering, query: view.filtering ? "" : view.query })
        }
        onQueryChange={(query) => setView({ ...view, query })}
        onNavigateUp={() => setView({ ...view, cwd: view.cwd.split("/").slice(0, -1).join("/") })}
        attachmentMenu={attachmentMenu}
        actions={
          <>
            {available && (
              <NewFileRailAction
                disabled={!mutations.canWrite}
                onNewFile={() => mutations.startDraft("file")}
              />
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Collapse folders"
              onClick={() => {
                setTreeEpoch((value) => value + 1);
                setView({ ...view, cwd: "" });
              }}
            >
              <ArrowsInLineVertical />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh files"
              disabled={read.pending}
              onClick={() => void refresh()}
            >
              <ArrowClockwise />
            </Button>
          </>
        }
        status={
          <RailHeadingReadStatus
            word
            feedback={feedback}
            onRetry={() => void refresh()}
            testId="file-tree-read-status"
          />
        }
      />
      {feedback?.place === "body" && feedback.kind === "reading" ? (
        <RailPanelSkeleton label="files" testId="file-tree-loading" />
      ) : (
        <>
          <RailReadFaultBody
            feedback={feedback}
            detail={detail}
            onRetry={() => void refresh()}
            testId="file-tree-error"
          />
          {!available && merged.length === 0 ? (
            <p data-testid="ticket-files-no-worktree" className="p-4 text-ui text-muted-foreground">
              No worktree yet
            </p>
          ) : (
            read.hasData && (
              <FileTree
                key={treeEpoch}
                entries={merged}
                initialFolder={view.cwd}
                projectId={projectId}
                ticketId={ticketId}
                query={view.query}
                selected={selected}
                controls={available ? mutations : undefined}
                onOpen={onOpen}
                onPin={onPin}
                onFolder={(cwd) => setView({ ...view, cwd })}
                onExpandedChange={setExpandedPaths}
              />
            )
          )}
        </>
      )}
      {truncated && (
        <p role="status" className="shrink-0 px-4 py-2 text-ui text-muted-foreground">
          File limit reached. Use Open file to find more.
        </p>
      )}
      {available &&
        !ticketId &&
        [...watchedPaths].map((path) => (
          <DirectoryWatch
            key={path}
            projectId={projectId}
            path={path}
            refresh={() => void refresh()}
          />
        ))}
    </div>
  );
}
