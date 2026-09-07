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
  // A DOMRect is viewport-relative. Tabs move left as their scrollport moves;
  // `revealTab` then reconstructs the content-relative offset from this rect.
  // Leaving scrollLeft out here makes a partly clipped tab look fully visible
  // and lets the test pass while asserting the opposite of browser geometry.
  const scrollLeft = element.closest<HTMLElement>('[data-slot="tab-scroll"]')?.scrollLeft ?? 0;
  const box =
    role === "tab"
      ? { left: indexOfTab(element) * TAB_WIDTH - scrollLeft, width: TAB_WIDTH }
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

/** The box the tabs have to fit — the chevrons live inside it. */
function scrollArea(): HTMLElement {
  const found = container?.querySelector<HTMLElement>('[data-slot="tab-scroll-area"]');
  if (found === null || found === undefined) throw new Error("no scroll area");
  return found;
}

/** How much width one mounted chevron takes out of the scroller. */
const AFFORDANCE_WIDTH = 28;

/**
 * The strip's geometry, INCLUDING the part that made the first attempt wrong:
 * a chevron takes width out of the scroller, so the scroller's `clientWidth`
 * has to be a function of how many are mounted right now rather than a fixed
 * number. Stubbing it as a constant is what let a measurement that fed itself
 * pass its own tests (VC-288 review).
 *
 * The AREA is the box that does not move — 300px of room, chevrons or not — and
 * `content` is the tabs' own width, which changes when tabs open and close.
 */
function layoutStrip(options: { area?: number; content: number; scrollLeft?: number }) {
  let area = options.area ?? 300;
  let content = options.content;
  let left = options.scrollLeft ?? 0;
  const affordances = (): number =>
    (container?.querySelectorAll('[data-slot="tab-scroll-affordance"]').length ?? 0) *
    AFFORDANCE_WIDTH;
  const port = scroller();
  Object.defineProperty(scrollArea(), "clientWidth", { configurable: true, get: () => area });
  Object.defineProperty(port, "clientWidth", {
    configurable: true,
    get: () => area - affordances(),
  });
  // A scroller's `scrollWidth` never reports less than its own box — the same
  // floor a browser applies, and the one that made the old rule sticky.
  Object.defineProperty(port, "scrollWidth", {
    configurable: true,
    get: () => Math.max(content, area - affordances()),
  });
  Object.defineProperty(port, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (next: number) => {
      left = next;
    },
  });
  // The gliding path, spelled rather than left to jsdom: whether it implements
  // `scrollTo` is not this test's subject, and the strip prefers it whenever
  // the reader has not asked for reduced motion.
  Object.defineProperty(port, "scrollTo", {
    configurable: true,
    value: (options: ScrollToOptions) => {
      left = options.left ?? left;
    },
  });
  return {
    port,
    /** A tab opened or closed. */
    setContent(next: number): void {
      content = next;
    },
    /** A divider dragged, a rail opened, the window resized. */
    setArea(next: number): void {
      area = next;
    },
  };
}

/** A 300px window over `count` tabs of 100px each, parked at `scrollLeft`. */
function measureScroller(count: number, scrollLeft = 0): HTMLElement {
  return layoutStrip({ content: count * 100, scrollLeft }).port;
}

/** Everything a ResizeObserver would have reported, in one go. */
function resized(): void {
  act(() => {
    for (const observer of observers) observer.notify();
  });
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
  return container?.querySelector<HTMLButtonElement>(`[aria-label="${towards} tabs"]`) ?? null;
}

/** Make a tab's label draw less than it holds, which jsdom never does itself. */
function clipLabel(tab: HTMLElement): void {
  const run = tab.querySelector<HTMLElement>('[data-slot="tab-label"]');
  if (run === null) throw new Error("no label run");
  Object.defineProperty(run, "clientWidth", { configurable: true, get: () => 160 });
  Object.defineProperty(run, "scrollWidth", { configurable: true, get: () => 420 });
}

/** What the reveal is currently saying, if it is open at all. It portals. */
function revealText(): string | null {
  return document.body.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;
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
    tabs[2]?.focus();
    // Tab 2 spans 200-300 inside a window showing 120-420, including the 8px
    // reveal inset on both sides. Writing anything here would fight a person
    // mid-drag of the strip.
    expect(port.scrollLeft).toBe(120);
  });

  it("offers a pointer a way to the tabs it cannot see, and only while there are some", () => {
    renderTabs(9, 0);
    // 356px of area, so that once the two chevrons have taken 28px each the
    // scroller is the round 300px window the travel below is reckoned in.
    const { port } = layoutStrip({ area: 356, content: 900 });
    resized();

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

  /* THE TRANSITIONS, which is where the first attempt was wrong (VC-288
     review). Every case above constructs a strip that already overflows or
     already fits; what a person actually does is close a tab, widen a pane and
     select something — and the affordances were measured against the very box
     they shrink, so the strip could neither shed them nor keep its selected tab
     in view once they had mounted. */

  it("sheds the affordances when the tabs it has left fit again", () => {
    renderTabs(9, 0);
    const strip = layoutStrip({ content: 900 });
    resized();
    expect(affordance("Later")).not.toBeNull();

    // Six tabs closed: 250px of tabs in a 300px area. They fit — but they do
    // NOT fit the 244px the two mounted chevrons had left of the scroller, so a
    // strip measuring itself would keep both of them for ever, over a strip
    // with nothing out of view.
    renderTabs(3, 0);
    strip.setContent(250);
    resized();

    expect(affordance("Earlier")).toBeNull();
    expect(affordance("Later")).toBeNull();
  });

  it("sheds them when the pane widens under the same tabs", () => {
    renderTabs(9, 0);
    const strip = layoutStrip({ content: 900 });
    resized();
    expect(affordance("Later")).not.toBeNull();

    // A divider dragged, a rail closed: the window never changed, and only the
    // pane's own observer hears it.
    strip.setArea(1000);
    resized();

    expect(affordance("Later")).toBeNull();
  });

  it("keeps the selected tab in view when the affordances mount over it", () => {
    renderTabs(9, 0);
    const strip = layoutStrip({ content: 900 });
    // The selection lands on the last tab. The reveal that runs with it sees
    // the whole 300px area: the chevrons do not exist yet, because nothing has
    // measured the strip.
    renderTabs(9, 8);
    expect(strip.port.scrollLeft).toBe(600);

    resized();

    // Now they do, and the last tab is under one of them. 900 - 244 is the
    // furthest this scroller travels, and the tab's right edge asks for all of
    // it — without the second look, the tab a person just selected sits behind
    // the control that appeared to help them reach it.
    expect(affordance("Later")).not.toBeNull();
    expect(strip.port.scrollLeft).toBe(656);
  });

  it("follows the keyboard's tab through a resize, not just the selected one", () => {
    renderTabs(9, 0);
    const strip = layoutStrip({ area: 1000, content: 900 });
    resized();
    // Everything fits at 1000px, so there is nothing to reach and nothing has
    // moved. Focus walks to the last tab all the same.
    const tabs = tabsInStrip();
    act(() => tabs[8]?.focus());
    expect(strip.port.scrollLeft).toBe(0);

    // The pane is halved. The SELECTED tab is the first one and is already in
    // view; the tab under the keyboard is the eighth and is now far out of it.
    strip.setArea(400);
    resized();

    expect(document.activeElement).toBe(tabs[8]);
    // 900 - (400 - 56) is the end of this scroller's travel, which is where the
    // last tab's right edge and its inset land.
    expect(strip.port.scrollLeft).toBe(556);
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

  it("still claims Shift+wheel, the gesture the affordances stand beside", () => {
    // The chevrons are the discoverable way to a clipped tab, not a replacement
    // for the one a hand already on the wheel has: the strip's own native
    // listener still has to claim the gesture and move the scroller with it.
    renderTabs(9, 0);
    const port = measureScroller(9);
    const wheel = new WheelEvent("wheel", {
      deltaY: 120,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      port.dispatchEvent(wheel);
    });

    expect(port.scrollLeft).toBe(120);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it("shows a clipped label in full on focus, and on hover, not only to AT", () => {
    // VC-288 review. `aria-label` answers a screen reader; a sighted person
    // arrowing along a narrow strip was left with `Rewrite the workt…` and no
    // way to see the rest — file tabs do not even carry a `title`. The reveal
    // rides the tab itself rather than a stop of its own: a tab is already
    // focusable, and a second control inside it would be one more press
    // between a person and the thing they were reaching for.
    const label = "Rewrite the worktree archive path so a reopened ticket finds it";
    act(() => {
      root?.render(
        <TabStrip label="Home tabs">
          <Tab label={label} hint="src" active tabStop closable={false} onActivate={() => {}} />
        </TabStrip>,
      );
    });
    const [tab] = tabsInStrip();
    clipLabel(tab!);

    act(() => tab?.focus());

    // Radix opens on focus with no delay at all — the delay is the pointer's,
    // for a sweep along a row of controls — so this is the keyboard's reveal,
    // synchronously, in the frame the focus landed.
    expect(revealText()).toBe(`${label} · src`);
  });

  it("stays quiet for a label the tab draws whole", () => {
    // A tooltip over every tab in a strip is noise a person learns to ignore,
    // which is how the one that matters gets missed. The measurement is what
    // keeps the reveal to the tabs that are actually hiding something.
    act(() => {
      root?.render(
        <TabStrip label="Home tabs">
          <Tab label="app.ts" active tabStop closable={false} onActivate={() => {}} />
        </TabStrip>,
      );
    });
    const [tab] = tabsInStrip();

    act(() => tab?.focus());

    expect(revealText()).toBeNull();
  });

  it("keeps a label the tab is too narrow to draw whole in its accessible name", () => {
    // The label is `max-w-40 truncate`, so a long one is drawn with an ellipsis
    // and `title` would offer the rest to a pointer and to nothing else. The
    // accessible name is where the whole string stays reachable, which is what
    // makes the truncation a drawing decision rather than a loss of content.
    const label = "Rewrite the worktree archive path so a reopened ticket finds it";
    act(() => {
      root?.render(
        <TabStrip label="Home tabs">
          <Tab label={label} active tabStop closable={false} onActivate={() => {}} />
        </TabStrip>,
      );
    });
    const [tab] = tabsInStrip();

    expect(tab?.getAttribute("aria-label")).toBe(label);
    expect(tab?.querySelector("span")?.className).toContain("truncate");
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
