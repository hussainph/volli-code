import * as React from "react";
import type { editor } from "monaco-editor";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { errorMessage } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import { documentIdentityKey, type DocumentIdentity } from "@renderer/editor/document-identity";
import type { DocumentLease, DocumentRevision } from "@renderer/editor/document-registry";
import { loadMonacoRuntime, startModelLanguageWorker } from "@renderer/editor/monaco-runtime";
import { toastError } from "@renderer/lib/toast";

/** What a host's `onSave` reports back: the fresh disk revision, or why it failed. */
export type MonacoFileSaveResult =
  | { ok: true; revision: DocumentRevision }
  | { ok: false; error: string };

export interface MonacoFileEditorProps {
  identity: DocumentIdentity;
  /** Disk content at load — the registry seed and the clean baseline. */
  value: string;
  /** Disk mtime at load; a new revision means the host re-read the file. */
  revision: DocumentRevision;
  viewId: string;
  ariaLabel: string;
  /** Renders a read-only editor (truncated/oversize reads); Cmd-S then never writes. */
  readOnly: boolean;
  /** Performs the actual write. The editor only reads the model and delegates. */
  onSave(text: string): Promise<MonacoFileSaveResult>;
  /** Fires on every dirty transition so the workbench can pin/guard the tab. */
  onDirtyChange?(dirty: boolean): void;
  /** Cursor/folding/scroll persisted by the store, used when the registry has none. */
  initialViewState?: unknown;
  /** Emitted when this view releases, so the store can persist the view state. */
  onViewStateChange?(viewState: unknown): void;
}

type MonacoLease = DocumentLease<editor.ITextModel, editor.ICodeEditorViewState>;

/** What a Cmd-S should actually do, given the document's current condition. */
export type ExplicitSaveAction = "save" | "skip-read-only" | "skip-in-flight" | "skip-clean";

/**
 * Explicit save is deliberately narrow (CONCEPT #49): a read-only view never
 * writes, a second Cmd-S during an in-flight write is coalesced rather than
 * queued, and a clean document is left alone so Cmd-S can't churn its mtime
 * (which would look like an external change to every other open view).
 */
export function planExplicitSave(input: {
  readOnly: boolean;
  saving: boolean;
  dirty: boolean;
}): ExplicitSaveAction {
  if (input.readOnly) return "skip-read-only";
  if (input.saving) return "skip-in-flight";
  if (!input.dirty) return "skip-clean";
  return "save";
}

/** How a fresh on-disk read relates to what this view is showing. */
export type ExternalChangeDecision = "unchanged" | "adopt" | "diverged";

/**
 * Decides whether a re-read is worth reacting to. Two events look like external
 * changes but aren't: a bare mtime touch (identical bytes) and the fs-watch
 * echo of this view's own write — neither may raise a "Changed on disk" banner,
 * and the echo case has to be caught by content because the user may already
 * have typed again, making the document dirty against the saved bytes.
 * Only genuinely different bytes arriving over a dirty draft diverge.
 */
export function classifyExternalChange(input: {
  baseline: string;
  dirty: boolean;
  incoming: string;
  lastWrite: string | null;
}): ExternalChangeDecision {
  if (input.incoming === input.baseline) return "unchanged";
  if (input.lastWrite !== null && input.incoming === input.lastWrite) return "unchanged";
  return input.dirty ? "diverged" : "adopt";
}

/** A failed write is never swallowed — this is what the user is told (CLAUDE.md). */
export function saveFailureMessage(label: string, error: string): string {
  const detail = error.trim();
  return detail === "" ? `Could not save ${label}.` : `Could not save ${label}: ${detail}`;
}

/** Screen-reader label: the document's own name plus the state that changes what typing does. */
export function fileEditorAriaLabel(input: {
  label: string;
  readOnly: boolean;
  dirty: boolean;
}): string {
  if (input.readOnly) return `${input.label}, read-only`;
  return input.dirty ? `${input.label}, unsaved changes` : input.label;
}

interface DiskSnapshot {
  key: string;
  value: string;
  revision: DocumentRevision;
}

/**
 * An editable Monaco view over one file, with explicit Cmd-S save. Sibling of
 * the read-only {@link import("./monaco-code-view").MonacoCodeView}: the shared
 * registry owns the model, the baseline and the dirty flag; this component owns
 * only the disposable editor DOM and never writes to disk itself — every save
 * goes out through `onSave` and comes back as a revision to record.
 *
 * When disk moves under an unsaved draft, both versions are preserved: the
 * draft stays untouched and a passive banner offers Reload. There is no
 * merge/reconciliation here on purpose (that is issue #110).
 */
export function MonacoFileEditor({
  identity,
  value,
  revision,
  viewId,
  ariaLabel,
  readOnly,
  onSave,
  onDirtyChange,
  initialViewState,
  onViewStateChange,
}: MonacoFileEditorProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const editorRef = React.useRef<editor.IStandaloneCodeEditor | null>(null);
  const leaseRef = React.useRef<{ key: string; lease: MonacoLease } | null>(null);
  const key = documentIdentityKey(identity);
  const identityRef = React.useRef({ key, identity });
  identityRef.current = { key, identity };
  const seedRef = React.useRef<DiskSnapshot>({ key, value, revision });
  seedRef.current = { key, value, revision };

  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [stale, setStale] = React.useState<DiskSnapshot | null>(null);
  const [failure, setFailure] = React.useState<{ key: string; message: string } | null>(null);
  const currentFailure = failure !== null && failure.key === key ? failure : null;
  const currentStale = stale !== null && stale.key === key ? stale : null;

  const savingRef = React.useRef(false);
  // Text this view last handed to `onSave`. The fs watch echoes it back as a
  // "change"; without this the echo would raise a banner over a draft the user
  // resumed typing during the write.
  const lastWriteRef = React.useRef<string | null>(null);
  const emittedDirtyRef = React.useRef(false);
  // Props read from stable callbacks (the Monaco action is registered once).
  const liveRef = React.useRef({
    readOnly,
    ariaLabel,
    onSave,
    onViewStateChange,
    initialViewState,
  });
  liveRef.current = { readOnly, ariaLabel, onSave, onViewStateChange, initialViewState };

  const syncDirty = React.useCallback(() => {
    const active = leaseRef.current;
    if (active === null) return;
    setDirty(active.lease.snapshot().dirty);
  }, []);

  /**
   * Applies a fresh disk read to the shared document. An adoptable change is
   * swapped in silently; the view state is saved and restored around it because
   * the registry replaces the model's whole value, which would otherwise drop
   * the caret and scroll position.
   */
  const reconcileExternal = React.useCallback(
    (lease: MonacoLease, seed: DiskSnapshot) => {
      const before = lease.snapshot();
      const decision = classifyExternalChange({
        baseline: before.baseline,
        dirty: before.dirty,
        incoming: seed.value,
        lastWrite: lastWriteRef.current,
      });
      const viewState = editorRef.current?.saveViewState() ?? null;
      lease.adoptCleanBaseline({ value: seed.value, revision: seed.revision });
      if (viewState !== null) editorRef.current?.restoreViewState(viewState);
      setStale(decision === "diverged" ? seed : null);
      syncDirty();
    },
    [syncDirty],
  );

  const runSave = React.useCallback(async () => {
    const active = leaseRef.current;
    if (active === null) return;
    const { lease } = active;
    const label = liveRef.current.ariaLabel;
    const action = planExplicitSave({
      readOnly: liveRef.current.readOnly,
      saving: savingRef.current,
      dirty: lease.snapshot().dirty,
    });
    if (action !== "save") return;

    const text = lease.model.getValue();
    savingRef.current = true;
    setSaving(true);
    lastWriteRef.current = text;
    try {
      const result = await liveRef.current.onSave(text);
      if (leaseRef.current?.lease !== lease) return; // view moved on mid-write
      if (!result.ok) {
        // The draft stays dirty on purpose — nothing reached disk.
        toastError(saveFailureMessage(label, result.error));
        return;
      }
      if (lease.model.getValue() === text) {
        // Only claim the document is clean when it still holds the saved bytes;
        // `markSaved` adopts the model's *current* value as the baseline, which
        // would silently mark edits made during the write as already-saved.
        lease.markSaved(result.revision);
      }
      setStale(null);
      syncDirty();
    } catch (error) {
      toastError(saveFailureMessage(label, errorMessage(error)));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [syncDirty]);
  const runSaveRef = React.useRef(runSave);
  runSaveRef.current = runSave;

  React.useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let cancelled = false;
    let editorView: editor.IStandaloneCodeEditor | null = null;
    let lease: MonacoLease | null = null;
    let changeSubscription: { dispose(): void } | null = null;
    host.dataset.monacoStatus = "loading";

    void loadMonacoRuntime()
      .then((runtime) => {
        if (cancelled) return;

        const seed = seedRef.current;
        const activeIdentity = identityRef.current;
        if (seed.key !== key || activeIdentity.key !== key) return;
        lease = runtime.registry.acquire({
          identity: activeIdentity.identity,
          viewId,
          seed: { value: seed.value, revision: seed.revision },
          // The policy is fixed for this view's lifetime. A later `readOnly`
          // flip is applied with `updateOptions` instead of re-acquiring: the
          // registry refuses a policy change over a dirty document, and losing
          // the editor to the fallback <pre> would be a worse answer than a
          // slightly stale bookkeeping field.
          savePolicy: liveRef.current.readOnly ? "read-only" : "explicit",
        });
        leaseRef.current = { key, lease };

        if (cancelled) {
          lease.release();
          leaseRef.current = null;
          lease = null;
          return;
        }

        editorView = runtime.monaco.editor.create(host, {
          model: lease.model,
          theme: "volli-dark",
          readOnly: liveRef.current.readOnly,
          domReadOnly: liveRef.current.readOnly,
          ariaLabel: fileEditorAriaLabel({
            label: liveRef.current.ariaLabel,
            readOnly: liveRef.current.readOnly,
            dirty: lease.snapshot().dirty,
          }),
          automaticLayout: true,
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: 21,
          lineNumbers: "on",
          minimap: { enabled: false },
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          padding: { top: 12, bottom: 12 },
        });
        editorRef.current = editorView;

        // Monaco swallows Cmd-S inside the editor, so the binding has to be
        // editor-local. It only reads the model and delegates to the host.
        editorView.addAction({
          id: "volli.file.save",
          label: "Save File",
          keybindings: [runtime.monaco.KeyMod.CtrlCmd | runtime.monaco.KeyCode.KeyS],
          run: () => {
            void runSaveRef.current();
          },
        });

        const restored = lease.restoreViewState();
        const fallbackViewState = liveRef.current.initialViewState as
          | editor.ICodeEditorViewState
          | null
          | undefined;
        const viewState = restored ?? fallbackViewState ?? null;
        if (viewState !== null) editorView.restoreViewState(viewState);

        changeSubscription = lease.model.onDidChangeContent(() => {
          syncDirty();
        });

        const language = lease.snapshot().language;
        host.dataset.monacoStatus = "ready";
        host.dataset.monacoLanguage = language;
        host.dataset.monacoWorker =
          language === "typescript" || language === "javascript" ? "starting" : "not-required";

        // A document parked dirty from an earlier mount may already disagree
        // with the seed we just re-read from disk.
        reconcileExternal(lease, seedRef.current);

        void startModelLanguageWorker(runtime, lease.model)
          .then((worker) => {
            if (cancelled) return;
            host.dataset.monacoWorker = worker === null ? "not-required" : "ready";
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            host.dataset.monacoWorker = "failed";
            console.error("Monaco language worker failed", error);
          });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        changeSubscription?.dispose();
        changeSubscription = null;
        editorView?.dispose();
        editorView = null;
        editorRef.current = null;
        lease?.release();
        lease = null;
        if (leaseRef.current?.key === key) leaseRef.current = null;
        host.dataset.monacoStatus = "failed";
        const message = error instanceof Error ? error.message : String(error);
        console.error("Monaco file editor failed", error);
        setFailure({ key, message });
      });

    return () => {
      cancelled = true;
      changeSubscription?.dispose();
      if (leaseRef.current?.key === key) leaseRef.current = null;
      editorRef.current = null;
      if (editorView !== null) {
        const viewState = editorView.saveViewState();
        editorView.dispose();
        lease?.release(viewState);
        liveRef.current.onViewStateChange?.(viewState);
      } else {
        lease?.release();
      }
    };
  }, [key, reconcileExternal, syncDirty, viewId]);

  // A fresh disk read arrived (initial load, or the tab's fs-watch re-read).
  React.useEffect(() => {
    const active = leaseRef.current;
    if (active?.key !== key) return; // the mount effect reconciles its own seed
    reconcileExternal(active.lease, { key, value, revision });
  }, [key, reconcileExternal, revision, value]);

  React.useEffect(() => {
    if (emittedDirtyRef.current === dirty) return;
    emittedDirtyRef.current = dirty;
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Status attributes mirror the read-only view's idiom so a packaged smoke can
  // assert the editor's real state rather than infer it from the DOM.
  React.useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    host.dataset.monacoReadOnly = readOnly ? "true" : "false";
    host.dataset.monacoDirty = dirty ? "true" : "false";
    host.dataset.monacoSaving = saving ? "true" : "false";
    host.dataset.monacoStale = currentStale !== null ? "true" : "false";
  }, [currentStale, dirty, readOnly, saving]);

  React.useEffect(() => {
    editorRef.current?.updateOptions({
      readOnly,
      domReadOnly: readOnly,
      ariaLabel: fileEditorAriaLabel({ label: ariaLabel, readOnly, dirty }),
    });
  }, [ariaLabel, dirty, readOnly]);

  function reloadFromDisk() {
    const active = leaseRef.current;
    if (active === null || currentStale === null) return;
    const editorView = editorRef.current;
    const viewState = editorView?.saveViewState() ?? null;
    // Drop the draft first so the document is clean, then take disk truth —
    // `adoptCleanBaseline` refuses to touch a dirty model by design.
    active.lease.discard();
    active.lease.adoptCleanBaseline({ value: currentStale.value, revision: currentStale.revision });
    if (viewState !== null) editorView?.restoreViewState(viewState);
    lastWriteRef.current = null;
    setStale(null);
    syncDirty();
    editorView?.focus();
  }

  if (currentFailure !== null) {
    return (
      <pre
        data-monaco-fallback="true"
        aria-label={ariaLabel}
        title={`Monaco unavailable: ${currentFailure.message}`}
        className="h-full overflow-auto whitespace-pre-wrap p-3 font-mono text-ui text-foreground"
      >
        {value}
      </pre>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {currentStale !== null && (
        <div className="mx-2 mt-2 flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {/* The second sentence is the part users need before they reflexively
              hit ⌘S: there is no merge here (issue #110), so an explicit save
              from this state replaces whatever landed on disk. */}
          <span>
            Changed on disk — your unsaved edits were kept. Saving now overwrites the newer version
            on disk.
          </span>
          <Button size="sm" variant="secondary" onClick={reloadFromDisk}>
            <ArrowClockwiseIcon />
            Reload
          </Button>
        </div>
      )}
      <div ref={hostRef} className="min-h-0 w-full flex-1 overflow-hidden" />
    </div>
  );
}
