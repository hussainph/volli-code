import * as React from "react";
import type * as Monaco from "monaco-editor";
import type { editor } from "monaco-editor";
import { errorMessage } from "@volli/shared";

import { LiveReconciliationAffordance } from "@renderer/components/editor/live-reconciliation-affordance";
import { documentIdentityKey, type DocumentIdentity } from "@renderer/editor/document-identity";
import { DOCUMENT_MODE_CLASS } from "@renderer/editor/document-mode-contribution";
import { documentModeOptions } from "@renderer/editor/document-mode";
import { surfaceGoToLine } from "@renderer/editor/go-to-line";
import { applyFileReveal, onFileReveal, takeFileReveal } from "@renderer/editor/reveal-line";
import type { DocumentLease, DocumentRevision } from "@renderer/editor/document-registry";
import {
  applyLiveDocumentReconciliation,
  type LiveDocumentReconciliationPlan,
  type LiveReconciliationLease,
  type LocalWriteReceipt,
} from "@renderer/editor/live-document-reconciliation";
import { activeMonacoEditorThemeId } from "@renderer/editor/monaco-theme";
import { loadMonacoRuntime, startModelLanguageWorker } from "@renderer/editor/monaco-runtime";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

/** What a host's `onSave` reports back: the fresh disk revision, or why it failed. */
export type MonacoFileSaveResult =
  | { ok: true; revision: DocumentRevision }
  | { ok: false; error: string };

/**
 * Monaco options a host may set per document, on top of whichever look
 * {@link FileEditorSurface} selected. Document Mode was the reason this
 * existed — the same editor, the same model and the same save contract, but no
 * line numbers, no gutter, and a reading measure's padding — and now that
 * repository Markdown actually mounts it (VC-192) that look has a name of its
 * own; this stays for tweaks on top of either one.
 *
 * The keys the component owns are omitted, not merely overridden last: `model`
 * comes from the shared registry, `theme` is owned by the theming engine (issue
 * #122), and `readOnly`/`domReadOnly`/`ariaLabel` are re-applied from props on
 * every change — a host that set them here would watch them silently revert.
 */
export type MonacoDocumentOptions = Omit<
  editor.IStandaloneEditorConstructionOptions,
  "model" | "value" | "language" | "theme" | "readOnly" | "domReadOnly" | "ariaLabel"
>;

/** The live editor a contribution attaches to, and what it needs to do so. */
export interface MonacoEditorContext {
  editor: editor.IStandaloneCodeEditor;
  /** The registry-owned model. Shared with every other view of this document. */
  model: editor.ITextModel;
  /** The loaded namespace — the only way to reach `languages.*` registration. */
  monaco: typeof Monaco;
}

/**
 * Attaches behaviour to a freshly created editor: decorations, content widgets,
 * view zones, a completion provider. Called exactly once per editor, after its
 * view state is restored and before the first external reconcile.
 *
 * Whatever it returns is disposed when the editor is torn down — the seam that
 * makes it safe to register globals like a completion provider here, which
 * would otherwise leak one registration per mount.
 */
export type MonacoEditorContribution = (
  context: MonacoEditorContext,
) => { dispose(): void } | undefined;

/**
 * The mount effect's contribution call site, extracted so the once-on-mount /
 * dispose-on-teardown contract can be unit-tested without a real Monaco (or a
 * DOM). The effect still owns *when* this runs; this owns *how*.
 */
export function attachEditorContribution(
  contribute: MonacoEditorContribution | undefined,
  context: MonacoEditorContext,
): { dispose(): void } | null {
  return contribute?.(context) ?? null;
}

/** How a word-wrap preference reaches Monaco. */
export function wordWrapOption(wordWrap: boolean): "on" | "off" {
  return wordWrap ? "on" : "off";
}

/**
 * Which surface this view wears. The two are mutually exclusive and always
 * were — `editor/source-mode.css` and `editor/document-mode.css` each scope
 * their rules under their own class — so it is one choice, not a pair of flags.
 *
 * `document` is Document Mode over a file that keeps the EXPLICIT save contract
 * (plan §4.6): repository Markdown, whose ⌘S, dirty flag, close guard and
 * conflict banner are the ones this component already owns. The autosaving
 * document surface is a different component (`MonacoDocumentEditor`) precisely
 * because its save contract differs — not because its look does.
 */
export type FileEditorSurface = "source" | "document";

/** The host class each surface's stylesheet scopes its rules under. */
const SURFACE_CLASS: Record<FileEditorSurface, string> = {
  source: "volli-source-mode",
  document: DOCUMENT_MODE_CLASS,
};

/** The source-mode look: a code file, with its gutter and monospace measure. */
const SOURCE_MODE_OPTIONS: MonacoDocumentOptions = {
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
};

/**
 * The option set one editor is created with. Host overrides land between the
 * source-mode defaults and the component-owned keys, so a host can restyle the
 * document freely without being able to take over the state this component is
 * responsible for keeping true.
 */
export function fileEditorConstructionOptions(input: {
  readOnly: boolean;
  ariaLabel: string;
  /** Which look (see {@link FileEditorSurface}); `source` when omitted. */
  surface?: FileEditorSurface;
  /**
   * The user's word-wrap choice (stores/ui). Omitted by a host that has an
   * opinion of its own — Document Mode always wraps, because prose that did not
   * would not be prose.
   */
  wordWrap?: boolean;
  overrides?: MonacoDocumentOptions;
}): editor.IStandaloneEditorConstructionOptions {
  return {
    ...(input.surface === "document" ? documentModeOptions({}) : SOURCE_MODE_OPTIONS),
    ...input.overrides,
    ...(input.wordWrap === undefined ? {} : { wordWrap: wordWrapOption(input.wordWrap) }),
    theme: activeMonacoEditorThemeId(),
    readOnly: input.readOnly,
    domReadOnly: input.readOnly,
    ariaLabel: input.ariaLabel,
  };
}

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
  /**
   * Source Mode (the default) or Document Mode over the same file and the same
   * save contract — see {@link FileEditorSurface}. Read at creation, like
   * {@link MonacoFileEditorProps.options}: a host that flips it must also give
   * the view a new `viewId`, since the two surfaces remember different cursors
   * in the same document.
   */
  surface?: FileEditorSurface;
  /**
   * Wrap long lines? The app-wide preference (stores/ui), pushed down rather
   * than read here so this component keeps taking its whole state from props.
   * Applied live with `updateOptions` — unlike {@link MonacoFileEditorProps.options},
   * a wrap flip is the same document in the same view, not a different one.
   */
  wordWrap?: boolean;
  /** Performs the actual write. The editor only reads the model and delegates. */
  onSave(text: string): Promise<MonacoFileSaveResult>;
  /** Fires on every dirty transition so the workbench can pin/guard the tab. */
  onDirtyChange?(dirty: boolean): void;
  /**
   * Per-document Monaco option overrides. Applied at creation only: a view that
   * needs to restyle mid-life is a different document, and remounting it is
   * cheaper to reason about than diffing an editor's whole option set.
   */
  options?: MonacoDocumentOptions;
  /** Attaches Document Mode (or anything else) to this view's editor. */
  contribute?: MonacoEditorContribution;
  /**
   * The document's reveal key (`editor/reveal-line.ts`) — how a search result
   * that opened this file says WHERE in it to land (VC-193). Omitted by a host
   * with no such gesture; an editor without one simply never checks the slot.
   */
  revealKey?: string;
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

/**
 * Whether a window-level keydown is a ⌘S this editor should answer.
 *
 * Monaco binds ⌘S itself, but only inside its own DOM — so the moment focus sits
 * anywhere else (a tab the user just clicked, the conflict banner's buttons, the
 * file tree) ⌘S did nothing at all, silently, while the draft sat unsaved. The
 * window listener closes that gap and defers in the two cases where answering
 * would be wrong:
 *
 *  - `defaultPrevented` — Monaco's own keybinding already ran (it preventDefaults
 *    and stops propagation), so answering again would be a second write of the
 *    same bytes racing the first one's mtime.
 *  - the keystroke came from ANOTHER editor's DOM — that editor owns it.
 *
 * Never `repeat`: holding ⌘S is one save, not a stream of them.
 */
export function isGlobalSaveShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "repeat" | "defaultPrevented"
  >,
  isForeignEditorTarget: boolean,
): boolean {
  if (event.defaultPrevented || event.repeat || event.altKey) return false;
  if (event.key !== "s" && event.key !== "S") return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return !isForeignEditorTarget;
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
 * Apply one disk seed through the shared File/Diff policy.
 *
 * Deliberately does NOT snapshot and restore the editor's view state around the
 * mutation. The registry now lands an external write as MINIMAL edit operations
 * (`externalEditOperations`), and Monaco maps the caret, selection and folding
 * regions through those ranges itself — text the write did not touch keeps its
 * caret, and text that moved carries the caret with it. Restoring an absolute
 * pre-edit snapshot on top of that would undo exactly that mapping and pin the
 * caret to a line number the agent's insertion had already shifted.
 */
export function applyExternalSeed(input: {
  lease: LiveReconciliationLease;
  lastWrite: LocalWriteReceipt | null;
  seed: Pick<DiskSnapshot, "value" | "revision">;
}): LiveDocumentReconciliationPlan {
  return applyLiveDocumentReconciliation({
    lease: input.lease,
    lastWrite: input.lastWrite,
    disk: {
      ok: true,
      text: input.seed.value,
      revision: input.seed.revision,
      truncated: false,
    },
  });
}

/**
 * The Monaco view over one file — the ONE file editor, editable or `readOnly`,
 * in Source Mode or Document Mode, for every surface that shows file contents.
 * The shared registry owns the model, the baseline and the dirty flag; this
 * component owns only the disposable editor DOM and never writes to disk itself
 * — every save goes out through `onSave` and comes back as a revision to
 * record. Both surfaces therefore save the same way: explicitly, on ⌘S,
 * conflict-guarded by the host's mtime (CONCEPT #49).
 *
 * Disk changes run through the shared A/L/D reconciliation policy. Disjoint
 * edits merge in place; conflicts preserve both versions behind explicit
 * consequence-labelled actions.
 */
export function MonacoFileEditor({
  identity,
  value,
  revision,
  viewId,
  ariaLabel,
  readOnly,
  surface = "source",
  wordWrap,
  onSave,
  onDirtyChange,
  options,
  contribute,
  revealKey,
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
  // Exact successful write this view last handed to disk. Both bytes and
  // revision must match before a watch event is classified as our own echo.
  const lastWriteRef = React.useRef<LocalWriteReceipt | null>(null);
  const emittedDirtyRef = React.useRef(false);
  // Props read from stable callbacks (the Monaco action is registered once).
  const liveRef = React.useRef({
    readOnly,
    ariaLabel,
    surface,
    wordWrap,
    onSave,
    onViewStateChange,
    initialViewState,
    options,
    contribute,
    revealKey,
  });
  liveRef.current = {
    readOnly,
    ariaLabel,
    surface,
    wordWrap,
    onSave,
    onViewStateChange,
    initialViewState,
    options,
    contribute,
    revealKey,
  };

  const syncDirty = React.useCallback(() => {
    const active = leaseRef.current;
    if (active === null) return;
    setDirty(active.lease.snapshot().dirty);
  }, []);

  /** Applies a fresh disk read through the shared File/Diff A/L/D policy. */
  const reconcileExternal = React.useCallback(
    (lease: MonacoLease, seed: DiskSnapshot) => {
      const plan = applyExternalSeed({ lease, lastWrite: lastWriteRef.current, seed });
      setStale(plan.kind === "conflict" ? seed : null);
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
    try {
      const result = await liveRef.current.onSave(text);
      if (leaseRef.current?.lease !== lease) return; // view moved on mid-write
      if (!result.ok) {
        // The draft stays dirty on purpose — nothing reached disk.
        toastError(saveFailureMessage(label, result.error));
        return;
      }
      lastWriteRef.current = { text, revision: result.revision };
      if (lease.model.getValue() === text) {
        // Only claim the document is clean when it still holds the saved bytes;
        // `markSaved` adopts the model's *current* value as the baseline, which
        // would silently mark edits made during the write as already-saved.
        lease.markSaved(result.revision);
      } else {
        // Typing resumed while the guarded write was in flight. The written
        // bytes are the new disk baseline; the newer model value stays dirty.
        lease.applyExternalUpdate({
          baseline: text,
          value: lease.model.getValue(),
          revision: result.revision,
        });
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
    let contribution: { dispose(): void } | null = null;
    let goToLine: { dispose(): void } | null = null;
    let revealSubscription: (() => void) | null = null;
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
          ...fileEditorConstructionOptions({
            readOnly: liveRef.current.readOnly,
            ariaLabel: fileEditorAriaLabel({
              label: liveRef.current.ariaLabel,
              readOnly: liveRef.current.readOnly,
              dirty: lease.snapshot().dirty,
            }),
            surface: liveRef.current.surface,
            wordWrap: liveRef.current.wordWrap,
            overrides: liveRef.current.options,
          }),
          model: lease.model,
        });
        editorRef.current = editorView;

        // ⌃G, and the editor a palette row means (editor/go-to-line.ts).
        goToLine = surfaceGoToLine(
          editorView,
          runtime.monaco.KeyMod.WinCtrl | runtime.monaco.KeyCode.KeyG,
        );

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

        // Document Mode and friends attach here — after the view state is
        // restored (so a contribution measuring the viewport sees the real
        // scroll position) and before the first external reconcile.
        contribution = attachEditorContribution(liveRef.current.contribute, {
          editor: editorView,
          model: lease.model,
          monaco: runtime.monaco,
        });

        changeSubscription = lease.model.onDidChangeContent(() => {
          syncDirty();
        });

        // Land on a match (VC-193). Both halves of the race are served here:
        // the click that OPENED this tab left its request in the slot while
        // Monaco was still loading, and a click made from now on arrives
        // through the subscription. Neither can double-apply — the slot is
        // taken, not read.
        const revealTarget = liveRef.current.revealKey;
        if (revealTarget !== undefined) {
          const view = editorView;
          const landOnPending = (): void => {
            const target = takeFileReveal(revealTarget);
            if (target !== null) applyFileReveal(view, target);
          };
          revealSubscription = onFileReveal(revealTarget, landOnPending);
          landOnPending();
        }

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
        contribution?.dispose();
        contribution = null;
        goToLine?.dispose();
        goToLine = null;
        revealSubscription?.();
        revealSubscription = null;
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
      // Before the editor goes: a contribution's widgets and view zones belong
      // to it, and its provider registrations are global.
      contribution?.dispose();
      goToLine?.dispose();
      revealSubscription?.();
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

  // ⌘S outside the editor's own DOM. Routed through the SAME `runSave` as
  // Monaco's editor-local action, so the two can never become two writes: a
  // second call while the first is in flight is coalesced by `planExplicitSave`,
  // and a clean document is skipped entirely.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const host = hostRef.current;
      const target = event.target;
      // `[data-monaco-status]` is the marker every file-editor host carries, so
      // this is "some OTHER editor is where this keystroke came from".
      const foreign =
        host !== null &&
        target instanceof Element &&
        !host.contains(target) &&
        target.closest("[data-monaco-status]") !== null;
      if (!isGlobalSaveShortcut(event, foreign)) return;
      event.preventDefault();
      void runSaveRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

  // The word-wrap control is elsewhere (the file tab's menu, the diff's band),
  // so this arrives while the editor is up and mid-draft: `updateOptions`, never
  // a remount, which would cost the caret and the undo stack to change a view.
  React.useEffect(() => {
    if (wordWrap === undefined) return;
    editorRef.current?.updateOptions({ wordWrap: wordWrapOption(wordWrap) });
  }, [wordWrap]);

  /**
   * The conflict banner's "use disk" consequence: the draft is genuinely thrown
   * away, so the pre-edit view state is still the right thing to land on. Focus
   * returns to the editor because the click that got here moved it to a button
   * that is about to unmount.
   */
  function applyDiskAndDiscardDraft() {
    const active = leaseRef.current;
    if (active === null || currentStale === null) return;
    const editorView = editorRef.current;
    const viewState = editorView?.saveViewState() ?? null;
    active.lease.applyExternalUpdate({
      baseline: currentStale.value,
      value: currentStale.value,
      revision: currentStale.revision,
    });
    if (viewState !== null) editorView?.restoreViewState(viewState);
    editorView?.focus();
    lastWriteRef.current = null;
    setStale(null);
    syncDirty();
  }

  if (currentFailure !== null) {
    return (
      <pre
        data-monaco-fallback="true"
        aria-label={ariaLabel}
        title={`Monaco unavailable: ${currentFailure.message}`}
        className="h-full overflow-auto whitespace-pre-wrap p-4 font-mono text-ui text-foreground"
      >
        {value}
      </pre>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {currentStale !== null && (
        <LiveReconciliationAffordance
          kind="conflict"
          onUseDisk={applyDiskAndDiscardDraft}
          onOverwriteDisk={() => void runSaveRef.current()}
        />
      )}
      {/* The surface class is the hook each stylesheet paints the editor's
          FURNITURE through — `editor/source-mode.css` for the ground, gutter,
          selection and find widget; `editor/document-mode.css` for the live
          preview's type and widgets. Mutually exclusive: a host wears one. */}
      <div
        ref={hostRef}
        className={cn(SURFACE_CLASS[surface], "min-h-0 w-full flex-1 overflow-hidden")}
      />
    </div>
  );
}
