// @vitest-environment jsdom
/**
 * The grip between two panes — and the one property that is not cosmetic.
 *
 * ONE RATIO PER FRAME is why this file has a test at all: a drag writes through
 * a store that re-renders editors, transcripts and terminals, and a terminal
 * pane sends a PTY resize over IPC per write. An uncoalesced drag charges all
 * of that several times per displayed frame, to work nobody ever sees. The
 * other assertions are the drag's edges: the press lands immediately (waiting a
 * frame would read as lag on the click) and the release lands the sample the
 * cancelled frame was carrying.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SplitViewDivider } from "./split-view-divider";

/** The box the divider measures itself against: 1000 × 400 at the origin. */
const PARENT = { left: 0, top: 0, width: 1000, height: 400 };

let container: HTMLElement | null = null;
let root: Root | null = null;
let frames: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = [];
  // Frames are RUN BY HAND: the whole point of the coalescing is that a frame
  // that has not run yet absorbs every sample after it.
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    frames[handle - 1] = () => {};
  });
  Element.prototype.getBoundingClientRect = function getRect(this: Element) {
    return { ...PARENT, right: PARENT.width, bottom: PARENT.height, x: 0, y: 0 } as DOMRect;
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

function render(
  onChange: (ratio: number) => void,
  direction: "row" | "column" = "row",
  ratio = 0.5,
): HTMLElement {
  act(() => {
    // A parent to measure: the divider reads its own parentElement's box.
    root?.render(
      <div>
        <SplitViewDivider direction={direction} ratio={ratio} onChange={onChange} />
      </div>,
    );
  });
  const grip = container?.querySelector<HTMLElement>('[role="separator"]');
  if (grip === null || grip === undefined) throw new Error("no divider rendered");
  // jsdom has no pointer capture.
  grip.setPointerCapture = () => {};
  grip.releasePointerCapture = () => {};
  return grip;
}

/** A pointer event jsdom will construct — it has no PointerEvent of its own. */
function pointer(type: string, x: number, y: number): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

function drag(grip: HTMLElement, type: string, x: number, y: number): void {
  act(() => {
    grip.dispatchEvent(pointer(type, x, y));
  });
}

/** Run the frames the drag asked for, as a display refresh would. */
function paint(): void {
  const pending = frames;
  frames = [];
  act(() => {
    for (const frame of pending) frame();
  });
}

describe("SplitViewDivider", () => {
  it("lands the press immediately, unthrottled", () => {
    const onChange = vi.fn();
    const grip = render(onChange);

    drag(grip, "pointerdown", 300, 0);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(0.3);
  });

  it("writes ONE ratio per frame, the frame's last sample", () => {
    const onChange = vi.fn();
    const grip = render(onChange);
    drag(grip, "pointerdown", 300, 0);
    onChange.mockClear();

    // Four samples inside one frame — a trackpad's rate, not a display's.
    drag(grip, "pointermove", 320, 0);
    drag(grip, "pointermove", 340, 0);
    drag(grip, "pointermove", 360, 0);
    drag(grip, "pointermove", 380, 0);
    expect(onChange).not.toHaveBeenCalled();

    paint();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(0.38);
  });

  it("lands the sample the released frame was still carrying", () => {
    const onChange = vi.fn();
    const grip = render(onChange);
    drag(grip, "pointerdown", 300, 0);
    drag(grip, "pointermove", 420, 0);
    onChange.mockClear();

    // The frame never runs; without this the panes settle one sample short of
    // where the pointer was let go.
    drag(grip, "pointerup", 420, 0);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(0.42);

    paint();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores a move that is not part of a drag", () => {
    const onChange = vi.fn();
    const grip = render(onChange);

    drag(grip, "pointermove", 700, 0);
    paint();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps 240px in each pane, from either end", () => {
    const onChange = vi.fn();
    const grip = render(onChange);

    drag(grip, "pointerdown", 0, 0);
    expect(onChange).toHaveBeenLastCalledWith(0.24);

    drag(grip, "pointerup", 0, 0);
    drag(grip, "pointerdown", 1000, 0);
    expect(onChange).toHaveBeenLastCalledWith(0.76);
  });

  it("measures the other axis when it divides top from bottom", () => {
    const onChange = vi.fn();
    const grip = render(onChange, "column");

    expect(grip.getAttribute("aria-orientation")).toBe("horizontal");
    expect(grip.getAttribute("aria-label")).toBe("Resize top and bottom panes");

    // y, not x: the same press that read 0 across a 1000px width reads half
    // way down a 400px height.
    drag(grip, "pointerdown", 0, 200);
    expect(onChange).toHaveBeenLastCalledWith(0.5);
  });

  it("falls back to a 45% floor in a box too small for two full panes", () => {
    // 240px twice does not fit in 400, so the floor's own floor takes over —
    // the divider stops trying to hold a size the box cannot give.
    const onChange = vi.fn();
    const grip = render(onChange, "column");

    drag(grip, "pointerdown", 0, 0);
    expect(onChange).toHaveBeenLastCalledWith(0.45);
  });

  it("steps by 3% on the arrow keys, and ignores the ones across its axis", () => {
    const onChange = vi.fn();
    const grip = render(onChange, "row", 0.5);

    act(() => {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(0.53);

    act(() => {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(0.47);

    act(() => {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("tells AT where it stands, inside the model's own clamp", () => {
    const grip = render(vi.fn(), "row", 0.3);
    expect(grip.getAttribute("aria-valuenow")).toBe("30");
    expect(grip.getAttribute("aria-valuemin")).toBe("15");
    expect(grip.getAttribute("aria-valuemax")).toBe("85");
  });
});
