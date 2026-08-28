/**
 * Monaco DiffEditor host (CONCEPT #48/#51, issue #109).
 *
 * Owns `createDiffEditor` lifecycle and model attachment. Original is always
 * read-only; modified may be editable and shares the same registry model as the
 * ticket file tab for that path. React never parses hunks — Monaco computes the
 * diff. Theme is applied via `monaco.editor.setTheme`, never construction
 * options.
 */
import * as React from "react";
import type { editor } from "monaco-editor";
import { errorMessage } from "@volli/shared";

import {
  planExplicitSave,
  saveFailureMessage,
  wordWrapOption,
  type MonacoFileSaveResult,
} from "@renderer/components/editor/monaco-file-editor";
import type { DocumentLease } from "@renderer/editor/document-registry";
import { surfaceGoToLine } from "@renderer/editor/go-to-line";
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
import { applyMonacoThemeForDiffEditor } from "@renderer/editor/monaco-theme";
import { toastError } from "@renderer/lib/toast";
import type { DiffPresentation } from "@renderer/stores/ui";

/** Minimal lease surface the pure release helper needs (registry or fake). */
export interface DiffLeaseHandle {
  release(viewState?: unknown): void;
}

/** Pair of leases held for one DiffEditor mount. */
export interface DiffLeasePair {
  original: DiffLeaseHandle;
  modified: DiffLeaseHandle;
}

type MonacoLease = DocumentLease<editor.ITextModel, editor.ICodeEditorViewState>;

/**
 * DiffEditor construction options. Deliberately omits `theme` — DiffEditor does
 * not honor a construction-time theme the way `create` does; callers must call
 * `monaco.editor.setTheme` after create.
 */
export function diffEditorConstructionOptions(input: {
  presentation: DiffPresentation;
  /** The app-wide word-wrap choice (stores/ui); both sides wrap together. */
  wordWrap?: boolean;
}): editor.IDiffEditorConstructionOptions {
  return {
    automaticLayout: true,
    renderSideBySide: input.presentation !== "inline",
    ...(input.wordWrap === undefined ? {} : { wordWrap: wordWrapOption(input.wordWrap) }),
    // Honor the user's Side-by-side choice even in a narrow ticket pane —
    // Monaco's default collapses to inline below ~900px and makes the toggle
    // look broken (issue #109 smoke).
    useInlineViewWhenSpaceIsLimited: false,
    originalEditable: false,
    readOnly: false,
    renderOverviewRuler: false,
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    lineHeight: 21,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    padding: { top: 12, bottom: 12 },
  };
}

/** Attach both sides. Monaco owns diff computation from here. */
export function attachDiffModels(
  diffEditor: editor.IStandaloneDiffEditor,
  models: { original: editor.ITextModel; modified: editor.ITextModel },
): void {
  diffEditor.setModel(models);
}

/** Release both leases held for a DiffEditor mount. */
export function releaseDiffLeases(pair: DiffLeasePair, modifiedViewState?: unknown): void {
  pair.original.release();
  pair.modified.release(modifiedViewState);
}

/** Copy when DiffEditor construction fails — DiffView shows this in DiffStub. */
export function diffEditorInitFailureMessage(label: string, detail: string): string {
  return `Couldn't load ${label}: ${detail}`;
}

/**
 * Anything the browser focuses on its own — a Monaco widget's field, the find
 * box, a link. A press on one of these is not ours to redirect.
 */
const NATIVELY_FOCUSABLE = 'input, textarea, select, button, a[href], [contenteditable="true"]';

/**
 * Which side of the diff a pointer press must be given focus on, or `null` to
 * leave the press entirely alone (VC-148).
 *
 * WHAT WAS ACTUALLY WRONG, measured against the built app rather than guessed:
 * a click on a real, visible line in the Changes diff left
 * `document.activeElement` as `BODY`, so ⌘S — an action on the modified editor,
 * live only while that editor holds focus — and every keyboard scroll were
 * unreachable from a mouse. Monaco's `MouseHandler` focuses and calls
 * `preventDefault()` only when its own hit-test resolves the point to editor
 * TEXT; in the inline diff the modified editor also carries Monaco's
 * deleted-line view zones, the hit-test comes back as something it does not
 * handle, and nothing calls `preventDefault()`. Chromium's default mousedown
 * action then focuses the nearest focusable ancestor of the hit node — there is
 * none — and so CLEARS focus to the body. A file tab has no view zones, which is
 * why the same click focuses it normally.
 *
 * That is why the caller must `preventDefault()` alongside focusing: an earlier
 * attempt at this focused the editor and watched the browser's own default undo
 * it microseconds later, inside the same press.
 *
 * CAPTURE PHASE, for a second measured reason: Monaco stops the press
 * propagating, so a bubble-phase listener on the host never hears the one
 * gesture that matters. Running first also means `activeElement` is whatever the
 * PREVIOUS interaction left — hence the null case is "the user is already in
 * this side", the ordinary second click, which must not be re-focused mid-drag.
 *
 * The press lands on the side it landed on rather than always on the modified
 * one: the base side is text a person reads and copies, and dragging a selection
 * across it must not throw the caret into the other pane.
 */
export function diffFocusTarget(input: {
  originalDom: Element | null;
  modifiedDom: Element | null;
  target: Element | null;
  activeElement: Node | null;
}): "original" | "modified" | null {
  const { target } = input;
  if (target === null || target.closest(NATIVELY_FOCUSABLE) !== null) return null;
  const side =
    input.modifiedDom?.contains(target) === true
      ? "modified"
      : input.originalDom?.contains(target) === true
        ? "original"
        : null;
  if (side === null) return null;
  const dom = side === "modified" ? input.modifiedDom : input.originalDom;
  return input.activeElement !== null && dom?.contains(input.activeElement) === true ? null : side;
}

export interface MonacoDiffEditorProps {
  /** Registry lease for the immutable base side (`diff-base` identity). */
  originalLease: MonacoLease;
  /** Registry lease for the live modified side (ticket `file` identity). */
  modifiedLease: MonacoLease;
  presentation: DiffPresentation;
  /** Wrap long lines? The app-wide preference (stores/ui), applied to both sides. */
  wordWrap: boolean;
  /** Modified side editable? Deleted / stub paths pass false. */
  modifiedReadOnly: boolean;
  ariaLabel: string;
  /** Explicit ⌘S for the modified side when editable (CONCEPT #49). */
  onSave(text: string): Promise<MonacoFileSaveResult>;
  onDirtyChange?(dirty: boolean): void;
  /**
   * Host-persisted Monaco view state for the modified side (issue #109). Used
   * when the registry has no in-session state for this viewId — e.g. after
   * relaunch, once DiffView remounts and reloads contents lazily.
   */
  initialViewState?: unknown;
  /** Emitted when the DiffEditor releases so the host can persist view state. */
  onViewStateChange?(viewState: unknown): void;
  /**
   * DiffEditor construction failed — parent should swap to an in-pane stub and
   * drop Inline/Side-by-side chrome (file-editor in-pane fallback spirit).
   */
  onInitFailed(message: string): void;
}

/**
 * Hosts one Monaco DiffEditor over two registry-owned models. The modified
 * model's dirty flag is the same one the file tab observes — dirty is shared by
 * identity, not duplicated here.
 */
export function MonacoDiffEditor({
  originalLease,
  modifiedLease,
  presentation,
  wordWrap,
  modifiedReadOnly,
  ariaLabel,
  onSave,
  onDirtyChange,
  initialViewState,
  onViewStateChange,
  onInitFailed,
}: MonacoDiffEditorProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const diffEditorRef = React.useRef<editor.IStandaloneDiffEditor | null>(null);
  const [dirty, setDirty] = React.useState(() => modifiedLease.snapshot().dirty);
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const emittedDirtyRef = React.useRef(false);
  const liveRef = React.useRef({
    modifiedReadOnly,
    ariaLabel,
    onSave,
    presentation,
    wordWrap,
    initialViewState,
    onViewStateChange,
    onInitFailed,
  });
  liveRef.current = {
    modifiedReadOnly,
    ariaLabel,
    onSave,
    presentation,
    wordWrap,
    initialViewState,
    onViewStateChange,
    onInitFailed,
  };

  const syncDirty = React.useCallback(() => {
    setDirty(modifiedLease.snapshot().dirty);
  }, [modifiedLease]);

  const runSave = React.useCallback(async () => {
    const action = planExplicitSave({
      readOnly: liveRef.current.modifiedReadOnly,
      saving: savingRef.current,
      dirty: modifiedLease.snapshot().dirty,
    });
    if (action !== "save") return;

    const text = modifiedLease.model.getValue();
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await liveRef.current.onSave(text);
      if (!result.ok) {
        toastError(saveFailureMessage(liveRef.current.ariaLabel, result.error));
        return;
      }
      if (modifiedLease.model.getValue() === text) {
        modifiedLease.markSaved(result.revision);
      }
      syncDirty();
    } catch (error) {
      toastError(saveFailureMessage(liveRef.current.ariaLabel, errorMessage(error)));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [modifiedLease, syncDirty]);
  const runSaveRef = React.useRef(runSave);
  runSaveRef.current = runSave;

  React.useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let cancelled = false;
    let diffEditor: editor.IStandaloneDiffEditor | null = null;
    let changeSubscription: { dispose(): void } | null = null;
    let goToLine: { dispose(): void } | null = null;
    host.dataset.monacoDiffStatus = "loading";

    void loadMonacoRuntime()
      .then((runtime: Awaited<ReturnType<typeof loadMonacoRuntime>>) => {
        if (cancelled) return;

        // DiffEditor ignores construction-time `theme`; set it explicitly.
        applyMonacoThemeForDiffEditor(runtime.monaco);

        // CONCEPT #48: keep keyboard focus in the Changes list after open —
        // Monaco focuses the modified editor on create unless we restore.
        const previouslyFocused =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;

        diffEditor = runtime.monaco.editor.createDiffEditor(
          host,
          diffEditorConstructionOptions({
            presentation: liveRef.current.presentation,
            wordWrap: liveRef.current.wordWrap,
          }),
        );
        attachDiffModels(diffEditor, {
          original: originalLease.model,
          modified: modifiedLease.model,
        });
        diffEditorRef.current = diffEditor;

        previouslyFocused?.focus();

        const modifiedEditor = diffEditor.getModifiedEditor();
        modifiedEditor.updateOptions({
          readOnly: liveRef.current.modifiedReadOnly,
          domReadOnly: liveRef.current.modifiedReadOnly,
        });
        modifiedEditor.addAction({
          id: "volli.diff.save",
          label: "Save File",
          keybindings: [runtime.monaco.KeyMod.CtrlCmd | runtime.monaco.KeyCode.KeyS],
          run: () => {
            void runSaveRef.current();
          },
        });
        // ⌃G on the side that can be edited and saved (editor/go-to-line.ts).
        goToLine = surfaceGoToLine(
          modifiedEditor,
          runtime.monaco.KeyMod.WinCtrl | runtime.monaco.KeyCode.KeyG,
        );

        const restored = modifiedLease.restoreViewState();
        const fallbackViewState = liveRef.current.initialViewState as
          | editor.ICodeEditorViewState
          | null
          | undefined;
        const viewState = restored ?? fallbackViewState ?? null;
        if (viewState !== null) modifiedEditor.restoreViewState(viewState);

        changeSubscription = modifiedLease.model.onDidChangeContent(() => {
          syncDirty();
        });
        syncDirty();
        host.dataset.monacoDiffStatus = "ready";
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        goToLine?.dispose();
        goToLine = null;
        changeSubscription?.dispose();
        changeSubscription = null;
        diffEditor?.dispose();
        diffEditor = null;
        diffEditorRef.current = null;
        host.dataset.monacoDiffStatus = "failed";
        const message = diffEditorInitFailureMessage(
          liveRef.current.ariaLabel,
          errorMessage(error),
        );
        console.error("Monaco diff editor failed", error);
        // Parent (DiffView) swaps to DiffStub — in-pane like MonacoFileEditor's
        // <pre> fallback, not an empty host under presentation chrome.
        liveRef.current.onInitFailed(message);
      });

    return () => {
      cancelled = true;
      goToLine?.dispose();
      changeSubscription?.dispose();
      diffEditorRef.current = null;
      if (diffEditor !== null) {
        const viewState = diffEditor.getModifiedEditor().saveViewState();
        diffEditor.dispose();
        liveRef.current.onViewStateChange?.(viewState);
      }
    };
  }, [originalLease, modifiedLease, syncDirty]);

  // Presentation toggle updates the same DiffEditor — never a second tab (#51).
  React.useEffect(() => {
    diffEditorRef.current?.updateOptions({
      renderSideBySide: presentation !== "inline",
      useInlineViewWhenSpaceIsLimited: false,
    });
  }, [presentation]);

  React.useEffect(() => {
    const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
    modifiedEditor?.updateOptions({
      readOnly: modifiedReadOnly,
      domReadOnly: modifiedReadOnly,
    });
  }, [modifiedReadOnly]);

  // Word wrap arrives from the band above this editor; like the presentation
  // toggle it restyles the SAME DiffEditor rather than making a second one.
  React.useEffect(() => {
    diffEditorRef.current?.updateOptions({ wordWrap: wordWrapOption(wordWrap) });
  }, [wordWrap]);

  React.useEffect(() => {
    if (emittedDirtyRef.current === dirty) return;
    emittedDirtyRef.current = dirty;
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    host.dataset.monacoDiffDirty = dirty ? "true" : "false";
    host.dataset.monacoDiffSaving = saving ? "true" : "false";
    host.dataset.monacoDiffReadOnly = modifiedReadOnly ? "true" : "false";
    host.dataset.monacoDiffPresentation = presentation;
    host.dataset.monacoDiffWordWrap = wordWrap ? "true" : "false";
  }, [dirty, saving, modifiedReadOnly, presentation, wordWrap]);

  /**
   * VC-148: a press inside the diff lands focus in it. Capture phase — Monaco
   * stops the press propagating, so a bubble-phase handler here is never called
   * for the one gesture that matters (measured against the built app with
   * `e2e/monaco-reconciliation-smoke.mjs`, whose 2c check now guards it).
   */
  const focusPressedSide = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const diffEditor = diffEditorRef.current;
    if (diffEditor === null) return;
    const original = diffEditor.getOriginalEditor();
    const modified = diffEditor.getModifiedEditor();
    const side = diffFocusTarget({
      originalDom: original.getDomNode(),
      modifiedDom: modified.getDomNode(),
      target: event.target instanceof Element ? event.target : null,
      activeElement: document.activeElement,
    });
    if (side === null) return;
    // Both halves, or neither: see {@link diffFocusTarget}. The browser's own
    // default action is what was clearing focus, so taking it is the fix.
    event.preventDefault();
    (side === "original" ? original : modified).focus();
  }, []);

  return (
    // `volli-source-mode`: same furniture stylesheet as the file editor, so a
    // diff tab and a file tab read as the same surface (editor/source-mode.css).
    <div
      ref={hostRef}
      role="group"
      aria-label={ariaLabel}
      onMouseDownCapture={focusPressedSide}
      className="volli-source-mode min-h-0 w-full flex-1 overflow-hidden"
    />
  );
}
