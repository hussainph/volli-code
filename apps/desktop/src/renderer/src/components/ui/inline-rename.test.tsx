// @vitest-environment jsdom
/**
 * The rename field's keys while an IME is composing (VC-806). Chromium on
 * macOS delivers the Enter that accepts a candidate, and the Escape that
 * closes the candidate window, as `keydown`s with `isComposing` set. Taking
 * them committed a half-converted rename, or cancelled the whole rename and
 * threw away everything typed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { InlineRename } from "./inline-rename";

let root: Root;
let host: HTMLDivElement;
const onCommit = vi.fn();
const onCancel = vi.fn();

function input(): HTMLInputElement {
  return host.querySelector("input")!;
}

function type(value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(key: "Enter" | "Escape", composing: boolean): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    isComposing: composing,
    keyCode: composing ? 229 : key === "Enter" ? 13 : 27,
  });
  act(() => {
    input().dispatchEvent(event);
  });
  return event;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onCommit.mockClear();
  onCancel.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<InlineRename value="Old" onCommit={onCommit} onCancel={onCancel} />),
  );
  type("テスト");
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("neither commits nor cancels on a composing Enter or Escape", () => {
  const enter = press("Enter", true);
  const escape = press("Escape", true);

  expect(onCommit).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  expect(enter.defaultPrevented).toBe(false);
  expect(escape.defaultPrevented).toBe(false);
  expect(input().value).toBe("テスト");
});

it("keeps a composing key inside the field, as it does every unmodified key", () => {
  // On the document, past React's root listener on `host`.
  const outside = vi.fn();
  document.addEventListener("keydown", outside);

  press("Escape", true);
  document.removeEventListener("keydown", outside);

  expect(outside).not.toHaveBeenCalled();
});

it("still commits on a plain Enter", () => {
  press("Enter", false);
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("テスト");
});

it("still cancels on a plain Escape", () => {
  press("Escape", false);
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onCommit).not.toHaveBeenCalled();
});
