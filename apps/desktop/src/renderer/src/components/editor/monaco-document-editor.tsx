import * as React from "react";
import type { editor } from "monaco-editor";

import { documentIdentityKey, type DocumentIdentity } from "@renderer/editor/document-identity";
import {
  attachDocumentMode,
  DOCUMENT_MODE_CLASS,
  type DocumentModeAttachment,
} from "@renderer/editor/document-mode-contribution";
import { documentModeOptions } from "@renderer/editor/document-mode";
import type { DocumentLease, DocumentRevision } from "@renderer/editor/document-registry";
import { type FileRefsConfig, refInsertion } from "@renderer/editor/file-refs";
import { loadMonacoRuntime } from "@renderer/editor/monaco-runtime";
import { cn } from "@renderer/lib/utils";

/**
 * The `@file` wiring plus an `indexVersion` counter the host bumps whenever a
 * fresh index arrives — a change to it rebuilds the chips without touching the
 * document (nothing else would, since the text is unchanged).
 */
export type DocumentFileRefs = FileRefsConfig & { indexVersion: number };

/**
 * Imperative handle for driving the editor from outside React state. The
 * New-ticket composer needs both: Enter in the title moves focus into the body,
 * and the paperclip splices a `@ref` in at the caret.
 */
export interface MonacoDocumentEditorHandle {
  focus(): void;
  /**
   * Insert `text` at the caret, replacing any selected range, then focus. A
   * space is prepended when the preceding character would swallow the ref's
   * boundary (see `refInsertion`).
   */
  insertAtCursor(text: string): void;
  /**
   * Record that the host has persisted the model's current value. Clears the
   * registry dirty flag and advances the baseline revision — the FileView
   * autosave path calls this after a successful write so close-guard never
   * sees a stuck dirty autosave document with `externalRevision === null`.
   */
  markSaved(revision: DocumentRevision): void;
}

export interface MonacoDocumentEditorProps {
  /**
   * Which logical document this is. One identity owns one Monaco model no matter
   * how many views show it — which is how the ticket body finally gets the
   * `ticket-body` identity that has existed unused since the registry landed.
   */
  identity: DocumentIdentity;
  /** Distinguishes two views of the SAME document for view-state memory. */
  viewId: string;
  /** The markdown buffer. External changes reset the doc only while unfocused. */
  value: string;
  /**
   * Disk/store revision that seeds the registry baseline. File artifacts pass
   * the on-disk mtime so a mid-edit close still has a known `expectedMtime`;
   * the ticket body leaves this `null` (no mtime to conflict-guard on).
   */
  revision?: DocumentRevision;
  /** Fired on every document edit with the full markdown string. */
  onChange(value: string): void;
  /**
   * Every dirty transition of the shared registry model. Artifact tabs feed
   * this into the workbench close-guard; the ticket body leaves it unset.
   */
  onDirtyChange?(dirty: boolean): void;
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * Classes for the editor host. Min/max height belong here and are honoured
   * (see the auto-height note on the component); PADDING does not — the host's
   * box is what the editor is laid out into, so pad with a wrapper or with the
   * editor's own inset instead.
   */
  className?: string;
  onBlur?(): void;
  /** Accessible name for the editable region. */
  ariaLabel?: string;
  /** Enables the `@file` picker + chip decorations. Absent, neither appears. */
  fileRefs?: DocumentFileRefs;
}

type DocumentMonacoLease = DocumentLease<editor.ITextModel, editor.ICodeEditorViewState>;

/**
 * The Monaco Document Mode editor — the ONE surface for the Ticket Body and
 * Markdown Artifacts (CONCEPT #49/#60). The markdown buffer IS the document:
 * syntax renders in place, its delimiters reveal where the caret sits, and every
 * edit writes ordinary markdown.
 *
 * It is a sibling of `MonacoFileEditor`, not a mode of it, because the two have
 * genuinely different save contracts and nothing else to share beyond the
 * runtime and the registry (which they DO share). `MonacoFileEditor` owns an
 * explicit ⌘S, a dirty flag the workbench guards a tab close on, and a
 * "changed on disk" banner. This one owns none of that: it is uncontrolled, it
 * reports every edit through `onChange`, and the surfaces above it — the ticket
 * body and the artifact file view — keep the debounced autosave, the baseline
 * and the conflict banner they already had. Folding both contracts into one
 * component would mean threading a policy flag through every effect, and the
 * autosave behaviour is precisely what this migration must not regress.
 *
 * Like the CodeMirror editor it replaces, it is internally uncontrolled:
 * `value` seeds the model and, on later external changes, resets it ONLY while
 * unfocused (or on blur, if the buffer was never touched), so an agent's edit or
 * a store rehydrate can never stomp the user mid-keystroke.
 *
 * ## Height
 *
 * A document grows with its text. Monaco does not do that on its own — it fills
 * whatever box it is given and scrolls inside it, which is right for a file tab
 * and wrong for a ticket body sitting in a scrolling column. So the host's
 * height tracks `getContentHeight()`, and the editor is then laid out into the
 * host's `clientHeight` rather than into that number directly: `clientHeight` is
 * the CSS-CLAMPED box, so a caller's `min-h-*` / `max-h-*` classes keep working
 * (the composer bounds its body at 40vh and scrolls inside; the ticket body has
 * a floor and no ceiling) without this component knowing anything about them.
 */
export const MonacoDocumentEditor = React.forwardRef<
  MonacoDocumentEditorHandle,
  MonacoDocumentEditorProps
>(function MonacoDocumentEditor(
  {
    identity,
    viewId,
    value,
    revision = null,
    onChange,
    onDirtyChange,
    placeholder,
    autoFocus,
    className,
    onBlur,
    ariaLabel,
    fileRefs,
  },
  ref,
) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const editorRef = React.useRef<editor.IStandaloneCodeEditor | null>(null);
  const leaseRef = React.useRef<DocumentMonacoLease | null>(null);
  const attachmentRef = React.useRef<DocumentModeAttachment | null>(null);
  const key = documentIdentityKey(identity);
  const [failure, setFailure] = React.useState<string | null>(null);

  // Latest-callback refs: the mount effect runs once per document and must never
  // close over a stale render's callbacks.
  const liveRef = React.useRef({
    identity,
    revision,
    onChange,
    onDirtyChange,
    onBlur,
    placeholder,
    ariaLabel,
    autoFocus,
  });
  liveRef.current = {
    identity,
    revision,
    onChange,
    onDirtyChange,
    onBlur,
    placeholder,
    ariaLabel,
    autoFocus,
  };
  const fileRefsRef = React.useRef(fileRefs);
  fileRefsRef.current = fileRefs;

  // The value the model is seeded from at mount, and the baseline for "has the
  // user typed since we deferred an external change?".
  const seedRef = React.useRef(value);
  const lastSyncedRef = React.useRef(value);
  // An external value that arrived while the editor was focused and so could not
  // be applied without moving the caret; adopted on blur if still untouched.
  const pendingRef = React.useRef<string | null>(null);
  // Suppress host onChange while we rewrite the model from outside — otherwise
  // discard→adopt (or any multi-step baseline swap) would briefly schedule
  // autosave against a stale intermediate baseline.
  const suppressChangeRef = React.useRef(false);
  const emittedDirtyRef = React.useRef(false);

  const emitDirty = React.useCallback((dirty: boolean) => {
    if (emittedDirtyRef.current === dirty) return;
    emittedDirtyRef.current = dirty;
    liveRef.current.onDirtyChange?.(dirty);
  }, []);

  /**
   * Replace the document with `next` in a single host-visible update. The
   * registry's `adoptCleanBaseline` refuses a dirty model, so a dirty draft is
   * first cleared via `markSaved` (keeps the current bytes as baseline — one
   * subsequent setValue from adopt) rather than `discard` (which would setValue
   * back to the old baseline first and fire a spurious onChange).
   */
  const applyExternal = React.useCallback(
    (next: string, nextRevision: DocumentRevision) => {
      const lease = leaseRef.current;
      if (lease === null) return;
      const view = editorRef.current;
      const viewState = view?.saveViewState() ?? null;
      suppressChangeRef.current = true;
      try {
        if (lease.snapshot().dirty) {
          lease.markSaved(lease.snapshot().baselineRevision);
        }
        lease.adoptCleanBaseline({ value: next, revision: nextRevision });
      } finally {
        suppressChangeRef.current = false;
      }
      if (viewState !== null) view?.restoreViewState(viewState);
      lastSyncedRef.current = next;
      pendingRef.current = null;
      emitDirty(false);
    },
    [emitDirty],
  );

  React.useImperativeHandle(
    ref,
    (): MonacoDocumentEditorHandle => ({
      focus() {
        editorRef.current?.focus();
      },
      insertAtCursor(text) {
        const view = editorRef.current;
        const lease = leaseRef.current;
        const selection = view?.getSelection() ?? null;
        if (view === null || lease === null || selection === null) return;
        const model = lease.model;
        const start = model.getOffsetAt(selection.getStartPosition());
        const precedingChar = start === 0 ? "" : model.getValue().slice(start - 1, start);
        const insert = refInsertion({ precedingChar, text });
        view.executeEdits("volli.document.insertRef", [
          { range: selection, text: insert, forceMoveMarkers: true },
        ]);
        const position = model.getPositionAt(start + insert.length);
        view.setPosition(position);
        view.revealPositionInCenterIfOutsideViewport(position);
        view.focus();
      },
      markSaved(nextRevision) {
        const lease = leaseRef.current;
        if (lease === null) return;
        lease.markSaved(nextRevision);
        lastSyncedRef.current = lease.model.getValue();
        emitDirty(false);
      },
    }),
    [emitDirty],
  );

  React.useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let cancelled = false;
    let view: editor.IStandaloneCodeEditor | null = null;
    let lease: DocumentMonacoLease | null = null;
    let attachment: DocumentModeAttachment | null = null;
    const subscriptions: { dispose(): void }[] = [];
    host.dataset.monacoStatus = "loading";

    void loadMonacoRuntime()
      .then((runtime) => {
        if (cancelled) return;
        const seed = seedRef.current;
        const seedRevision = liveRef.current.revision ?? null;
        lease = runtime.registry.acquire({
          identity: liveRef.current.identity,
          viewId,
          seed: { value: seed, revision: seedRevision },
          savePolicy: "autosave",
        });
        if (cancelled) {
          lease.release();
          lease = null;
          return;
        }
        // A mount always shows what the host handed down, exactly like the
        // CodeMirror editor did. A parked draft on this identity would otherwise
        // reappear without the host's `draftRef` knowing about it, and autosave
        // would never fire for text nobody typed this session.
        if (lease.model.getValue() !== seed) {
          suppressChangeRef.current = true;
          try {
            if (lease.snapshot().dirty) {
              lease.markSaved(lease.snapshot().baselineRevision);
            }
            lease.adoptCleanBaseline({ value: seed, revision: seedRevision });
          } finally {
            suppressChangeRef.current = false;
          }
        }
        leaseRef.current = lease;
        emittedDirtyRef.current = lease.snapshot().dirty;
        if (emittedDirtyRef.current) liveRef.current.onDirtyChange?.(true);

        view = runtime.monaco.editor.create(host, {
          ...documentModeOptions({ placeholder: liveRef.current.placeholder }),
          theme: "volli-dark",
          ariaLabel: liveRef.current.ariaLabel,
          model: lease.model,
        });
        editorRef.current = view;

        const restored = lease.restoreViewState();
        if (restored !== null) view.restoreViewState(restored);

        attachment = attachDocumentMode(
          { editor: view, model: lease.model, monaco: runtime.monaco },
          { getFileRefs: () => fileRefsRef.current },
        );
        attachmentRef.current = attachment;

        // The host owns the height; the editor is laid out into whatever CSS
        // then allows (see the component note).
        const editorView = view;
        const fitToContent = (): void => {
          host.style.height = `${editorView.getContentHeight()}px`;
          editorView.layout({ width: host.clientWidth, height: host.clientHeight });
        };
        subscriptions.push(editorView.onDidContentSizeChange(fitToContent));
        fitToContent();

        const model = lease.model;
        subscriptions.push(
          model.onDidChangeContent(() => {
            if (suppressChangeRef.current) return;
            liveRef.current.onChange(model.getValue());
            emitDirty(lease !== null && lease.snapshot().dirty);
          }),
          view.onDidBlurEditorText(() => {
            liveRef.current.onBlur?.();
            // Adopt an external value deferred while focused — but only if the
            // user hasn't typed since. If they have, the host's conflict
            // handling owns the divergence; never silently pick a side.
            const pending = pendingRef.current;
            pendingRef.current = null;
            if (pending === null) return;
            const current = model.getValue();
            if (current === lastSyncedRef.current && current !== pending) {
              applyExternal(pending, liveRef.current.revision ?? null);
            }
          }),
        );

        host.dataset.monacoStatus = "ready";
        host.dataset.monacoLanguage = lease.snapshot().language;
        // A document surface is never read-only (CONCEPT #49 gives it autosave,
        // not a policy flag), but the attribute is the shared contract the e2e
        // kit's `isMonacoEditable` reads, and a MISSING attribute reads as "not
        // editable" there rather than "not applicable".
        host.dataset.monacoReadOnly = "false";
        if (liveRef.current.autoFocus) view.focus();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        host.dataset.monacoStatus = "failed";
        console.error("Monaco document editor failed", error);
        setFailure(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
      attachment?.dispose();
      attachmentRef.current = null;
      for (const subscription of subscriptions) subscription.dispose();
      const viewState = view?.saveViewState() ?? null;
      view?.dispose();
      editorRef.current = null;
      if (lease !== null) {
        // The host flushed its autosave on unmount; leaving the model dirty
        // would park it in the registry forever (a dirty document is never
        // cleaned up), so hand the entry back clean unless another view holds it.
        if (lease.snapshot().viewReferences <= 1) lease.discard();
        lease.release(viewState);
      }
      leaseRef.current = null;
      if (emittedDirtyRef.current) {
        emittedDirtyRef.current = false;
        liveRef.current.onDirtyChange?.(false);
      }
    };
  }, [applyExternal, emitDirty, key, viewId]);

  // External value → document sync. While focused we can't move the caret, so
  // remember it and let the blur handler adopt it if the buffer is untouched.
  React.useEffect(() => {
    seedRef.current = value;
    const lease = leaseRef.current;
    if (lease === null) return; // not mounted yet; the mount effect seeds from `value`
    const current = lease.model.getValue();
    if (editorRef.current?.hasTextFocus() === true) {
      if (current !== value) pendingRef.current = value;
      return;
    }
    if (current === value) {
      lastSyncedRef.current = value;
      // Bytes match; still advance the revision when the host learned a fresher
      // mtime (echo of our own autosave, or a bare touch).
      if (!Object.is(lease.snapshot().externalRevision, revision)) {
        lease.adoptCleanBaseline({ value, revision });
      }
      return;
    }
    applyExternal(value, revision);
  }, [applyExternal, revision, value]);

  // A fresh index can change which `@` refs resolve without the document
  // changing at all. Keyed on the version alone: depending on the whole
  // `fileRefs` object would refire on any callback identity churn.
  React.useEffect(() => {
    attachmentRef.current?.refresh();
  }, [fileRefs?.indexVersion]);

  React.useEffect(() => {
    editorRef.current?.updateOptions({ ariaLabel });
  }, [ariaLabel]);

  if (failure !== null) {
    return (
      <pre
        data-monaco-fallback="true"
        aria-label={ariaLabel}
        title={`Monaco unavailable: ${failure}`}
        className={cn("h-full overflow-auto whitespace-pre-wrap font-mono text-ui", className)}
      >
        {value}
      </pre>
    );
  }

  return <div ref={hostRef} className={cn(DOCUMENT_MODE_CLASS, className)} />;
});
