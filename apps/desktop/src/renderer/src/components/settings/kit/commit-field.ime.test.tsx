// @vitest-environment jsdom
/**
 * The commit field's keys while an IME is composing (VC-806). Chromium on
 * macOS delivers the Enter that accepts a candidate, and the Escape that
 * closes the candidate window, as `keydown`s with `isComposing` set. Taking
 * Enter blurred the field, which commits; taking Escape reverted the draft.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { CommitField, type CommitResult } from "./commit-field";

let root: Root;
let host: HTMLDivElement;
const onCommit = vi.fn(async (): Promise<CommitResult> => ({ ok: true }));

function input(): HTMLInputElement {
  return host.querySelector("input")!;
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
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<CommitField value="Old" onCommit={onCommit} />));
  act(() => input().focus());
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input(),
      "テスト",
    );
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("neither commits nor reverts on a composing Enter or Escape", () => {
  const enter = press("Enter", true);
  press("Escape", true);

  expect(enter.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(input());
  expect(onCommit).not.toHaveBeenCalled();
  expect(input().value).toBe("テスト");
});

it("still commits on a plain Enter", async () => {
  await act(async () => {
    press("Enter", false);
  });
  expect(document.activeElement).not.toBe(input());
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("テスト");
});

it("still reverts the draft on a plain Escape", () => {
  press("Escape", false);
  expect(input().value).toBe("Old");
  expect(onCommit).not.toHaveBeenCalled();
});
