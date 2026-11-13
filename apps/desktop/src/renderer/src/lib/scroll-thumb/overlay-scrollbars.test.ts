// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DRAGGING_ATTR,
  HIDE_AFTER_MS,
  TARGET_ATTR,
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
const state = (axis: "x" | "y") => track(axis)?.getAttribute("data-state");

/** ResizeObservers whose callbacks the test fires, standing in for the browser's post-layout pass. */
let observers: { callback: () => void; targets: Set<Element> }[] = [];
function flushResize(): void {
  for (const observer of observers) if (observer.targets.size > 0) observer.callback();
}

let frames: FrameRequestCallback[] = [];
function flushFrames(): void {
  const due = frames;
  frames = [];
  for (const callback of due) callback(0);
}

/** One rendering update: layout, then observers (reads), then the next frame (writes). */
function settle(): void {
  flushResize();
  flushFrames();
}

let teardown: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  observers = [];
  frames = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>();
      constructor(callback: () => void) {
        observers.push({ callback, targets: this.targets });
      }
      observe(element: Element) {
        this.targets.add(element);
      }
      unobserve(element: Element) {
        this.targets.delete(element);
      }
      disconnect() {
        this.targets.clear();
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

  it("follows a scroll burst: target marked, tracks last in body, length measured, hidden after idle", () => {
    const list = scroller({ client: 200, scroll: 800 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    // The handler only records: nothing is read or written until the next layout and frame.
    expect(list.hasAttribute(TARGET_ATTR)).toBe(false);

    settle();
    expect(list.getAttribute(TARGET_ATTR)).toBe("y");
    expect(document.body.lastElementChild).toBe(track("x"));
    expect(track("x")!.previousElementSibling).toBe(track("y"));
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
    expect(frames).toHaveLength(0);
  });

  it("runs each update from an observer newer than any other, so it is the frame's last", () => {
    const list = scroller({ client: 200, scroll: 800 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    const before = observers.length;
    // Someone else's observer, created after our request was made.
    new ResizeObserver(() => {}).observe(document.body);
    list.dispatchEvent(new Event("scroll"));
    expect(observers.length).toBe(before + 1);
    settle();
    list.dispatchEvent(new Event("scroll"));
    expect(observers.length).toBe(before + 2);
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
    expect(lookups).not.toHaveBeenCalled();
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

    // Another code block slides under the still pointer: the transcript keeps the thumb...
    const next = scroller({ client: 100, scroll: 400 });
    transcript.append(next);
    next.firstElementChild!.dispatchEvent(pointer("pointerover"));
    settle();
    expect(transcript.getAttribute(TARGET_ATTR)).toBe("y");
    // ...until the burst ends, when the pointer is resolved again.
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
    row.dispatchEvent(pointer("pointermove", { clientX: 198, clientY: 30 }));
    row.dispatchEvent(pointer("pointermove", { clientX: 198, clientY: 46 }));
    expect(frames).toHaveLength(1);
    expect(list.scrollTop).toBe(0);
    flushFrames();
    expect(list.scrollTop).toBe(150);
    // The thumb moves in the same frame as the write: half of 96 less 24.
    expect(thumb("y").style.transform).toBe("translateY(36px)");
    row.dispatchEvent(pointer("pointermove", { clientX: 198, clientY: 500 }));
    flushFrames();
    expect(list.scrollTop).toBe(300);

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
    const list = scroller({ client: 100, scroll: 100 });
    document.body.append(list);
    list.dispatchEvent(new Event("scroll"));
    settle();
    expect(state("y")).toBe("hidden");

    const row = document.createElement("p");
    list.append(row);
    setSizes(list, { client: 100, scroll: 400 });
    await Promise.resolve(); // MutationObserver delivery
    expect(observers.some((observer) => observer.targets.has(row))).toBe(true);
    settle();
    expect(thumb("y").style.height).toBe("24px");
    expect(state("y")).toBe("visible");

    list.remove();
    settle();
    expect(list.hasAttribute(TARGET_ATTR)).toBe(false);
    expect(state("y")).toBe("hidden");
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
    const list = scroller({ client: 200, scroll: 800 });
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
