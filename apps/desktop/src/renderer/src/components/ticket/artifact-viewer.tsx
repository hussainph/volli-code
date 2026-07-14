import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { errorMessage, type ArtifactEntry } from "@volli/shared";
import { toast } from "sonner";

import { MarkdownLiveEditor } from "@renderer/components/editor/markdown-live-editor";
import { Button } from "@renderer/components/ui/button";
import { createDebouncer, type Debouncer } from "@renderer/lib/debounce";

const AUTOSAVE_IDLE_MS = 1500;

interface ArtifactViewerProps {
  projectId: string;
  ticketId: string;
  entry: ArtifactEntry;
  /** Bumped by the tab's `onChanged` subscription — triggers a background re-read while safe. */
  refreshSignal: number;
  /** True right after this artifact was just created via "New artifact" — focuses the editor. */
  startInEditMode?: boolean;
  /** Lets the tab refetch the list (mtime/size changed) after a successful save. */
  onSaved?(): void;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "text" }
  | { status: "image"; dataUrl: string }
  | { status: "other" };

/**
 * The Artifacts tab's content pane for whichever row is selected (decision
 * #17). Markdown opens directly in the always-mounted live-preview editor
 * (components/editor) with 1.5s debounced autosave — no view/edit flip, no Save
 * button; the pending save flushes on blur, on file-switch (this component is
 * remounted per selection), and on unmount.
 *
 * Because agents write these same files, autosave is conflict-guarded: the
 * content last loaded or saved is the on-disk baseline, and before any write we
 * re-read the file — if it no longer matches the baseline the write is skipped,
 * a non-destructive "Changed on disk" banner appears, and autosave pauses until
 * the user reloads. The fs-watch refresh (`refreshSignal`) adopts an external
 * change silently only when the editor is unfocused and has no unsaved edits;
 * otherwise it raises the same banner rather than stomping the buffer.
 *
 * An image renders inline via a base64 `data:` URI; anything else is a name row
 * plus Reveal in Finder. Mount with `key={artifactKey(entry)}` so a selection
 * change remounts it fresh.
 */
export function ArtifactViewer({
  projectId,
  ticketId,
  entry,
  refreshSignal,
  startInEditMode = false,
  onSaved,
}: ArtifactViewerProps) {
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  // The value that seeds / resets the editor doc (updated on load and reload).
  const [docValue, setDocValue] = React.useState("");
  // Disk content captured when a conflict is detected — drives the banner and
  // the Reload action. `null` = no conflict, autosave live.
  const [conflict, setConflict] = React.useState<string | null>(null);

  // Refs mirror state for use inside async/debounced closures without staleness.
  const draftRef = React.useRef(""); // current editor content
  const syncedRef = React.useRef(""); // last content loaded or saved (disk baseline)
  const conflictRef = React.useRef<string | null>(null);
  const focusedRef = React.useRef(false);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const readFile = React.useCallback(
    () => window.api.artifacts.read({ projectId, ticketId, tier: entry.tier, name: entry.name }),
    [projectId, ticketId, entry.tier, entry.name],
  );

  const load = React.useCallback(async () => {
    if (entry.kind === "markdown") {
      const result = await readFile();
      if (!mountedRef.current) return;
      if (!result.ok) {
        setState({ status: "error", error: result.error });
        return;
      }
      syncedRef.current = result.content;
      draftRef.current = result.content;
      setDocValue(result.content);
      setState({ status: "text" });
    } else if (entry.kind === "image") {
      const result = await window.api.artifacts.readImage({
        projectId,
        ticketId,
        tier: entry.tier,
        name: entry.name,
      });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setState({ status: "error", error: result.error });
        return;
      }
      setState({ status: "image", dataUrl: result.dataUrl });
    } else {
      setState({ status: "other" });
    }
  }, [projectId, ticketId, entry.tier, entry.name, entry.kind, readFile]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // The guarded autosave: never write if paused by a conflict or if nothing
  // changed; re-read disk first and, if it drifted from our baseline, raise the
  // banner instead of overwriting an agent's edit.
  const commit = React.useCallback(async () => {
    if (conflictRef.current !== null) return;
    const next = draftRef.current;
    if (next === syncedRef.current) return;
    // No mounted guard before persisting: the unmount/file-switch flush relies
    // on this write completing after the component is gone. Only React state
    // (the banner) and the list refetch are gated on being mounted.
    const disk = await readFile();
    if (!disk.ok) {
      toast.error(`Could not save ${entry.name}: ${disk.error}`);
      return;
    }
    if (disk.content !== syncedRef.current) {
      if (mountedRef.current) setConflict(disk.content);
      else toast.error(`${entry.name} changed on disk — your last edits were not saved.`);
      return;
    }
    const result = await window.api.artifacts.write({
      projectId,
      ticketId,
      tier: entry.tier,
      name: entry.name,
      content: next,
    });
    if (!result.ok) {
      toast.error(`Could not save ${entry.name}: ${result.error}`);
      return;
    }
    syncedRef.current = next;
    if (mountedRef.current) onSaved?.();
  }, [projectId, ticketId, entry.tier, entry.name, readFile, onSaved]);

  const commitRef = React.useRef(commit);
  React.useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  const debouncerRef = React.useRef<Debouncer | null>(null);
  if (debouncerRef.current === null) {
    debouncerRef.current = createDebouncer(() => void commitRef.current(), AUTOSAVE_IDLE_MS);
  }
  const debouncer = debouncerRef.current;

  // Flush a pending save on unmount (file-switch remounts, ticket close, etc.).
  React.useEffect(() => () => debouncer.flush(), [debouncer]);

  // Background fs-watch change. Skip the first run — the load effect covers the
  // initial fetch; this only reacts to LATER bumps.
  const skippedInitialRefresh = React.useRef(false);
  React.useEffect(() => {
    if (!skippedInitialRefresh.current) {
      skippedInitialRefresh.current = true;
      return;
    }
    if (entry.kind !== "markdown") {
      void load();
      return;
    }
    void (async () => {
      const disk = await readFile();
      if (!mountedRef.current || !disk.ok) return;
      // No real change vs our baseline (also the echo of our own write).
      if (disk.content === syncedRef.current) return;
      const dirty = draftRef.current !== syncedRef.current;
      if (!dirty && !focusedRef.current && conflictRef.current === null) {
        // Safe to adopt silently: unfocused, clean, not already conflicted.
        syncedRef.current = disk.content;
        draftRef.current = disk.content;
        setDocValue(disk.content);
      } else {
        setConflict(disk.content);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on refreshSignal alone.
  }, [refreshSignal]);

  function handleChange(next: string) {
    draftRef.current = next;
    if (conflictRef.current !== null) return; // paused until reload
    debouncer.schedule();
  }

  function reload() {
    const disk = conflictRef.current;
    if (disk === null) return;
    debouncer.cancel();
    syncedRef.current = disk;
    draftRef.current = disk;
    setDocValue(disk); // editor is unfocused (the button took focus) → doc resets
    setConflict(null);
  }

  async function handleReveal() {
    try {
      const result = await window.api.artifacts.revealDir({
        projectId,
        ticketId,
        tier: entry.tier,
      });
      if (!result.ok) toast.error(`Could not reveal in Finder: ${result.error}`);
    } catch (error) {
      toast.error(`Could not reveal in Finder: ${errorMessage(error)}`);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
        <div className="flex shrink-0 items-center gap-1">
          {entry.kind === "other" && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Reveal in Finder"
              onClick={() => void handleReveal()}
            >
              <FolderOpenIcon />
            </Button>
          )}
        </div>
      </div>

      {conflict !== null && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span>Changed on disk — autosave paused to avoid overwriting.</span>
          <Button size="sm" variant="secondary" onClick={reload}>
            <ArrowClockwiseIcon />
            Reload
          </Button>
        </div>
      )}

      {state.status === "loading" && <p className="text-xs text-muted-foreground">Loading…</p>}
      {state.status === "error" && <p className="text-xs text-destructive">{state.error}</p>}
      {state.status === "text" && (
        <div
          className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-4"
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => {
            focusedRef.current = false;
          }}
        >
          <MarkdownLiveEditor
            value={docValue}
            onChange={handleChange}
            onBlur={() => debouncer.flush()}
            autoFocus={startInEditMode}
            ariaLabel={`${entry.name} contents`}
            className="min-h-full"
          />
        </div>
      )}
      {state.status === "image" && (
        <img
          src={state.dataUrl}
          alt={entry.name}
          className="max-h-full max-w-full self-start rounded-md border border-border object-contain"
        />
      )}
      {state.status === "other" && (
        <p className="text-xs text-muted-foreground">
          {entry.name} can't be previewed here — use Reveal in Finder.
        </p>
      )}
    </div>
  );
}
