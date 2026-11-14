// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DRAGGING_ATTR,
  EXCLUDED_SELECTOR,
  HIDE_AFTER_MS,
  SCROLL_THUMB_GRAB_EVENT,
  TARGET_ATTR,
  UPDATE_FAILED_CODE,
  installOverlayScrollbars,
} from "./overlay-scrollbars";

/** jsdom lays nothing out: each scroller states its sizes and box. */
function scroller(
  sizes: { client?: number; scroll?: number; clientWidth?: number; scrollWidth?: number },
  overflowY = "auto",
): HTMLDivElement {
  const element = document.createElement("div");
  element.style.overflowY = overflowY;
  element.append(document.createElement("p"), document.createElement("p"));
  setSizes(element, sizes);
  // jsdom's scrollTop is always 0; a plain field lets a drag's writes be read back.
  Object.defineProperty(element, "scrollTop", { value: 0, writable: true });
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 100));
  return element;
}

function setSizes(
  element: HTMLElement,
  {
    client = 100,
    scroll = 100,
    clientWidth = 200,
    scrollWidth = 200,
  }: Parameters<typeof scroller>[0],
): void {
  for (const [key, value] of Object.entries({
    clientHeight: client,
    scrollHeight: scroll,
    clientWidth,
    scrollWidth,
  })) {
    Object.defineProperty(element, key, { get: () => value, configurable: true });
  }
  resized(element);
}

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

function pointer(type: string, init: MouseEventInit & { pointerId?: number } = {}): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return event;
}

const track = (axis: "x" | "y") =>
  document.querySelector<HTMLElement>(`[data-slot="scroll-thumb-track"][data-axis="${axis}"]`);
const thumb = (axis: "x" | "y") =>
  track(axis)!.querySelector<HTMLElement>('[data-slot="scroll-thumb"]')!;
/** A lane's state; a track is only put in the document once it first shows. */
const state = (axis: "x" | "y") => track(axis)?.getAttribute("data-state") ?? "hidden";
const dragging = () => document.documentElement.hasAttribute(DRAGGING_ATTR);

/**
 * ResizeObservers whose callbacks the test fires, standing in for the browser's
 * post-layout pass with its rules: a callback runs for a NEW observation (its
 * first notification) or for an observed element whose size changed
 * ({@link resized}), not otherwise.
 */
interface FakeObserver {
  callback: () => void;
  targets: Set<Element>;
  due: Set<Element>;
}
let observers: FakeObserver[] = [];
function flushResize(): void {
  for (const observer of observers) {
    if (observer.due.size === 0) continue;
    observer.due.clear();
    observer.callback();
  }
}
/** The browser noticed `element` change size. */
function resized(element: Element): void {
  for (const observer of observers) if (observer.targets.has(element)) observer.due.add(element);
}

let frames: FrameRequestCallback[] = [];
function flushFrames(): void {
  const due = frames;
  frames = [];
  for (const callback of due) callback(0);
}

/** A few rendering updates: observers after layout, then the next frames' callbacks. */
function settle(): void {
  for (let pass = 0; pass < 3; pass += 1) {
    flushResize();
    flushFrames();
  }
}

let teardown: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  observers = [];
  frames = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      record: FakeObserver;
      constructor(callback: () => void) {
        this.record = { callback, targets: new Set(), due: new Set() };
        observers.push(this.record);
      }
      observe(element: Element) {
        if (this.record.targets.has(element)) return; // Chromium: re-observing is a no-op
        this.record.targets.add(element);
        this.record.due.add(element);
      }
      unobserve(element: Element) {
        this.record.targets.delete(element);
        this.record.due.delete(element);
      }
      disconnect() {
        this.record.targets.clear();
        this.record.due.clear();
      }
    },
  );
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  teardown = installOverlayScrollbars(document);
});

afterEach(() => {
  teardown();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("overlay scroll thumb", () => {
  it("adds nothing to the document until something scrolls or is hovered", () => {
    settle();
    expect(track("y")).toBeNull();
  });

  it("follows a scroll burst: target marked, track after its layer, length measured, hidden after idle", () => {
    const list = scroller({ client: 200, scroll: 800 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    // The handler only records: nothing is read or written until the next layout and frame.
    expect(list.hasAttribute(TARGET_ATTR)).toBe(false);

    settle();
    expect(list.getAttribute(TARGET_ATTR)).toBe("y");
    // Right after the body child the target is painted in; the hidden x lane is not mounted.
    expect(track("y")!.previousElementSibling).toBe(list);
    expect(track("x")).toBeNull();
    // A 196px track (200 less two 2px insets) at the box's right edge; a quarter of it is thumb.
    expect(track("y")!.style.transform).toBe("translate(193px, 2px)");
    expect(track("y")!.style.height).toBe("196px");
    expect(thumb("y").style.height).toBe("49px");
    expect(state("y")).toBe("visible");
    // No horizontal overflow, so no horizontal thumb.
    expect(state("x")).toBe("hidden");

    vi.advanceTimersByTime(HIDE_AFTER_MS - 1);
    list.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(HIDE_AFTER_MS - 1);
    settle();
    expect(state("y")).toBe("visible");
    vi.advanceTimersByTime(1);
    settle();
    expect(state("y")).toBe("hidden");
  });

  it("reads no layout and writes nothing while scroll events land on the current target", () => {
    const list = scroller({ client: 200, scroll: 800 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    settle();
    const reads = vi.spyOn(list, "scrollHeight", "get");
    const box = list.getBoundingClientRect as unknown as ReturnType<typeof vi.fn>;
    box.mockClear();
    const writes = vi.spyOn(track("y")!, "setAttribute");
    for (let index = 0; index < 50; index += 1) list.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(reads).not.toHaveBeenCalled();
    expect(box).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  it("moves the thumb with the scroll: nothing in the handler, read and written after layout", () => {
    const list = scroller({ client: 200, scroll: 800 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    settle();
    expect(thumb("y").style.transform).toBe("");
    list.scrollTop = 300; // half the 600px range
    list.dispatchEvent(new Event("scroll"));
    expect(thumb("y").style.transform).toBe("");
    flushResize();
    // Half of the track less the thumb: (196 - 49) / 2.
    expect(thumb("y").style.transform).toBe("translateY(73.5px)");
  });

  it("runs each update from an observer created for it, after any other", () => {
    const list = scroller({ client: 200, scroll: 800 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    settle();
    const before = observers.length;
    // Someone else's observer, created before our next request.
    const order: string[] = [];
    new ResizeObserver(() => order.push("theirs")).observe(document.body);
    list.dispatchEvent(new Event("scroll"));
    expect(observers.length).toBe(before + 2);
    const ours = observers.at(-1)!;
    expect([...ours.targets]).toEqual([document.documentElement]);
    const run = ours.callback;
    ours.callback = () => {
      order.push("ours");
      run();
    };
    // Callbacks run in creation order: theirs, then ours, last.
    flushResize();
    expect(order).toEqual(["theirs", "ours"]);
  });

  it("never observes from inside a delivery: a size change only asks for the next frame", () => {
    const list = scroller({ client: 200, scroll: 800 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    settle();
    const before = observers.length;
    setSizes(list, { client: 200, scroll: 900 });
    flushResize(); // the targets' observer runs: it must not create an observer now
    expect(observers.length).toBe(before);
    expect(frames).toHaveLength(1);
    flushFrames(); // the next frame makes the request
    expect(observers.length).toBe(before + 1);
    flushResize();
    expect(Number.parseFloat(thumb("y").style.height)).toBeCloseTo((196 * 200) / 900);
  });

  it("skips a write that would move nothing by a tenth of a pixel", () => {
    const list = scroller({ client: 200, scroll: 800 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    settle();
    const thumbStyle = thumb("y").style;
    const trackStyle = track("y")!.style;
    const writes = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
    setSizes(list, { client: 200, scroll: 800.1 });
    settle();
    expect(thumbStyle.height).toBe("49px");
    expect(trackStyle.transform).toBe("translate(193px, 2px)");
    expect(writes).not.toHaveBeenCalled();
    setSizes(list, { client: 200, scroll: 900 });
    settle();
    expect(Number.parseFloat(thumbStyle.height)).toBeCloseTo((196 * 200) / 900);
  });

  it("shows on hover of an overflowing scroller and hides when the pointer leaves it", () => {
    const list = scroller({ client: 200, scroll: 800 });
    const outside = document.createElement("button");
    document.body.append(list, outside);
    list.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    expect(list.getAttribute(TARGET_ATTR)).toBe("y");
    expect(state("y")).toBe("visible");

    list.firstElementChild!.dispatchEvent(
      pointer("pointerout", { relatedTarget: list.lastElementChild }),
    );
    settle();
    expect(state("y")).toBe("visible");
    list.firstElementChild!.dispatchEvent(pointer("pointerout", { relatedTarget: outside }));
    settle();
    expect(state("y")).toBe("hidden");
  });

  it("picks the innermost scroller that overflows, falling back outward", () => {
    const outer = scroller({ client: 300, scroll: 900 });
    const inner = scroller({ client: 100, scroll: 100 });
    outer.append(inner);
    document.body.append(outer);
    inner.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    expect(outer.getAttribute(TARGET_ATTR)).toBe("y");

    const overflowingInner = scroller({ client: 100, scroll: 400 });
    outer.append(overflowingInner);
    overflowingInner.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    expect(overflowingInner.getAttribute(TARGET_ATTR)).toBe("y");
    expect(outer.hasAttribute(TARGET_ATTR)).toBe(false);
  });

  it("gives each axis its own target: a sideways code block inside a transcript shows both thumbs", () => {
    const transcript = scroller({ client: 300, scroll: 3000 });
    const code = scroller(
      { client: 100, scroll: 100, clientWidth: 200, scrollWidth: 600 },
      "visible",
    );
    code.style.overflowX = "auto";
    transcript.append(code);
    document.body.append(transcript);
    code.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    expect(transcript.getAttribute(TARGET_ATTR)).toBe("y");
    expect(code.getAttribute(TARGET_ATTR)).toBe("x");
    expect(state("y")).toBe("visible");
    expect(state("x")).toBe("visible");
    expect(Number.parseFloat(thumb("x").style.width)).toBeCloseTo(196 / 3);
    expect(track("x")!.style.transform).toBe("translate(2px, 93px)");

    // Back over the prose: the transcript keeps the vertical thumb, the code block lets go.
    transcript.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    expect(transcript.getAttribute(TARGET_ATTR)).toBe("y");
    expect(code.hasAttribute(TARGET_ATTR)).toBe(false);
    expect(state("x")).toBe("hidden");
  });

  it("resolves a scroll container once, however many of its rows the pointer crosses", () => {
    const list = scroller({ client: 200, scroll: 800 });
    document.body.append(list);
    list.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    const lookups = vi.spyOn(Element.prototype, "closest");
    for (let index = 0; index < 20; index += 1) {
      list.children[index % 2]!.dispatchEvent(pointer("pointerover"));
      settle();
    }
    // Resolving a container looks for excluded surfaces; crossing rows inside
    // the one already resolved never does.
    expect(lookups.mock.calls.filter(([selector]) => selector === EXCLUDED_SELECTOR)).toEqual([]);
    expect(state("y")).toBe("visible");
  });

  it("never targets an opted-out scroller or one inside a surface that draws its own bar", () => {
    const strip = scroller({ client: 100, scroll: 400 });
    strip.setAttribute("data-scroll-thumb", "none");
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const viewport = scroller({ client: 100, scroll: 400 });
    terminal.append(viewport);
    document.body.append(strip, terminal);

    strip.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    strip.dispatchEvent(new Event("scroll"));
    settle();
    viewport.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    viewport.dispatchEvent(new Event("scroll"));
    settle();
    expect(document.querySelector(`[${TARGET_ATTR}]`)).toBeNull();
  });

  it("keeps the hovered scroller when another one scrolls on its own", () => {
    const list = scroller({ client: 200, scroll: 800 });
    const stream = scroller({ client: 200, scroll: 2000 });
    document.body.append(list, stream);
    list.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    stream.dispatchEvent(new Event("scroll"));
    settle();
    expect(list.getAttribute(TARGET_ATTR)).toBe("y");
    expect(stream.hasAttribute(TARGET_ATTR)).toBe(false);
  });

  it("follows a wheel that chains out of the hovered scroller to the one holding it", () => {
    const transcript = scroller({ client: 300, scroll: 3000 });
    const code = scroller({ client: 100, scroll: 400 });
    transcript.append(code);
    document.body.append(transcript);
    code.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    expect(code.getAttribute(TARGET_ATTR)).toBe("y");
    vi.spyOn(transcript, "matches").mockReturnValue(true); // the pointer is still over it
    transcript.dispatchEvent(new Event("scroll"));
    settle();
    expect(transcript.getAttribute(TARGET_ATTR)).toBe("y");
    expect(code.hasAttribute(TARGET_ATTR)).toBe(false);
    expect(state("y")).toBe("visible");

    // Another code block slides under the STILL pointer (a pointerover where the
    // pointer last moved): the transcript keeps the thumb...
    const next = scroller({ client: 100, scroll: 400 });
    transcript.append(next);
    transcript.dispatchEvent(pointer("pointermove", { clientX: 50, clientY: 50 }));
    next.firstElementChild!.dispatchEvent(pointer("pointerover", { clientX: 50, clientY: 50 }));
    settle();
    expect(transcript.getAttribute(TARGET_ATTR)).toBe("y");
    // ...until the burst ends, when the pointer is resolved again. A pointer that
    // MOVED onto it would have been resolved at once.
    vi.advanceTimersByTime(HIDE_AFTER_MS);
    settle();
    expect(next.getAttribute(TARGET_ATTR)).toBe("y");
  });

  it("drags: the press is swallowed, the scroll follows the pointer once per frame, and the click after it is eaten", () => {
    const list = scroller({ client: 100, scroll: 400 });
    document.body.append(list);
    const row = list.firstElementChild!;
    row.dispatchEvent(pointer("pointerover"));
    settle();
    // Track 96px, ratio 0.25: a 24px thumb at the top of a box whose right edge is x=200.
    vi.spyOn(thumb("y"), "getBoundingClientRect").mockReturnValue(rect(193, 2, 197, 26));
    const outsidePress = vi.fn();
    document.addEventListener("pointerdown", outsidePress);
    const clicked = vi.fn();
    row.addEventListener("click", clicked);

    const down = pointer("pointerdown", { clientX: 198, clientY: 10, button: 0 });
    row.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(outsidePress).not.toHaveBeenCalled();
    settle();
    expect(document.documentElement.hasAttribute(DRAGGING_ATTR)).toBe(true);
    expect(track("y")!.hasAttribute("data-dragging")).toBe(true);

    // Thumb travel 72px over a 300px range: 36px of pointer is 150px of content.
    row.dispatchEvent(pointer("pointermove", { clientX: 198, clientY: 30, buttons: 1 }));
    row.dispatchEvent(pointer("pointermove", { clientX: 198, clientY: 46, buttons: 1 }));
    expect(frames).toHaveLength(1);
    expect(list.scrollTop).toBe(0);
    flushFrames();
    expect(list.scrollTop).toBe(150);
    // The thumb moves in the same frame as the write: half of 96 less 24.
    expect(thumb("y").style.transform).toBe("translateY(36px)");
    row.dispatchEvent(pointer("pointermove", { clientX: 198, clientY: 500, buttons: 1 }));
    flushFrames();
    // Taken to the end, a drag asks for the end itself (the browser clamps), so
    // it stays at the true end while content grows.
    expect(list.scrollTop).toBe(Number.MAX_SAFE_INTEGER);

    row.dispatchEvent(pointer("pointerup", { clientX: 198, clientY: 500 }));
    settle();
    expect(document.documentElement.hasAttribute(DRAGGING_ATTR)).toBe(false);
    row.dispatchEvent(pointer("click"));
    expect(clicked).not.toHaveBeenCalled();
    row.dispatchEvent(pointer("click"));
    expect(clicked).toHaveBeenCalledTimes(1);
    document.removeEventListener("pointerdown", outsidePress);
  });

  it("lets a press off the thumb, or on something over the scroller's edge, through", () => {
    const panel = document.createElement("div");
    const list = scroller({ client: 100, scroll: 400 });
    const grip = document.createElement("div");
    panel.append(list, grip);
    document.body.append(panel);
    list.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    vi.spyOn(thumb("y"), "getBoundingClientRect").mockReturnValue(rect(193, 2, 197, 26));

    const belowThumb = pointer("pointerdown", { clientX: 198, clientY: 80, button: 0 });
    list.firstElementChild!.dispatchEvent(belowThumb);
    expect(belowThumb.defaultPrevented).toBe(false);

    const onGrip = pointer("pointerdown", { clientX: 199, clientY: 10, button: 0 });
    grip.dispatchEvent(onGrip);
    expect(onGrip.defaultPrevented).toBe(false);
  });

  it("re-measures when children are added and lets go of a target that left the document", async () => {
    const list = scroller({ client: 100, scroll: 200 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    settle();
    expect(state("y")).toBe("visible");

    const row = document.createElement("p");
    list.append(row);
    setSizes(list, { client: 100, scroll: 400 });
    await Promise.resolve(); // MutationObserver delivery
    settle();
    expect(observers.some((observer) => observer.targets.has(row))).toBe(true);
    expect(thumb("y").style.height).toBe("24px");
    expect(state("y")).toBe("visible");

    list.remove();
    resized(list); // a removed element reports a zero size
    settle();
    expect(list.hasAttribute(TARGET_ATTR)).toBe(false);
    expect(state("y")).toBe("hidden");
  });

  it("never targets a scroller under a modal, and drops one a modal covers", () => {
    const page = document.createElement("div");
    const list = scroller({ client: 200, scroll: 800 });
    page.append(list);
    document.body.append(page);
    list.dispatchEvent(new Event("scroll"));
    settle();
    expect(state("y")).toBe("visible");
    page.setAttribute("aria-hidden", "true"); // Radix hideOthers
    list.dispatchEvent(new Event("scroll"));
    settle();
    expect(state("y")).toBe("hidden");
    expect(list.hasAttribute(TARGET_ATTR)).toBe(false);
    list.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    expect(list.hasAttribute(TARGET_ATTR)).toBe(false);
  });

  it("forgets a container that resolved to nothing, so the next crossing resolves again", () => {
    const transcript = scroller({ client: 300, scroll: 900 });
    const menu = scroller({ client: 100, scroll: 100 });
    document.body.append(transcript, menu);
    transcript.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    for (const row of [menu.firstElementChild!, menu.lastElementChild!, menu.firstElementChild!]) {
      row.dispatchEvent(pointer("pointerover"));
      settle();
      expect(state("y")).toBe("hidden");
    }
    setSizes(menu, { client: 100, scroll: 400 }); // it filled while the pointer was on it
    menu.lastElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    expect(menu.getAttribute(TARGET_ATTR)).toBe("y");
    expect(state("y")).toBe("visible");
  });

  it("ends a drag on blur and on a move with no button, and Escape puts the scroll back", () => {
    const list = scroller({ client: 100, scroll: 400 });
    document.body.append(list);
    const row = list.firstElementChild!;
    row.dispatchEvent(pointer("pointerover"));
    settle();
    vi.spyOn(thumb("y"), "getBoundingClientRect").mockReturnValue(rect(193, 2, 197, 26));
    const press = () =>
      row.dispatchEvent(pointer("pointerdown", { clientX: 198, clientY: 10, button: 0 }));

    press();
    settle();
    expect(dragging()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    settle();
    expect(dragging()).toBe(false);

    press();
    row.dispatchEvent(pointer("pointermove", { clientX: 198, clientY: 60, buttons: 0 }));
    flushFrames();
    settle();
    expect(dragging()).toBe(false);
    expect(list.scrollTop).toBe(0);

    list.scrollTop = 40;
    press();
    row.dispatchEvent(pointer("pointermove", { clientX: 198, clientY: 50, buttons: 1 }));
    flushFrames();
    expect(list.scrollTop).not.toBe(40);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const menuSaw = vi.fn();
    document.addEventListener("keydown", menuSaw);
    document.body.dispatchEvent(escape);
    settle();
    expect(list.scrollTop).toBe(40);
    expect(escape.defaultPrevented).toBe(true);
    expect(menuSaw).not.toHaveBeenCalled();
    expect(dragging()).toBe(false);
    document.removeEventListener("keydown", menuSaw);
  });

  it("recovers from an update that throws, and logs it once", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = scroller({ client: 100, scroll: 400 });
    const good = scroller({ client: 100, scroll: 400 });
    document.body.append(bad, good);
    vi.spyOn(bad, "getBoundingClientRect").mockImplementation(() => {
      throw new Error("boom");
    });
    for (let index = 0; index < 3; index += 1) {
      bad.firstElementChild!.dispatchEvent(pointer("pointerover"));
      settle();
      good.firstElementChild!.dispatchEvent(pointer("pointerover"));
      settle();
    }
    expect(good.getAttribute(TARGET_ATTR)).toBe("y");
    expect(state("y")).toBe("visible");
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![0])).toContain(UPDATE_FAILED_CODE);
  });

  it("puts a track after its target's layer, so a layer portalled later paints above it", () => {
    const page = document.createElement("div");
    const list = scroller({ client: 200, scroll: 800 });
    page.append(list);
    document.body.append(page);
    list.dispatchEvent(new Event("scroll"));
    settle();
    expect(track("y")!.previousElementSibling).toBe(page);
    const tooltip = document.createElement("div");
    document.body.append(tooltip);
    list.dispatchEvent(new Event("scroll"));
    settle();
    // Unmoved: the tooltip, portalled later, stays after it in tree order.
    expect(track("y")!.nextElementSibling).toBe(tooltip);
  });

  it("paints at the layer of a z-indexed flex item, not only a positioned one", () => {
    const row = document.createElement("div");
    row.style.display = "flex";
    const item = document.createElement("div");
    item.style.zIndex = "30";
    const list = scroller({ client: 200, scroll: 800 });
    item.append(list);
    row.append(item);
    document.body.append(row);
    list.dispatchEvent(new Event("scroll"));
    settle();
    expect(track("y")!.style.zIndex).toBe("30");
  });

  it("clips a track to what its clipping ancestors leave visible, and hides one clipped away", () => {
    const outer = document.createElement("div");
    outer.style.overflowX = "hidden";
    outer.style.overflowY = "hidden";
    vi.spyOn(outer, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 50));
    const list = scroller({ client: 100, scroll: 400, clientWidth: 200, scrollWidth: 600 });
    list.style.overflowX = "auto";
    outer.append(list);
    document.body.append(outer);
    list.dispatchEvent(new Event("scroll"));
    settle();
    // The 96px y track starts at 2 and is visible to 50: the bottom 48px is clipped.
    expect(state("y")).toBe("visible");
    expect(track("y")!.style.clipPath).toBe("inset(0px 0px 48px 0px)");
    // The x track runs along y 93–97, wholly below the visible 50.
    expect(state("x")).toBe("hidden");
  });

  it("never targets a scroller that is not visible", () => {
    const list = scroller({ client: 200, scroll: 800 });
    list.style.visibility = "hidden";
    document.body.append(list);
    list.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    list.dispatchEvent(new Event("scroll"));
    settle();
    expect(list.hasAttribute(TARGET_ATTR)).toBe(false);
  });

  it("tells the scroller a drag of its thumb began, since the press itself never reaches it", () => {
    const list = scroller({ client: 100, scroll: 400 });
    document.body.append(list);
    const row = list.firstElementChild!;
    row.dispatchEvent(pointer("pointerover"));
    settle();
    vi.spyOn(thumb("y"), "getBoundingClientRect").mockReturnValue(rect(193, 2, 197, 26));
    const grabbed = vi.fn();
    const pressed = vi.fn();
    list.addEventListener(SCROLL_THUMB_GRAB_EVENT, grabbed);
    list.addEventListener("pointerdown", pressed);
    row.dispatchEvent(pointer("pointerdown", { clientX: 198, clientY: 10, button: 0 }));
    expect(grabbed).toHaveBeenCalledTimes(1);
    expect(pressed).not.toHaveBeenCalled();
  });

  it("stops watching a target once its thumb hides, and watches it again when it shows", () => {
    const list = scroller({ client: 200, scroll: 800 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    settle();
    const watching = () => observers.some((observer) => observer.targets.has(list));
    expect(watching()).toBe(true);
    vi.advanceTimersByTime(HIDE_AFTER_MS);
    settle();
    expect(state("y")).toBe("hidden");
    expect(watching()).toBe(false);
    // Growth out of sight runs nothing.
    const before = observers.length;
    setSizes(list, { client: 200, scroll: 1600 });
    settle();
    expect(observers.length).toBe(before);
    list.dispatchEvent(new Event("scroll"));
    settle();
    expect(watching()).toBe(true);
    expect(Number.parseFloat(thumb("y").style.height)).toBeCloseTo((196 * 200) / 1600);
  });

  it("observes a bounded set of children, adding new ones without rebuilding", async () => {
    const list = scroller({ client: 200, scroll: 8000 });
    for (let index = 0; index < 300; index += 1) list.append(document.createElement("p"));
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    settle();
    const watched = () => observers.reduce((count, observer) => count + observer.targets.size, 0);
    // The list, its first 64 children and its last.
    expect(watched()).toBe(1 + 64 + 1);
    const disconnects = vi.fn();
    for (const observer of observers) {
      const targets = observer.targets;
      const clear = targets.clear.bind(targets);
      targets.clear = () => {
        disconnects();
        clear();
      };
    }
    const row = document.createElement("p");
    list.append(row);
    await Promise.resolve();
    settle();
    expect(observers.some((observer) => observer.targets.has(row))).toBe(true);
    expect(disconnects).not.toHaveBeenCalled();
  });

  it("stays bounded while a hovered list grows by appending: the new last row replaces the old", async () => {
    const list = scroller({ client: 200, scroll: 8000 });
    for (let index = 0; index < 300; index += 1) list.append(document.createElement("p"));
    document.body.append(list);
    list.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    const watched = () => observers.reduce((count, observer) => count + observer.targets.size, 0);
    expect(watched()).toBe(1 + 64 + 1);
    for (let index = 0; index < 500; index += 1) {
      list.append(document.createElement("p"));
      await Promise.resolve();
      settle();
    }
    expect(watched()).toBeLessThanOrEqual(1 + 64 + 1);
    expect(observers.some((observer) => observer.targets.has(list.lastElementChild!))).toBe(true);
  });

  it("never grabs a part of the thumb its ancestors clip away", () => {
    const outer = document.createElement("div");
    outer.style.overflowX = "hidden";
    outer.style.overflowY = "hidden";
    vi.spyOn(outer, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 50));
    const list = scroller({ client: 100, scroll: 400 });
    outer.append(list);
    document.body.append(outer);
    const row = list.firstElementChild!;
    row.dispatchEvent(pointer("pointerover"));
    settle();
    // A thumb spanning y 30–54: drawn down to 50, clipped below it.
    vi.spyOn(thumb("y"), "getBoundingClientRect").mockReturnValue(rect(193, 30, 197, 54));
    const hidden = pointer("pointerdown", { clientX: 198, clientY: 52, button: 0 });
    row.dispatchEvent(hidden);
    expect(hidden.defaultPrevented).toBe(false);
    const drawn = pointer("pointerdown", { clientX: 198, clientY: 40, button: 0 });
    row.dispatchEvent(drawn);
    expect(drawn.defaultPrevented).toBe(true);
  });

  it("tears down completely", () => {
    const list = scroller({ client: 200, scroll: 800 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    settle();
    teardown();
    teardown = () => {};
    expect(track("y")).toBeNull();
    expect(list.hasAttribute(TARGET_ATTR)).toBe(false);
    list.dispatchEvent(new Event("scroll"));
    settle();
    expect(list.hasAttribute(TARGET_ATTR)).toBe(false);
  });

  it("is presentational: hidden from assistive technology and never focusable", () => {
    const list = scroller({ client: 200, scroll: 800, clientWidth: 200, scrollWidth: 600 });
    list.style.overflowX = "auto";
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    settle();
    for (const axis of ["x", "y"] as const) {
      expect(track(axis)!.getAttribute("aria-hidden")).toBe("true");
      expect(track(axis)!.tabIndex).toBe(-1);
      expect(track(axis)!.hasAttribute("role")).toBe(false);
    }
  });
});
