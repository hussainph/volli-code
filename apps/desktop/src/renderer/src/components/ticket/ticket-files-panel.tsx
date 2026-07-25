/**
 * Files navigator — ticket-worktree files + referenced context (monaco-migration §8).
 *
 * Deliberately NOT a deep tree (decision #53/#54): referenced context is a flat
 * list from `parseFileRefs` + attachments; the worktree section is a flat
 * listing of the current directory with a breadcrumb to move around. Selecting
 * a file opens/focuses a ticket file tab via `onOpenFile` — never from an fs
 * event.
 */
import * as React from "react";
import { errorMessage, type DirEntry, type Ticket, type TicketAttachment } from "@volli/shared";

import {
  buildTicketFilesNavigator,
  splitFilesPath,
  type TicketFileRefRow,
  type TicketWorktreeEntry,
} from "@renderer/components/ticket/ticket-files-model";
import { cn } from "@renderer/lib/utils";
import { toastError } from "@renderer/lib/toast";

function joinRel(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

function toWorktreeEntries(cwd: string, entries: readonly DirEntry[]): TicketWorktreeEntry[] {
  return entries.map((entry) => ({
    relPath: joinRel(cwd, entry.name),
    kind: entry.kind === "dir" ? "directory" : "file",
  }));
}

function FileRow({
  relPath,
  label,
  kind,
  onActivate,
}: {
  relPath: string;
  label: string;
  kind: "file" | "directory" | "reference";
  onActivate(): void;
}) {
  const { filename, parentPath } = splitFilesPath(relPath);
  const primary = kind === "reference" ? label : filename;
  return (
    <button
      type="button"
      data-testid="ticket-files-row"
      data-path={relPath}
      data-kind={kind}
      onClick={onActivate}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
        "hover:bg-accent",
      )}
    >
      <span className="truncate text-ui font-medium text-foreground">
        {primary}
        {kind === "directory" ? "/" : ""}
      </span>
      {parentPath !== "" ? (
        <span className="truncate text-xs text-muted-foreground/80">{parentPath}</span>
      ) : null}
    </button>
  );
}

/** Presentational Files list — unit-tested via renderToStaticMarkup. */
export function TicketFilesList({
  referenced,
  worktree,
  cwd = "",
  onOpenFile,
  onOpenDirectory,
  onNavigateUp,
}: {
  referenced: readonly TicketFileRefRow[];
  worktree: readonly TicketWorktreeEntry[];
  cwd?: string;
  onOpenFile(relPath: string): void;
  onOpenDirectory(relPath: string): void;
  onNavigateUp?(): void;
}) {
  const empty = referenced.length === 0 && worktree.length === 0;

  return (
    <div data-testid="ticket-files-list" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {referenced.length > 0 ? (
        <section className="px-2 pt-3 pb-1">
          <h3 className="px-2 pb-1 text-label font-medium text-muted-foreground uppercase">
            Referenced
          </h3>
          <ul className="flex flex-col gap-0.5">
            {referenced.map((row) => (
              <li key={`ref:${row.relPath}`}>
                <FileRow
                  relPath={row.relPath}
                  label={row.label}
                  kind="reference"
                  onActivate={() => onOpenFile(row.relPath)}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="px-2 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2 px-2 pb-1">
          <h3 className="text-label font-medium text-muted-foreground uppercase">Worktree</h3>
          {cwd !== "" && onNavigateUp ? (
            <button
              type="button"
              data-testid="ticket-files-up"
              onClick={onNavigateUp}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ↑ {cwd}
            </button>
          ) : null}
        </div>
        {empty ? (
          <p className="px-2 py-6 text-center text-ui text-muted-foreground">
            No referenced files yet
          </p>
        ) : worktree.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">This folder is empty</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {worktree.map((entry) => (
              <li key={`wt:${entry.relPath}`}>
                <FileRow
                  relPath={entry.relPath}
                  label={splitFilesPath(entry.relPath).filename}
                  kind={entry.kind}
                  onActivate={() =>
                    entry.kind === "directory"
                      ? onOpenDirectory(entry.relPath)
                      : onOpenFile(entry.relPath)
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const NO_ATTACHMENTS: readonly TicketAttachment[] = [];

/**
 * A failed directory read, shown ABOVE the navigator rather than instead of it.
 * A listing can fail for one folder (permissions, a directory the agent deleted
 * mid-browse) while the rest of the tree is fine — replacing the whole panel
 * threw away the breadcrumb and the Up control too, so the only way out of a
 * bad folder was to leave the ticket entirely. The last good listing stays on
 * screen and navigable; this just says the requested read didn't land.
 */
function FilesErrorBanner({ error, onRetry }: { error: string; onRetry(): void }) {
  return (
    <div
      data-testid="ticket-files-error"
      role="alert"
      className="flex shrink-0 items-baseline justify-between gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-2"
    >
      <span className="min-w-0 text-xs text-destructive">{error}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 text-xs text-primary-text hover:underline"
      >
        Retry
      </button>
    </div>
  );
}

/**
 * Ticket Files panel: body refs + optional attachments + worktree directory
 * listing. Attachments are accepted as a prop because the renderer has no
 * attachments IPC yet — hosts that can supply them (or tests) pass them in.
 */
export function TicketFilesPanel({
  ticket,
  attachments = NO_ATTACHMENTS,
  onOpenFile,
}: {
  ticket: Ticket;
  attachments?: readonly TicketAttachment[];
  onOpenFile(relPath: string): void;
}) {
  const [cwd, setCwd] = React.useState("");
  const [entries, setEntries] = React.useState<TicketWorktreeEntry[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(ticket.worktreePath === null);

  const loadDir = React.useCallback(
    async (nextCwd: string) => {
      if (ticket.worktreePath === null) {
        setEntries([]);
        setError(null);
        setLoaded(true);
        return;
      }
      const abs = nextCwd === "" ? ticket.worktreePath : `${ticket.worktreePath}/${nextCwd}`;
      try {
        const result = await window.api.fs.listDirectory(abs);
        if (!result.ok) {
          setError(result.error);
          toastError(`Couldn't list worktree files: ${result.error}`);
          setLoaded(true);
          return;
        }
        setError(null);
        setEntries(toWorktreeEntries(nextCwd, result.entries));
        setCwd(nextCwd);
        setLoaded(true);
      } catch (err) {
        const message = errorMessage(err);
        setError(message);
        toastError(`Couldn't list worktree files: ${message}`);
        setLoaded(true);
      }
    },
    [ticket.worktreePath],
  );

  React.useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const nav = buildTicketFilesNavigator({
    body: ticket.body,
    attachments,
    worktreeEntries: entries,
  });

  if (!loaded && ticket.worktreePath !== null) {
    return (
      <div
        data-testid="ticket-files-loading"
        className="flex min-h-0 flex-1 items-center justify-center px-4 py-8"
      >
        <p className="text-ui text-muted-foreground">Loading files…</p>
      </div>
    );
  }

  if (ticket.worktreePath === null && nav.referenced.length === 0) {
    return (
      <div
        data-testid="ticket-files-no-worktree"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center"
      >
        <p className="text-ui font-medium text-muted-foreground">No worktree yet</p>
        <p className="text-xs text-muted-foreground/80">
          Reference files in the Ticket Body with @path
        </p>
      </div>
    );
  }

  return (
    <div data-testid="ticket-files-panel" className="flex min-h-0 flex-1 flex-col">
      {error !== null ? <FilesErrorBanner error={error} onRetry={() => void loadDir(cwd)} /> : null}
      <TicketFilesList
        referenced={nav.referenced}
        worktree={nav.worktree}
        cwd={cwd}
        onOpenFile={onOpenFile}
        onOpenDirectory={(relPath) => void loadDir(relPath)}
        onNavigateUp={() => {
          const slash = cwd.lastIndexOf("/");
          void loadDir(slash === -1 ? "" : cwd.slice(0, slash));
        }}
      />
    </div>
  );
}
