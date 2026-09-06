// @vitest-environment jsdom
/**
 * What an empty pane offers, and what it deliberately does not say.
 *
 * The rows are asserted by ROLE and NAME rather than by markup: they are the
 * same four verbs the chords beside them run, and an accessible name that
 * swallowed its own shortcut hint ("New chat ⌘T") would be the failure nobody
 * looking at the screen could see.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PaneEmptyState } from "./pane-empty-state";

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

function render(handlers: Partial<React.ComponentProps<typeof PaneEmptyState>> = {}): void {
  act(() => {
    root?.render(
      <PaneEmptyState
        onNewChat={vi.fn()}
        onNewTerminal={vi.fn()}
        onOpenFile={vi.fn()}
        onClosePane={vi.fn()}
        {...handlers}
      />,
    );
  });
}

function rows(): HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll("button") ?? []);
}

describe("PaneEmptyState", () => {
  it("offers the four verbs, in the order the surface answers them", () => {
    render();

    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "New chat",
      "New terminal",
      "Open file…",
      "Close pane",
    ]);
  });

  it("names each row without its chord, and says the chord separately", () => {
    render();

    const [chat] = rows();
    // The hint is visible…
    expect(chat?.textContent).toContain("⌘T");
    // …and it is not part of what the row is called.
    expect(chat?.getAttribute("aria-label")).toBe("New chat");
    expect(chat?.getAttribute("aria-keyshortcuts")).toBe("Meta+T");
  });

  it("gives Close pane no chord, because there is none", () => {
    render();

    const close = rows().at(-1);
    expect(close?.getAttribute("aria-keyshortcuts")).toBeNull();
    expect(close?.textContent).toBe("Close pane");
  });

  it("runs the surface's own callbacks", () => {
    const onNewChat = vi.fn();
    const onNewTerminal = vi.fn();
    const onOpenFile = vi.fn();
    const onClosePane = vi.fn();
    render({ onNewChat, onNewTerminal, onOpenFile, onClosePane });

    for (const row of rows()) {
      act(() => {
        row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }

    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onNewTerminal).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onClosePane).toHaveBeenCalledTimes(1);
  });

  it("says nothing else at all — no heading, no prose", () => {
    render();

    // CLAUDE.md: let controls talk. The only text on this surface is the four
    // labels and their three chords.
    expect(container?.textContent).toBe("New chat⌘TNew terminal⌥⌘TOpen file…⌘PClose pane");
  });
});
