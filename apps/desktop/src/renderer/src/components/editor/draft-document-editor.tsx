import * as React from "react";
import {
  MonacoDocumentEditor,
  type MonacoDocumentEditorHandle,
  type MonacoDocumentEditorProps,
  type DocumentEditorHandover,
} from "./monaco-document-editor";
import { refInsertion } from "@renderer/editor/file-refs";
import { cn } from "@renderer/lib/utils";

function whenIdle(callback: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(callback);
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(callback, 0);
  return () => clearTimeout(id);
}

/**
 * First focus and typing belong to a real native field. Its rich view prepares
 * behind it during idle, never from the focus/input dispatch. Adoption gets its
 * own idle turn and waits through IME's final input. Ordinary ticket/file
 * documents keep the eager document view.
 */
export const DraftDocumentEditor = React.forwardRef<
  MonacoDocumentEditorHandle,
  Omit<MonacoDocumentEditorProps, "onReady" | "savePolicy">
>(function DraftDocumentEditor(props, ref) {
  const field = React.useRef<HTMLTextAreaElement>(null);
  const editor = React.useRef<MonacoDocumentEditorHandle>(null);
  const handover = React.useRef<DocumentEditorHandover | null>(null);
  const composing = React.useRef(false);
  const compositionFrame = React.useRef(0);
  const prepareIdle = React.useRef<(() => void) | null>(null);
  const adoptIdle = React.useRef<(() => void) | null>(null);
  const [seed, setSeed] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);
  const focusOnHandover = React.useRef(false);
  const latest = React.useRef(props);
  latest.current = props;
  const complete = React.useCallback(() => {
    if (!handover.current || adoptIdle.current) return;
    adoptIdle.current = whenIdle(() => {
      adoptIdle.current = null;
      const node = field.current;
      if (!node || composing.current || compositionFrame.current) return;
      focusOnHandover.current = document.activeElement === node;
      setReady(true);
    });
  }, []);
  React.useLayoutEffect(() => {
    const node = field.current;
    if (!ready || !node) return;
    // The native buffer is authoritative until this commit. Make the rich
    // view visible before focusing it, but adopt before the frame is painted.
    handover.current?.adopt(
      node.value,
      node.selectionStart,
      node.selectionEnd,
      focusOnHandover.current,
      node.selectionDirection,
    );
  }, [ready]);
  const prepare = React.useCallback(() => {
    if (seed !== null || prepareIdle.current || handover.current) return;
    prepareIdle.current = whenIdle(() => {
      prepareIdle.current = null;
      setSeed(field.current?.value ?? latest.current.value);
    });
  }, [seed]);
  React.useEffect(
    () => () => {
      prepareIdle.current?.();
      adoptIdle.current?.();
      cancelAnimationFrame(compositionFrame.current);
    },
    [],
  );
  React.useImperativeHandle(
    ref,
    () => ({
      focus() {
        if (ready) editor.current?.focus();
        else field.current?.focus();
      },
      insertAtCursor(text) {
        if (ready) return editor.current?.insertAtCursor(text) ?? false;
        const node = field.current;
        if (!node) return false;
        const value = node.value;
        const start = node.selectionStart;
        const end = node.selectionEnd;
        const inserted = refInsertion({ precedingChar: value.slice(start - 1, start), text });
        const next = value.slice(0, start) + inserted + value.slice(end);
        // Keep the selection through React's controlled-value commit, too.
        node.value = next;
        node.setSelectionRange(start + inserted.length, start + inserted.length);
        latest.current.onChange(next);
        node.focus();
        return true;
      },
      markSaved(revision) {
        editor.current?.markSaved(revision);
      },
    }),
    [ready],
  );
  return (
    // A flex column so the Monaco host, its only in-flow child once ready,
    // shrinks with this box when a flex parent gives it less than the host's
    // content height (VC-1216: the New-ticket body yielding to the footer).
    // As a block child it kept its own height and overflowed this box instead.
    <div
      className={cn("relative flex flex-col overflow-y-auto", props.className)}
      style={props.style}
    >
      <textarea
        ref={field}
        hidden={ready}
        autoFocus={props.autoFocus}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onFocus={prepare}
        onBlur={props.onBlur}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          // Some input methods commit their final input after compositionend.
          // Keep the native field through that frame, then request idle again.
          cancelAnimationFrame(compositionFrame.current);
          compositionFrame.current = requestAnimationFrame(() => {
            compositionFrame.current = 0;
            complete();
          });
        }}
        className="block field-sizing-content w-full shrink-0 resize-none border-0 bg-transparent py-2 text-body leading-6 text-foreground outline-none placeholder:text-muted-foreground"
        style={{ minHeight: "inherit" }}
      />
      {seed !== null ? (
        <MonacoDocumentEditor
          {...props}
          // Do not reconcile every native IME update into a hidden rich view.
          // The latest buffer is adopted once, at the actual handoff.
          value={ready ? props.value : seed}
          ref={editor}
          autoFocus={false}
          savePolicy="draft"
          onReady={(value) => {
            handover.current = value;
            complete();
          }}
          className={cn(props.className, !ready && "invisible absolute inset-x-0 top-0 w-full")}
        />
      ) : null}
    </div>
  );
});
