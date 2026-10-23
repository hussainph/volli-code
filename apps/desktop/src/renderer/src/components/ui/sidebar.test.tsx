// @vitest-environment jsdom
/**
 * The left-sidebar chord is ⌘B and only ⌘B (VC-808). The provider's listener
 * sits on the window in the bubble phase with no target guard, so every key
 * that matches it is taken from whatever had focus. On macOS ⌃B is the system
 * "move back one character" binding in every text field: accepting Ctrl here
 * swallowed the caret move and flipped the persisted sidebar pin instead.
 *
 * ⌘B keeps working from a focused field on purpose — it inserts nothing, so
 * there is no text-editing meaning for it to steal.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarProvider } from "./sidebar";

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function renderProvider(field?: "textarea" | "input") {
  const onOpenChange = vi.fn();
  act(() => {
    root?.render(
      <SidebarProvider open onOpenChange={onOpenChange}>
        {field === "textarea" ? <textarea data-testid="field" /> : null}
        {field === "input" ? <input data-testid="field" /> : null}
      </SidebarProvider>,
    );
  });
  const target = container?.querySelector<HTMLElement>("[data-testid=field]") ?? null;
  target?.focus();
  return { onOpenChange, target };
}

function pressB(target: EventTarget, modifiers: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "b",
    code: "KeyB",
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("SidebarProvider ⌘B listener", () => {
  it("leaves ⌃B in a focused textarea alone: no toggle, caret move not cancelled", () => {
    const { onOpenChange, target } = renderProvider("textarea");
    expect(document.activeElement).toBe(target);

    const event = pressB(target!, { ctrlKey: true });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves ⌃B in a focused input alone", () => {
    const { onOpenChange, target } = renderProvider("input");

    const event = pressB(target!, { ctrlKey: true });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("toggles on ⌘B outside any field", () => {
    const { onOpenChange } = renderProvider();

    const event = pressB(window, { metaKey: true });

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it("toggles on ⌘B from a focused input", () => {
    const { onOpenChange, target } = renderProvider("input");

    pressB(target!, { metaKey: true });

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not take ⌃⌘B or ⌥⌘B", () => {
    const { onOpenChange } = renderProvider();

    pressB(window, { metaKey: true, ctrlKey: true });
    pressB(window, { metaKey: true, altKey: true });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("toggles once for a held ⌘B", () => {
    const { onOpenChange } = renderProvider();

    const repeat = pressB(window, { metaKey: true, repeat: true });

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(repeat.defaultPrevented).toBe(true);
  });
});
