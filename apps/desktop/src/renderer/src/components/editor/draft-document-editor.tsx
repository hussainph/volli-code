import * as React from "react";
import {
  MonacoDocumentEditor,
  type MonacoDocumentEditorHandle,
  type MonacoDocumentEditorProps,
  type DocumentEditorHandover,
} from "./monaco-document-editor";
import { refInsertion } from "@renderer/editor/file-refs";
import { cn } from "@renderer/lib/utils";

/**
 * A transient draft arrives as an immediately editable native field. Focus
 * prepares the rich view, but the field remains live until that view is ready;
 * typing, paste and IME never wait on a runtime import or a DOM font read.
 * Ticket/file documents keep the ordinary eager document view.
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
  React.useEffect(() => () => cancelAnimationFrame(compositionFrame.current), []);
  const focusOnHandover = React.useRef(false);
  const [activated, setActivated] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const latest = React.useRef(props);
  latest.current = props;
  const complete = React.useCallback(() => {
    if (!handover.current || composing.current) return;
    focusOnHandover.current = document.activeElement === field.current;
    setReady(true);
  }, []);
  React.useLayoutEffect(() => {
    if (!ready) return;
    const node = field.current;
    handover.current?.adopt(
      latest.current.value,
      node?.selectionStart ?? 0,
      node?.selectionEnd ?? 0,
      focusOnHandover.current,
    );
  }, [ready]);
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
        const value = latest.current.value;
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
    <div className={cn("relative overflow-y-auto", props.className)} style={props.style}>
      <textarea
        ref={field}
        hidden={ready}
        autoFocus={props.autoFocus}
        aria-label={props.ariaLabel}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onFocus={() => setActivated(true)}
        onBlur={props.onBlur}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          // The final input can follow compositionend; keep the field alive
          // through that dispatch before adopting its committed controlled text.
          compositionFrame.current = requestAnimationFrame(complete);
        }}
        className="block field-sizing-content w-full resize-none border-0 bg-transparent py-2 text-body leading-6 text-foreground outline-none placeholder:text-muted-foreground"
        style={{ minHeight: "inherit" }}
      />
      {activated ? (
        <MonacoDocumentEditor
          {...props}
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
