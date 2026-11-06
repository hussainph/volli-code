// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  DocumentEditorHandover,
  MonacoDocumentEditorHandle,
  MonacoDocumentEditorProps,
} from "./monaco-document-editor";
import { DraftDocumentEditor } from "./draft-document-editor";

const state = vi.hoisted(() => ({ ready: undefined as MonacoDocumentEditorProps["onReady"] }));
vi.mock("./monaco-document-editor", () => ({
  MonacoDocumentEditor: (props: MonacoDocumentEditorProps) => {
    state.ready = props.onReady;
    return <div data-testid="rich-editor" />;
  },
}));
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let ref: React.RefObject<MonacoDocumentEditorHandle | null>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.ready = undefined;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  ref = React.createRef();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function draw(value: string, onChange: (value: string) => void = vi.fn()) {
  root.render(
    <DraftDocumentEditor
      ref={ref}
      identity={{ kind: "ticket-body", projectId: "project", ticketId: "draft" }}
      viewId="draft"
      value={value}
      onChange={onChange}
      ariaLabel="Ticket description"
    />,
  );
}
it("does not mount a rich editor on arrival; adopts the latest text and selected range only once ready", async () => {
  await act(async () => draw("Draft"));
  expect(state.ready).toBeUndefined();
  const field = host.querySelector("textarea")!;
  await act(async () => field.focus());
  expect(state.ready).toBeTypeOf("function");
  expect(field.hidden).toBe(false);
  await act(async () => draw("Draft\nλ pasted 👋"));
  field.setSelectionRange(6, 8);
  const adopt = vi.fn();
  await act(async () => state.ready?.({ adopt }));
  expect(adopt).toHaveBeenCalledWith("Draft\nλ pasted 👋", 6, 8, true);
  expect(field.hidden).toBe(true);
});
it("keeps IME live until its final input and does not steal focus from another field", async () => {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frame = fn;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  await act(async () => draw(""));
  const field = host.querySelector("textarea")!;
  await act(async () => field.focus());
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  const handover: DocumentEditorHandover = { adopt: vi.fn() };
  await act(async () => state.ready?.(handover));
  expect(field.hidden).toBe(false);
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await act(async () => draw("日本語"));
  field.setSelectionRange(3, 3);
  field.blur();
  await act(async () => frame?.(0));
  expect(handover.adopt).toHaveBeenCalledWith("日本語", 3, 3, false);
});
it("inserts a file ref at the native selection before runtime readiness without dropping the suffix", async () => {
  const change = vi.fn();
  const update = (value: string) => {
    change(value);
    draw(value, update);
  };
  await act(async () => draw("prefix suffix", update));
  const field = host.querySelector("textarea")!;
  field.setSelectionRange(6, 6);
  await act(async () => expect(ref.current?.insertAtCursor("@src/app.ts")).toBe(true));
  expect(change).toHaveBeenCalledWith("prefix @src/app.ts suffix");
  expect(field.selectionStart).toBe("prefix @src/app.ts".length);
});
