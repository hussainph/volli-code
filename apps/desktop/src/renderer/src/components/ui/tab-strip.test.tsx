// @vitest-environment jsdom
/**
 * The strip's arrangement gesture (VC-189): that a tab can be picked up and put
 * down FROM THE KEYBOARD, that the permanent first tab is not part of it, and
 * that Enter still selects.
 *
 * A real jsdom environment rather than the SSR markup the strips' other tests
 * use: dnd-kit is all sensors, document listeners and measured rectangles, and
 * none of that exists in a string of HTML. jsdom measures nothing on its own,
 * so `getBoundingClientRect` is stubbed to lay the tabs out in a row — the one
 * fact the keyboard sensor needs to know which tab is to the right.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Tab, TabStrip } from "./tab-strip";

const TAB_WIDTH = 100;

let container: HTMLElement | null = null;
let root: Root | null = null;
const nativeRect = Element.prototype.getBoundingClientRect;

/** Lay the strip out: the tablist spans a row, each tab takes the next 100px. */
function layout(element: Element): DOMRect {
  const role = element.getAttribute("role");
  const box =
    role === "tab"
      ? { left: indexOfTab(element) * TAB_WIDTH, width: TAB_WIDTH }
      : { left: 0, width: 1000 };
  return {
    x: box.left,
    y: 0,
    left: box.left,
    top: 0,
    right: box.left + box.width,
    bottom: 28,
    width: box.width,
    height: 28,
    toJSON: () => ({}),
  } as DOMRect;
}

function indexOfTab(element: Element): number {
  const siblings = Array.from(element.parentElement?.children ?? []);
  return Math.max(siblings.indexOf(element), 0);
}

function press(target: Element, code: string, key: string): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true }),
    );
  });
}

/**
 * Let dnd-kit measure. Droppable rects are taken in an animation frame after a
 * drag starts, and until they exist an arrow key has no tab to move toward.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function tabsInStrip(): HTMLElement[] {
  return Array.from(container?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
}

/** Board (permanent, no `dragId`) + two movable tabs, in one arranging strip. */
function renderStrip(onReorder: (movedId: string, ids: readonly string[]) => void): void {
  const ids = ["chat:c1", "file:app.ts"];
  act(() => {
    root?.render(
      <TabStrip label="Home tabs" reorder={{ ids, onReorder }}>
        <Tab label="Board" active={false} tabStop={false} closable={false} onActivate={() => {}} />
        <Tab label="Chat" dragId="chat:c1" active tabStop closable={false} onActivate={() => {}} />
        <Tab
          label="app.ts"
          dragId="file:app.ts"
          active={false}
          tabStop={false}
          closable={false}
          onActivate={() => {}}
        />
      </TabStrip>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom implements no media queries at all, and a sortable tab asks about
  // reduced motion. "Not reduced" is the case that animates, so it is the one
  // worth rendering under.
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Element.prototype.getBoundingClientRect = function getRect(this: Element) {
    return layout(this);
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  Element.prototype.getBoundingClientRect = nativeRect;
  vi.unstubAllGlobals();
});

describe("TabStrip arrangement", () => {
  it("reorders from the keyboard: Space picks a tab up, an arrow moves it, Space drops it", async () => {
    const onReorder = vi.fn();
    renderStrip(onReorder);
    const [, chat] = tabsInStrip();
    chat?.focus();

    press(chat!, "Space", " ");
    await settle();
    press(chat!, "ArrowRight", "ArrowRight");
    await settle();
    press(chat!, "Space", " ");

    expect(onReorder).toHaveBeenCalledWith("chat:c1", ["file:app.ts", "chat:c1"]);
  });

  it("keeps the tab under the keyboard while it is being carried", () => {
    // The strip's own roving focus stands down mid-drag; an arrow moves the
    // TAB, not the focus, or the drag would be left behind on another tab.
    const onReorder = vi.fn();
    renderStrip(onReorder);
    const [, chat] = tabsInStrip();
    chat?.focus();

    press(chat!, "Space", " ");
    press(chat!, "ArrowRight", "ArrowRight");

    expect(document.activeElement).toBe(chat);
    press(chat!, "Escape", "Escape");
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("does not make the permanent first tab draggable", () => {
    const onReorder = vi.fn();
    renderStrip(onReorder);
    const [board, chat] = tabsInStrip();

    // dnd-kit points a draggable at its own hidden instructions; the Board tab
    // is registered with nothing, so it has none — and Space on it is still
    // the activation every other fixed tab gets.
    expect(board?.getAttribute("aria-describedby")).toBeNull();
    expect(chat?.getAttribute("aria-describedby")).not.toBeNull();
    expect(board?.getAttribute("role")).toBe("tab");
  });

  it("leaves Enter as the activation on a tab that drags", () => {
    const onReorder = vi.fn();
    const onActivate = vi.fn();
    act(() => {
      root?.render(
        <TabStrip label="Home tabs" reorder={{ ids: ["chat:c1"], onReorder }}>
          <Tab
            label="Chat"
            dragId="chat:c1"
            active
            tabStop
            closable={false}
            onActivate={onActivate}
          />
        </TabStrip>,
      );
    });
    const [chat] = tabsInStrip();
    chat?.focus();

    press(chat!, "Enter", "Enter");

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onReorder).not.toHaveBeenCalled();
  });
});
