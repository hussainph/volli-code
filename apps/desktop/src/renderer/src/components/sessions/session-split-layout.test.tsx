// @vitest-environment jsdom
/**
 * The terminal split draws the SHARED grip — with the terminal's own
 * floor, the sessions store's range, and a name that says "terminal".
 *
 * The grip's mechanics are proven in `split/split-view-divider.test.tsx`; what
 * this file holds is the wiring: that the terminal layout reaches that grip at
 * all, tells AT where it stands, and routes a keyboard step to the same
 * `onResize` a drag writes through — the one path every pane refits from, so a
 * key resize is a pointer resize as far as a terminal pane can tell.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@renderer/components/sessions/terminal-view", () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => <div data-testid={sessionId} />,
}));
vi.mock("@renderer/terminal/registry", () => ({ getEngine: () => undefined }));
vi.mock("@renderer/hooks/use-terminal-focus-target", () => ({
  useTerminalFocusTarget: () => null,
}));

import type { SessionTab } from "@renderer/stores/sessions";

import { SessionSplitLayout } from "./session-split-layout";

/** Every box measures 1000 × 400 — wide enough that 96px is under the 10% clamp. */
const BOX = { left: 0, top: 0, width: 1000, height: 400 };

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.getBoundingClientRect = function getRect(this: Element) {
    return { ...BOX, right: BOX.width, bottom: BOX.height, x: 0, y: 0 } as DOMRect;
  };
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

function tab(direction: "vertical" | "horizontal", ratio: number): SessionTab {
  return {
    sessionId: "left",
    title: "Shell",
    scope: { kind: "project", projectId: "project-1" },
    activePaneId: "left",
    layout: {
      kind: "split",
      id: "split-1",
      direction,
      ratio,
      first: { kind: "pane", sessionId: "left", exitCode: null },
      second: { kind: "pane", sessionId: "right", exitCode: null },
    },
  };
}

const noop = (): void => {};

function render(layoutTab: SessionTab, onResize: (splitId: string, ratio: number) => void) {
  act(() => {
    root?.render(
      <SessionSplitLayout
        ownerId="project-1"
        tab={layoutTab}
        visible
        onActivate={noop}
        onSplit={noop}
        onClose={noop}
        onResize={onResize}
      />,
    );
  });
  const grip = container?.querySelector<HTMLElement>('[role="separator"]');
  if (grip === null || grip === undefined) throw new Error("no divider rendered");
  return grip;
}

function press(grip: HTMLElement, key: string): void {
  act(() => {
    grip.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("SessionSplitLayout's divider", () => {
  it("is the shared grip, and tells AT where it stands within the store's clamp", () => {
    const grip = render(tab("vertical", 0.4), vi.fn());

    expect(grip.dataset.slot).toBe("split-view-divider");
    expect(grip.getAttribute("aria-orientation")).toBe("vertical");
    expect(grip.getAttribute("aria-label")).toBe("Resize left and right terminal panes");
    expect(grip.getAttribute("aria-valuenow")).toBe("40");
    expect(grip.getAttribute("aria-valuemin")).toBe("10");
    expect(grip.getAttribute("aria-valuemax")).toBe("90");
  });

  it("routes a keyboard step through onResize, as a drag would", () => {
    const onResize = vi.fn();
    const grip = render(tab("vertical", 0.5), onResize);

    press(grip, "ArrowRight");
    expect(onResize).toHaveBeenLastCalledWith("split-1", 0.53);
  });

  it("holds the terminal's 96px floor on the keyboard, not the surface's 240", () => {
    // A top/bottom split of a 400px box: 96px is 0.24 of it. 240px would have
    // been 0.45 here, so landing on 0.24 proves which floor the layout passed.
    const onResize = vi.fn();
    const grip = render(tab("horizontal", 0.25), onResize);

    expect(grip.getAttribute("aria-label")).toBe("Resize top and bottom terminal panes");
    press(grip, "ArrowUp");
    expect(onResize).toHaveBeenLastCalledWith("split-1", 0.24);

    onResize.mockClear();
    const atFloor = render(tab("horizontal", 0.24), onResize);
    press(atFloor, "ArrowUp");
    expect(onResize).not.toHaveBeenCalled();
  });
});
