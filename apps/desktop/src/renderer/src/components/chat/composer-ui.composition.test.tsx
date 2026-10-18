// @vitest-environment jsdom
/**
 * The `@`/`/` picker's keys while an IME is composing (VC-806). Chromium on
 * macOS delivers the Enter that accepts a candidate, the arrows that walk the
 * candidate list and the Escape that closes it as ordinary `keydown`s with
 * `isComposing` set. The picker runs as the textarea's external `onKeyDown`,
 * which `PromptInputTextarea` calls BEFORE its own composition guard — so the
 * picker has to stand down by itself, or `@` followed by kana picks a file row
 * with the Enter that was meant to commit the word.
 *
 * Mounted through the real `SessionComposer` so that ordering is in the path.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { IndexedFile } from "@volli/shared";

import { SessionComposer, type SessionComposerProps } from "./composer-ui";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const FILES: readonly IndexedFile[] = [
  { relPath: "src/one.ts", kind: "other", artifact: false },
  { relPath: "src/two.ts", kind: "other", artifact: false },
];

let root: Root | null = null;
let container: HTMLElement | null = null;
const onSubmit = vi.fn();

function Composer() {
  const [value, setValue] = React.useState("");
  const props: SessionComposerProps = {
    value,
    onValueChange: setValue,
    models: [],
    selection: { providerId: "", modelId: "", reasoningLevel: "" },
    onSelectionChange: () => undefined,
    working: false,
    ready: true,
    queued: [],
    onQueuedChange: () => undefined,
    onSteerQueued: () => undefined,
    onSubmit,
    onStop: () => undefined,
    files: FILES,
  };
  return <SessionComposer {...props} />;
}

function textarea(): HTMLTextAreaElement {
  return container!.querySelector("textarea")!;
}

function picker(): Element | null {
  return container!.querySelector('[data-slot="composer-picker"]');
}

async function type(value: string): Promise<void> {
  await act(async () => {
    const node = textarea();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, value);
    node.setSelectionRange(value.length, value.length);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(
  key: "Enter" | "Escape" | "ArrowDown",
  isComposing: boolean,
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", {
    key,
    isComposing,
    keyCode: isComposing ? 229 : { Enter: 13, Escape: 27, ArrowDown: 40 }[key],
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    textarea().dispatchEvent(event);
  });
  return event;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom lays nothing out; the picker's list scrolls its active row into view.
  HTMLElement.prototype.scrollIntoView = () => undefined;
  onSubmit.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Composer />));
  await type("@");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  vi.unstubAllGlobals();
});

it("opens on `@`, the precondition every case below relies on", () => {
  expect(picker()).not.toBeNull();
});

it.each(["Enter", "Escape", "ArrowDown"] as const)(
  "leaves a composing %s to the IME: no row picked, the picker still open",
  async (key) => {
    const event = await press(key, true);

    expect(event.defaultPrevented).toBe(false);
    expect(textarea().value).toBe("@");
    expect(picker()).not.toBeNull();
    // Nor does the composer's own Enter send it: PromptInput's guard holds.
    expect(onSubmit).not.toHaveBeenCalled();
  },
);

it("still picks the highlighted row on a plain Enter", async () => {
  const event = await press("Enter", false);

  expect(event.defaultPrevented).toBe(true);
  expect(textarea().value).toBe("@src/one.ts ");
  expect(onSubmit).not.toHaveBeenCalled();
});

it("still dismisses on a plain Escape", async () => {
  const escape = await press("Escape", false);

  expect(escape.defaultPrevented).toBe(true);
  expect(textarea().value).toBe("@");
  // Dismissed (the card is only animating out): the arrows are the box's again.
  expect((await press("ArrowDown", false)).defaultPrevented).toBe(false);
});
