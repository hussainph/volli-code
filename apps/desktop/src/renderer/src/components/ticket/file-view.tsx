import * as React from "react";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { baseNameOf, errorMessage, type FileSource } from "@volli/shared";

import { MonacoCodeView } from "@renderer/components/editor/monaco-code-view";
import { ContentColumn } from "@renderer/components/layout/content-column";
import {
  MarkdownLiveEditor,
  type MarkdownFileRefs,
} from "@renderer/components/editor/markdown-live-editor";
import { Button } from "@renderer/components/ui/button";
import { fileDocumentIdentity } from "@renderer/editor/document-identity";
import { toastError } from "@renderer/lib/toast";
import { useDebouncedCallback } from "@renderer/lib/use-debounced-callback";

const AUTOSAVE_IDLE_MS = 1500;

interface FileViewProps {
  projectId: string;
  /** When present, repo paths resolve to this ticket's live worktree copy (decision #6). */
  ticketId?: string;
  relPath: string;
  /** `@file` wiring so an open markdown file can itself reference other files. */
  fileRefs?: MarkdownFileRefs;
  /** Reports the resolved source (with the file's relPath) so the tab can show a worktree badge. */
  onSource?(relPath: string, source: FileSource): void;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "markdown" }
  | {
      status: "code";
      text: string;
      truncated: boolean;
      source: FileSource;
      revision: number;
    }
  | { status: "image"; dataUrl: string }
  | { status: "binary" };

/**
 * A `file` tab's content pane (global-artifacts decision #7), generalized from
 * the old ArtifactViewer onto `api.files`. Markdown opens in the always-mounted
 * live-preview editor with 1.5s debounced autosave, conflict-guarded by the
 * on-disk mtime: each write carries the last-seen mtime as `expectedMtime`, and
 * a rejected write (agent edit underneath) raises a non-destructive "Changed on
 * disk" banner rather than overwriting. Everything else is read-only — code/text
 * in a language-aware Monaco view, images inline, binary/oversize a Reveal-in-Finder
 * stub. Re-reads on the tab's `api.files.onChanged` subscription: read-only
 * views adopt silently, the markdown editor keeps the dirty/focus-aware logic.
 *
 * Mount with `key={relPath}` so switching files remounts it fresh.
 */
export function FileView({ projectId, ticketId, relPath, fileRefs, onSource }: FileViewProps) {
  const [state, setState] = React.useState<LoadState>({ status: "loading" });
  const [docValue, setDocValue] = React.useState("");
  // Disk content+mtime captured when a conflict is detected. The mtime rides
  // along so Reload can restore BOTH baselines together — advancing the content
  // baseline without its mtime would wedge every later write on a stale
  // `expectedMtime`. `null` = no conflict, autosave live.
  const [conflict, setConflict] = React.useState<{ text: string; mtime: number } | null>(null);

  const draftRef = React.useRef(""); // current editor content
  const syncedRef = React.useRef(""); // last content loaded or saved (disk baseline)
  const syncedMtimeRef = React.useRef(0); // mtime of that baseline — the write conflict guard
  const conflictRef = React.useRef<{ text: string; mtime: number } | null>(null);
  const focusedRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  // Mirrors `state` for the fs-watch subscription (set up once, so it can't
  // read the current `state` off a render closure) — only its `.status` is
  // read, to decide whether a conflict banner (markdown-only) can even render.
  const stateRef = React.useRef<LoadState>(state);
  const name = baseNameOf(relPath);

  React.useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const readFile = React.useCallback(
    () => window.api.files.read({ projectId, ticketId, relPath }),
    [projectId, ticketId, relPath],
  );

  const load = React.useCallback(async () => {
    const result = await readFile();
    if (!mountedRef.current) return;
    if (!result.ok) {
      setState({ status: "error", error: result.error });
      return;
    }
    onSource?.(relPath, result.source);
    const { content } = result;
    if (content.type === "image") {
      setState({ status: "image", dataUrl: content.dataUrl });
    } else if (content.type === "binary") {
      setState({ status: "binary" });
    } else if (result.kind === "markdown" && !content.truncated) {
      syncedRef.current = content.text;
      syncedMtimeRef.current = result.mtime;
      draftRef.current = content.text;
      setDocValue(content.text);
      setState({ status: "markdown" });
    } else {
      // Non-markdown, or a markdown file past the 1 MiB read cap — editing the
      // latter would autosave back only the truncated prefix, so it stays
      // read-only.
      syncedMtimeRef.current = result.mtime;
      setState({
        status: "code",
        text: content.text,
        truncated: content.truncated,
        source: result.source,
        revision: result.mtime,
      });
    }
  }, [readFile, onSource, relPath]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Guarded autosave: never write while paused by a conflict or when nothing
  // changed. A rejected write (or drifted mtime) means an agent edited the file
  // underneath us — re-read to distinguish a real conflict from a hard error,
  // and raise the banner rather than clobbering their edit.
  const commit = React.useCallback(async () => {
    if (conflictRef.current !== null) return;
    const next = draftRef.current;
    if (next === syncedRef.current) return;
    // Up to two attempts: a write rejected by a stale mtime baseline whose disk
    // content still matches ours (an agent rewrote identical bytes, or touched
    // the file) is a no-op drift — adopt the fresh mtime and retry once so the
    // edit lands. A genuine content divergence raises the conflict banner.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await window.api.files.write({
        projectId,
        ticketId,
        relPath,
        content: next,
        expectedMtime: syncedMtimeRef.current,
      });
      if (result.ok) {
        syncedRef.current = next;
        syncedMtimeRef.current = result.mtime;
        return;
      }
      const disk = await readFile();
      if (!(disk.ok && disk.content.type === "text")) {
        toastError(`Could not save ${name}: ${result.error}`);
        return;
      }
      if (disk.kind !== "markdown" || disk.content.truncated) {
        // The file grew past the 1 MiB read cap (or stopped being markdown)
        // underneath us — that re-read is a truncated/foreign prefix, not a
        // valid editable baseline. Offering it as a Reload target would
        // autosave the prefix back and destroy everything past the cap, so
        // don't raise the conflict banner: drop into the read-only 'code'
        // state instead, matching the load and onChanged paths.
        // `debouncer` is declared below but stable for the component's whole
        // lifetime (see use-debounced-callback.ts), so it's safe to close
        // over here despite the declaration order — deliberately left out of
        // the deps array below rather than reordering the two.
        debouncer.cancel();
        syncedMtimeRef.current = disk.mtime;
        if (mountedRef.current) {
          setState({
            status: "code",
            text: disk.content.text,
            truncated: disk.content.truncated,
            source: disk.source,
            revision: disk.mtime,
          });
          toastError(
            `${name} changed on disk and grew past the editable 1 MiB cap (or is no longer markdown) — editing stopped.`,
          );
        } else {
          toastError(`${name} changed on disk — your last edits were not saved.`);
        }
        return;
      }
      if (disk.content.text !== syncedRef.current) {
        if (mountedRef.current) setConflict({ text: disk.content.text, mtime: disk.mtime });
        else toastError(`${name} changed on disk — your last edits were not saved.`);
        return;
      }
      // Same content, drifted mtime — adopt it and retry the write.
      syncedMtimeRef.current = disk.mtime;
    }
    // Both attempts hit an mtime drift with identical content (rapid external
    // touches) — give up quietly this cycle; the next edit reschedules a save.
    toastError(`Could not save ${name}: the file is being modified externally.`);
    // `debouncer` is referenced above but declared after this callback (see
    // note there) — deliberately omitted from deps; its identity never
    // changes for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, ticketId, relPath, readFile, name]);

  const debouncer = useDebouncedCallback(() => void commit(), AUTOSAVE_IDLE_MS);

  // fs-watch subscription for this tab's lifetime. `onChanged` fires debounced;
  // read-only views adopt silently, the markdown editor stays dirty/focus-aware.
  React.useEffect(() => {
    void window.api.files.watch({ projectId, ticketId, relPath }).then((result) => {
      if (!result.ok) {
        toastError(
          `Live updates for ${name} are unavailable — it may not refresh until you reopen it.`,
        );
      }
    });
    const unsubscribe = window.api.files.onChanged((event) => {
      if (event.projectId !== projectId || event.relPath !== relPath) return;
      void (async () => {
        const disk = await readFile();
        if (!mountedRef.current) return;
        if (!disk.ok) {
          // The file was deleted (or is now unreadable) under an open tab. A
          // dirty markdown draft (unsaved user work) is worth protecting — a
          // read error can't destroy a buffer that isn't visible anywhere
          // else, so just toast and leave the editor up. Anything else (a
          // clean markdown tab, or a tab that was never editable to begin
          // with) transitions to the read-only 'error' view so the deletion
          // is actually visible instead of rendering stale content forever.
          const dirty = draftRef.current !== syncedRef.current;
          if (stateRef.current.status === "markdown" && dirty) {
            toastError(`${name} changed on disk (now unreadable) — your unsaved edits were kept.`);
          } else {
            setState({ status: "error", error: disk.error });
          }
          return;
        }
        onSource?.(relPath, disk.source);
        if (disk.content.type === "image") {
          setState({ status: "image", dataUrl: disk.content.dataUrl });
          return;
        }
        if (disk.content.type === "binary") {
          setState({ status: "binary" });
          return;
        }
        // Read-only text (non-markdown, or truncated markdown): swap it in
        // unconditionally — nothing to protect.
        if (disk.kind !== "markdown" || disk.content.truncated) {
          syncedMtimeRef.current = disk.mtime;
          setState({
            status: "code",
            text: disk.content.text,
            truncated: disk.content.truncated,
            source: disk.source,
            revision: disk.mtime,
          });
          return;
        }
        // Markdown, no real change vs the content baseline (also the echo of
        // our own write) — still land on the editor if the tab was showing
        // 'error'/'code' (recovering from a prior deletion/truncation), even
        // though there's nothing to adopt content-wise.
        if (disk.content.text === syncedRef.current) {
          if (stateRef.current.status !== "markdown") {
            syncedMtimeRef.current = disk.mtime;
            draftRef.current = disk.content.text;
            setDocValue(disk.content.text);
            setState({ status: "markdown" });
          }
          return;
        }
        const dirty = draftRef.current !== syncedRef.current;
        // A conflict banner only means something over a live editor. A tab
        // that wasn't already 'markdown' has no editor and nothing to
        // protect — draftRef/syncedRef only ever diverge while editing, so
        // `dirty` is always false coming from 'error'/'code' — but guard on
        // status explicitly anyway so a stale conflict flag from a state this
        // tab has since left can't wedge it: always take the full-transition
        // adopt path in that case rather than raising a banner that can't
        // render outside 'markdown'.
        if (
          stateRef.current.status !== "markdown" ||
          (!dirty && !focusedRef.current && conflictRef.current === null)
        ) {
          syncedRef.current = disk.content.text;
          syncedMtimeRef.current = disk.mtime;
          draftRef.current = disk.content.text;
          setDocValue(disk.content.text);
          setState({ status: "markdown" });
          if (conflictRef.current !== null) setConflict(null);
        } else {
          setConflict({ text: disk.content.text, mtime: disk.mtime });
        }
      })();
    });
    return () => {
      unsubscribe();
      void window.api.files.unwatch({ projectId, ticketId, relPath });
    };
  }, [projectId, ticketId, relPath, readFile, name, onSource]);

  function handleChange(next: string) {
    draftRef.current = next;
    if (conflictRef.current !== null) return; // paused until reload
    debouncer.schedule();
  }

  function reload() {
    const disk = conflictRef.current;
    if (disk === null) return;
    debouncer.cancel();
    // Restore both baselines from the captured disk snapshot — content AND its
    // mtime — so the next write's `expectedMtime` matches disk and isn't wedged.
    syncedRef.current = disk.text;
    syncedMtimeRef.current = disk.mtime;
    draftRef.current = disk.text;
    setDocValue(disk.text); // editor is unfocused (the button took focus) → doc resets
    setConflict(null);
  }

  async function handleReveal() {
    try {
      const result = await window.api.files.reveal({ projectId, ticketId, relPath });
      if (!result.ok) toastError(`Could not reveal in Finder: ${result.error}`);
    } catch (error) {
      toastError(`Could not reveal in Finder: ${errorMessage(error)}`);
    }
  }

  const revealButton = (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Reveal in Finder"
      onClick={() => void handleReveal()}
    >
      <FolderOpenIcon />
    </Button>
  );

  if (state.status === "loading") {
    return <p className="px-gutter py-4 text-xs text-muted-foreground">Loading…</p>;
  }
  if (state.status === "error") {
    return <p className="px-gutter py-4 text-xs text-destructive">{state.error}</p>;
  }

  // Markdown → Tier A reading measure; everything else is workbench-fluid.
  if (state.status === "markdown") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <ContentColumn className="flex flex-col gap-2 py-6">
          {conflict !== null && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <span>Changed on disk — autosave paused to avoid overwriting.</span>
              <Button size="sm" variant="secondary" onClick={reload}>
                <ArrowClockwiseIcon />
                Reload
              </Button>
            </div>
          )}
          <div
            className="min-h-64"
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
              ariaLabel={`${name} contents`}
              className="min-h-full"
              fileRefs={fileRefs}
            />
          </div>
        </ContentColumn>
      </div>
    );
  }

  if (state.status === "code") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-gutter py-4">
        {state.truncated && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span>Showing the first 1 MiB — reveal in Finder for the full file.</span>
            {revealButton}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
          <MonacoCodeView
            identity={fileDocumentIdentity({
              projectId,
              ticketId,
              relPath,
              source: state.source,
            })}
            value={state.text}
            revision={state.revision}
            viewId={`file:${projectId}:${ticketId ?? "main"}:${relPath}:source`}
            ariaLabel={`${name} contents`}
          />
        </div>
      </div>
    );
  }

  if (state.status === "image") {
    return (
      <div className="min-h-0 flex-1 overflow-auto px-gutter py-4">
        <img
          src={state.dataUrl}
          alt={name}
          className="max-w-full self-start rounded-md border border-border object-contain"
        />
      </div>
    );
  }

  // binary
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <FolderOpenIcon weight="fill" className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{name} can&apos;t be previewed here.</p>
      <Button size="sm" variant="secondary" onClick={() => void handleReveal()}>
        <FolderOpenIcon />
        Reveal in Finder
      </Button>
    </div>
  );
}
