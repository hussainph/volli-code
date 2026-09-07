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

/** Every fake `ResizeObserver` a render made, so a test can fire one. */
let observers: { notify(): void }[] = [];

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
  // …and no `ResizeObserver` either, which the strip installs to know whether
  // its tabs overflow. Handing the callback back to the test is the seam: what
  // is worth pinning is what the strip DOES with a new measurement.
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {
        observers.push(this as unknown as { notify(): void });
      }
      observe(): void {}
      // dnd-kit measures with one of these too, and it unobserves as a node
      // detaches; a fake missing the method throws inside React's ref cleanup.
      unobserve(): void {}
      disconnect(): void {}
      notify(): void {
        this.callback();
      }
    },
  );
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

  it("takes transform out of a tab's transition under reduced motion", () => {
    // The sortable asks dnd-kit for no transition under the flag, but that only
    // clears the INLINE one: whatever the tab's own class list transitions is
    // what would animate the sibling shift instead. jsdom applies no
    // stylesheet, so the class list is where this is checkable at all — and it
    // is the half that was silently re-supplying the motion.
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderStrip(vi.fn());
    const [, chat] = tabsInStrip();
    const transitions = (chat?.className ?? "")
      .split(" ")
      .filter((name) => name.includes("transition-["));

    expect(transitions.at(-1)).toBe("motion-reduce:transition-[color,background-color,box-shadow]");
    expect(transitions.at(-1)).not.toContain("transform");
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

/* ------------------------------------------- reaching a tab that is clipped */

/** The scroller, with the geometry jsdom has none of. */
function scroller(): HTMLElement {
  const found = container?.querySelector<HTMLElement>('[data-slot="tab-scroll"]');
  if (found === null || found === undefined) throw new Error("no scroller");
  return found;
}

/** A 300px window over `count` tabs of 100px each, parked at `scrollLeft`. */
function measureScroller(count: number, scrollLeft = 0): HTMLElement {
  const element = scroller();
  let left = scrollLeft;
  Object.defineProperty(element, "clientWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(element, "scrollWidth", { configurable: true, get: () => count * 100 });
  Object.defineProperty(element, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (next: number) => {
      left = next;
    },
  });
  // The gliding path, spelled rather than left to jsdom: whether it implements
  // `scrollTo` is not this test's subject, and the strip prefers it whenever
  // the reader has not asked for reduced motion.
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: (options: ScrollToOptions) => {
      left = options.left ?? left;
    },
  });
  return element;
}

/** A plain strip of `count` tabs, the `active`th one selected. */
function renderTabs(count: number, active: number): void {
  act(() => {
    root?.render(
      <TabStrip label="Home tabs">
        {Array.from({ length: count }, (_, index) => (
          <Tab
            key={index}
            label={`Tab ${index}`}
            active={index === active}
            tabStop={index === active}
            closable={false}
            onActivate={() => {}}
          />
        ))}
      </TabStrip>,
    );
  });
}

function affordance(towards: "Earlier" | "Later"): HTMLButtonElement | null {
  return (
    container?.querySelector<HTMLButtonElement>(`[aria-label="${towards} tabs"]`) ?? null
  );
}

/**
 * VC-288. A strip narrower than its tabs hid them behind one undiscoverable
 * gesture — Shift+wheel — and nothing else: no pointer affordance, and no way
 * at all from a keyboard. It could also leave the SELECTED tab out of view and
 * simply stay there, which at a split pane's width is most of the time.
 */
describe("TabStrip overflow", () => {
  it("brings the selected tab into view when the selection lands on a clipped one", () => {
    renderTabs(9, 0);
    const port = measureScroller(9);
    // Tab 7 sits at 700px in a 300px window: without this it is simply not on
    // screen, and nothing about the strip says it exists.
    renderTabs(9, 7);
    expect(port.scrollLeft).toBe(700 + 100 + 8 - 300);
  });

  it("follows the keyboard onto a tab the arrows walked out of view", () => {
    renderTabs(9, 0);
    const port = measureScroller(9);
    const tabs = tabsInStrip();
    tabs[0]?.focus();

    // ArrowLeft from the first tab wraps to the last, which is the furthest
    // out of view a single keystroke can put focus.
    press(tabs[0]!, "ArrowLeft", "ArrowLeft");

    expect(document.activeElement).toBe(tabs[8]);
    expect(port.scrollLeft).toBe(600);
  });

  it("leaves the strip where it is when the tab is already whole in view", () => {
    renderTabs(9, 0);
    const port = measureScroller(9, 120);
    const tabs = tabsInStrip();
    tabs[1]?.focus();
    // Tab 1 spans 100-200 inside a window showing 120-420. Writing anything
    // here would fight a person mid-drag of the strip.
    expect(port.scrollLeft).toBe(120);
  });

  it("offers a pointer a way to the tabs it cannot see, and only while there are some", () => {
    renderTabs(9, 0);
    const port = measureScroller(9);
    act(() => observers[0]?.notify());

    const later = affordance("Later");
    expect(later).not.toBeNull();
    // Nothing to the left yet, so that end says so rather than pretending.
    expect(affordance("Earlier")?.disabled).toBe(true);
    expect(later?.disabled).toBe(false);

    act(() => later?.click());
    // Four fifths of a window, so one tab of the last view stays in this one.
    expect(port.scrollLeft).toBe(240);
  });

  it("draws no affordance at all for a strip that fits", () => {
    renderTabs(2, 0);
    measureScroller(2);
    act(() => observers[0]?.notify());

    expect(affordance("Earlier")).toBeNull();
    expect(affordance("Later")).toBeNull();
  });

  it("keeps the affordances out of the tablist they scroll", () => {
    // They are controls ON the tabs, not tabs: inside `role="tablist"` they
    // would join the roving tabindex and be counted by every arrow key.
    renderTabs(9, 0);
    measureScroller(9);
    act(() => observers[0]?.notify());

    const tablist = container?.querySelector('[role="tablist"]');
    expect(tablist?.contains(affordance("Later"))).toBe(false);
    expect(affordance("Later")?.tabIndex).toBe(0);
  });

  it("keeps a hint that a narrow strip stops drawing in the tab's own name", () => {
    // The hint is what tells `src/app.ts` from `docs/app.ts`. It gives way by
    // the STRIP's width rather than the window's (`@container/tab-strip`), so
    // the word it collapses has to survive somewhere: the accessible name.
    act(() => {
      root?.render(
        <TabStrip label="Home tabs">
          <Tab label="app.ts" hint="src" active tabStop closable={false} onActivate={() => {}} />
        </TabStrip>,
      );
    });
    const [tab] = tabsInStrip();
    expect(tab?.getAttribute("aria-label")).toBe("app.ts · src");
    expect(container?.querySelector('[data-testid="tab-hint"]')?.className).toContain("@min-[");
  });
});
