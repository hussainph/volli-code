import * as React from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";

import { markdownFormatKeymap, markdownLivePreview } from "./live-preview";

export interface MarkdownLiveEditorProps {
  /** The markdown buffer. External changes reset the doc only while unfocused. */
  value: string;
  /** Fired on every document edit with the full markdown string. */
  onChange(value: string): void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  onBlur?(): void;
  /** Accessible name for the editable region. */
  ariaLabel?: string;
}

/**
 * An always-mounted CodeMirror 6 markdown editor with Obsidian-style live
 * preview (see live-preview.ts). The markdown buffer IS the document — there is
 * no separate rendered/edit mode; syntax renders in place and its delimiters
 * reveal only where the caret sits.
 *
 * The editor is internally uncontrolled: `value` seeds the initial doc and, on
 * later external changes, resets the doc ONLY while the editor is unfocused, so
 * a background refresh (an agent editing the same file, a store rehydrate)
 * never stomps the user mid-keystroke.
 */
export function MarkdownLiveEditor({
  value,
  onChange,
  placeholder,
  autoFocus,
  className,
  onBlur,
  ariaLabel,
}: MarkdownLiveEditorProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const viewRef = React.useRef<EditorView | null>(null);

  // Latest-callback refs so the one-shot mount effect never goes stale.
  const onChangeRef = React.useRef(onChange);
  const onBlurRef = React.useRef(onBlur);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  React.useEffect(() => {
    onBlurRef.current = onBlur;
  }, [onBlur]);

  // Seed the initial doc without making `value` a dependency of the mount
  // effect (later changes flow through the sync effect below).
  const initialDocRef = React.useRef(value);
  const placeholderRef = React.useRef(placeholder ?? "");
  const ariaLabelRef = React.useRef(ariaLabel ?? "");

  // An external `value` change that arrived while the editor was focused and so
  // could not be applied without stomping the caret; adopted on blur if the
  // buffer is still untouched (see the sync effect and blur handler below).
  const pendingValueRef = React.useRef<string | null>(null);
  // The last value we programmatically wrote into the doc — the baseline for
  // "did the user type since we deferred?": buffer === this ⇒ untouched.
  const lastSyncedRef = React.useRef(value);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = EditorState.create({
      doc: initialDocRef.current,
      extensions: [
        history(),
        keymap.of([...markdownFormatKeymap, ...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        markdownLivePreview(),
        cmPlaceholder(placeholderRef.current),
        EditorView.contentAttributes.of({ "aria-label": ariaLabelRef.current }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          blur: () => {
            onBlurRef.current?.();
            // Adopt an external value that was deferred while focused — but only
            // if the user hasn't edited the buffer since (buffer still equals the
            // last value we synced). If they typed, leave the buffer: the host's
            // conflict handling owns the divergence.
            const pending = pendingValueRef.current;
            pendingValueRef.current = null;
            if (pending !== null) {
              const current = viewRef.current?.state.doc.toString();
              if (
                current !== undefined &&
                current === lastSyncedRef.current &&
                current !== pending
              ) {
                viewRef.current?.dispatch({
                  changes: { from: 0, to: current.length, insert: pending },
                });
                lastSyncedRef.current = pending;
              }
            }
            return false;
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    if (autoFocus) view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount once; `value`/callbacks are handled via refs and the sync effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value → doc sync. While focused we can't stomp the caret, so we
  // remember the pending value and the blur handler adopts it if the buffer is
  // still untouched; while unfocused we apply it immediately.
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (view.hasFocus) {
      if (current !== value) pendingValueRef.current = value;
      return;
    }
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    lastSyncedRef.current = value;
    pendingValueRef.current = null;
  }, [value]);

  return <div ref={hostRef} className={className} />;
}
