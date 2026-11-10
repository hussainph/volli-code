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

const state = vi.hoisted(() => ({
  props: undefined as MonacoDocumentEditorProps | undefined,
  focus: vi.fn(),
  insert: vi.fn(() => true),
  saved: vi.fn(),
}));
vi.mock("./monaco-document-editor", () => ({
  MonacoDocumentEditor: (
    props: MonacoDocumentEditorProps & { ref: React.Ref<MonacoDocumentEditorHandle> },
  ) => {
    state.props = props;
    React.useImperativeHandle(props.ref, () => ({
      focus: state.focus,
      insertAtCursor: state.insert,
      markSaved: state.saved,
    }));
    return <div data-testid="rich-editor" className={props.className} />;
  },
}));
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let ref: React.RefObject<MonacoDocumentEditorHandle | null>;
let idle: Map<number, IdleRequestCallback>;
let frames: Map<number, FrameRequestCallback>;
let serial: number;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.props = undefined;
  vi.clearAllMocks();
  idle = new Map();
  frames = new Map();
  serial = 0;
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    idle.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal("cancelIdleCallback", (id: number) => idle.delete(id));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  ref = React.createRef();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
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
async function nextIdle() {
  const [id, callback] = idle.entries().next().value!;
  idle.delete(id);
  await act(async () => callback({ didTimeout: false, timeRemaining: () => 8 }));
}
async function nextFrame() {
  const callbacks = [...frames];
  frames.clear();
  await act(async () => callbacks.forEach(([, callback]) => callback(0)));
}
function input(field: HTMLTextAreaElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
const updatePreparedDraft = (value: string) => draw(value, updatePreparedDraft);

it("first focus and typing stay native; preparation and latest backward selection adoption each wait for idle", async () => {
  await act(async () => draw("Draft", updatePreparedDraft));
  const field = host.querySelector("textarea")!;
  expect(state.props).toBeUndefined();
  await act(async () => field.focus());
  await act(async () => input(field, "Draft\nλ pasted 👋"));
  expect(field.value).toBe("Draft\nλ pasted 👋");
  expect(document.activeElement).toBe(field);
  expect(field.hidden).toBe(false);
  expect(state.props).toBeUndefined();
  expect(idle.size).toBe(1);
  await nextIdle();
  expect(state.props?.value).toBe(field.value);
  const seed = state.props?.value;
  const adopt = vi.fn(() => expect(field.hidden).toBe(true));
  await act(async () => state.props?.onReady?.({ adopt }));
  expect(adopt).not.toHaveBeenCalled();
  await act(async () => input(field, "Draft\nλ pasted 👋 and typed"));
  expect(state.props?.value).toBe(seed);
  field.setSelectionRange(6, 17, "backward");
  await nextIdle();
  expect(adopt).toHaveBeenCalledExactlyOnceWith(
    "Draft\nλ pasted 👋 and typed",
    6,
    17,
    true,
    "backward",
  );
  expect(state.props?.value).toBe(field.value);
});
const updateComposingDraft = (value: string) => draw(value, updateComposingDraft);

it("keeps IME live through compositionend, final input and its next frame without stealing focus", async () => {
  await act(async () => draw("", updateComposingDraft));
  const field = host.querySelector("textarea")!;
  await act(async () => field.focus());
  await nextIdle();
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await act(async () => input(field, "にほん"));
  const handover: DocumentEditorHandover = { adopt: vi.fn() };
  await act(async () => state.props?.onReady?.(handover));
  await nextIdle();
  expect(field.hidden).toBe(false);
  expect(handover.adopt).not.toHaveBeenCalled();
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await act(async () => input(field, "日本語 👋"));
  field.setSelectionRange(6, 6);
  expect(idle.size).toBe(0);
  await nextFrame();
  expect(field.hidden).toBe(false);
  field.blur();
  await nextIdle();
  expect(handover.adopt).toHaveBeenCalledExactlyOnceWith("日本語 👋", 6, 6, false, "none");
});

it("a new composition starting before adoption retains the native field", async () => {
  await act(async () => draw("日本語"));
  const field = host.querySelector("textarea")!;
  await act(async () => field.focus());
  await nextIdle();
  const adopt = vi.fn();
  await act(async () => state.props?.onReady?.({ adopt }));
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await nextIdle();
  expect(adopt).not.toHaveBeenCalled();
  expect(field.hidden).toBe(false);
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await nextFrame();
  await nextIdle();
  expect(adopt).toHaveBeenCalledOnce();
});

it("inserts a ref at the native selection without dropping the suffix; delegates only after adoption", async () => {
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
  expect(state.insert).not.toHaveBeenCalled();
  await nextIdle();
  await act(async () => state.props?.onReady?.({ adopt: vi.fn() }));
  await nextIdle();
  act(() => {
    ref.current?.focus();
    ref.current?.insertAtCursor("@next.md");
    ref.current?.markSaved(2);
  });
  expect(state.focus).toHaveBeenCalledOnce();
  expect(state.insert).toHaveBeenCalledWith("@next.md");
  expect(state.saved).toHaveBeenCalledWith(2);
});

it.each(["prepare", "adopt", "composition"])(
  "cancels pending %s work when the draft closes",
  async (phase) => {
    await act(async () => draw(""));
    const field = host.querySelector("textarea")!;
    await act(async () => field.focus());
    if (phase !== "prepare") {
      await nextIdle();
      if (phase === "composition") {
        field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      } else {
        await act(async () => state.props?.onReady?.({ adopt: vi.fn() }));
      }
    }
    await act(async () => root.unmount());
    expect(idle.size).toBe(0);
    expect(frames.size).toBe(0);
  },
);

it("uses a cancellable next-task fallback when the browser has no idle API", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", undefined);
  await act(async () => draw("Fallback"));
  await act(async () => host.querySelector("textarea")?.focus());
  host.querySelector("textarea")!.setSelectionRange(4, 4);
  expect(state.props).toBeUndefined();
  await act(async () => vi.runOnlyPendingTimers());
  expect(state.props?.value).toBe("Fallback");
  const adopt = vi.fn();
  await act(async () => state.props?.onReady?.({ adopt }));
  expect(adopt).not.toHaveBeenCalled();
  await act(async () => vi.runOnlyPendingTimers());
  expect(adopt).toHaveBeenCalledWith("Fallback", 4, 4, true, "none");
});
