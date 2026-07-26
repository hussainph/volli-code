/**
 * Monaco DiffEditor host (CONCEPT #48/#51, issue #109).
 *
 * Owns `createDiffEditor` lifecycle and model attachment. Original is always
 * read-only; modified may be editable and shares the same registry model as the
 * ticket file tab for that path. React never parses hunks — Monaco computes the
 * diff. Theme is applied via `monaco.editor.setTheme`, never construction options
 * (docs/plans/theming-engine.md).
 */
import * as React from "react";
import type { editor } from "monaco-editor";
import { errorMessage } from "@volli/shared";

import {
  planExplicitSave,
  saveFailureMessage,
  type MonacoFileSaveResult,
} from "@renderer/components/editor/monaco-file-editor";
import type { DocumentLease } from "@renderer/editor/document-registry";
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
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
 * `monaco.editor.setTheme` after create (theming-engine.md).
 */
export function diffEditorConstructionOptions(input: {
  presentation: DiffPresentation;
}): editor.IDiffEditorConstructionOptions {
  return {
    automaticLayout: true,
    renderSideBySide: input.presentation !== "inline",
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
export function releaseDiffLeases(pair: DiffLeasePair): void {
  pair.original.release();
  pair.modified.release();
}

export interface MonacoDiffEditorProps {
  /** Registry lease for the immutable base side (`diff-base` identity). */
  originalLease: MonacoLease;
  /** Registry lease for the live modified side (ticket `file` identity). */
  modifiedLease: MonacoLease;
  presentation: DiffPresentation;
  /** Modified side editable? Deleted / stub paths pass false. */
  modifiedReadOnly: boolean;
  ariaLabel: string;
  /** Explicit ⌘S for the modified side when editable (CONCEPT #49). */
  onSave(text: string): Promise<MonacoFileSaveResult>;
  onDirtyChange?(dirty: boolean): void;
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
  modifiedReadOnly,
  ariaLabel,
  onSave,
  onDirtyChange,
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
  });
  liveRef.current = { modifiedReadOnly, ariaLabel, onSave, presentation };

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
    host.dataset.monacoDiffStatus = "loading";

    void loadMonacoRuntime()
      .then((runtime: Awaited<ReturnType<typeof loadMonacoRuntime>>) => {
        if (cancelled) return;

        // DiffEditor ignores construction-time `theme`; set it explicitly.
        runtime.monaco.editor.setTheme("volli-dark");

        // CONCEPT #48: keep keyboard focus in the Changes list after open —
        // Monaco focuses the modified editor on create unless we restore.
        const previouslyFocused =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;

        diffEditor = runtime.monaco.editor.createDiffEditor(
          host,
          diffEditorConstructionOptions({ presentation: liveRef.current.presentation }),
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

        changeSubscription = modifiedLease.model.onDidChangeContent(() => {
          syncDirty();
        });
        syncDirty();
        host.dataset.monacoDiffStatus = "ready";
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        changeSubscription?.dispose();
        changeSubscription = null;
        diffEditor?.dispose();
        diffEditor = null;
        diffEditorRef.current = null;
        host.dataset.monacoDiffStatus = "failed";
        console.error("Monaco diff editor failed", error);
      });

    return () => {
      cancelled = true;
      changeSubscription?.dispose();
      diffEditorRef.current = null;
      diffEditor?.dispose();
    };
  }, [originalLease, modifiedLease, syncDirty]);

  // Presentation toggle updates the same DiffEditor — never a second tab (#51).
  React.useEffect(() => {
    diffEditorRef.current?.updateOptions({
      renderSideBySide: presentation !== "inline",
    });
  }, [presentation]);

  React.useEffect(() => {
    const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
    modifiedEditor?.updateOptions({
      readOnly: modifiedReadOnly,
      domReadOnly: modifiedReadOnly,
    });
  }, [modifiedReadOnly]);

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
  }, [dirty, saving, modifiedReadOnly, presentation]);

  return <div ref={hostRef} className="min-h-0 w-full flex-1 overflow-hidden" />;
}
