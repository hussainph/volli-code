import { describe, expect, it } from "vite-plus/test";

import {
  TAB_REVEAL_INSET,
  scrollTabsWithWheel,
  tabOverflow,
  tabScrollLeftFor,
  tabScrollStep,
  tabWheelScrollDelta,
} from "./tab-scroll";

describe("tabWheelScrollDelta", () => {
  it("maps Shift+wheel's vertical delta to the horizontal tab scroller", () => {
    expect(tabWheelScrollDelta({ deltaX: 0, deltaY: 120, shiftKey: true })).toBe(120);
    expect(tabWheelScrollDelta({ deltaX: 0, deltaY: -120, shiftKey: true })).toBe(-120);
  });

  it("leaves ordinary vertical wheel input alone", () => {
    expect(tabWheelScrollDelta({ deltaX: 0, deltaY: 120, shiftKey: false })).toBeNull();
  });

  it("leaves a native horizontal trackpad gesture to the browser", () => {
    expect(tabWheelScrollDelta({ deltaX: 120, deltaY: 20, shiftKey: true })).toBeNull();
  });

  it("does nothing when there is no vertical delta to remap", () => {
    expect(tabWheelScrollDelta({ deltaX: 0, deltaY: 0, shiftKey: true })).toBeNull();
  });
});

describe("scrollTabsWithWheel", () => {
  it("moves an overflowing strip and keeps the wheel gesture on it", () => {
    const scrollport = { clientWidth: 100, scrollWidth: 400, scrollLeft: 20 };
    let prevented = false;

    expect(
      scrollTabsWithWheel(scrollport, {
        deltaX: 0,
        deltaY: 120,
        shiftKey: true,
        preventDefault: () => {
          prevented = true;
        },
      }),
    ).toBe(true);
    expect(scrollport.scrollLeft).toBe(140);
    expect(prevented).toBe(true);
  });

  it("does not trap a wheel gesture when the strip does not overflow", () => {
    const scrollport = { clientWidth: 100, scrollWidth: 100, scrollLeft: 0 };
    let prevented = false;

    expect(
      scrollTabsWithWheel(scrollport, {
        deltaX: 0,
        deltaY: 120,
        shiftKey: true,
        preventDefault: () => {
          prevented = true;
        },
      }),
    ).toBe(false);
    expect(scrollport.scrollLeft).toBe(0);
    expect(prevented).toBe(false);
  });

  it("does not trap an ordinary vertical wheel gesture", () => {
    const scrollport = { clientWidth: 100, scrollWidth: 400, scrollLeft: 0 };
    let prevented = false;

    expect(
      scrollTabsWithWheel(scrollport, {
        deltaX: 0,
        deltaY: 120,
        shiftKey: false,
        preventDefault: () => {
          prevented = true;
        },
      }),
    ).toBe(false);
    expect(scrollport.scrollLeft).toBe(0);
    expect(prevented).toBe(false);
  });
});

/**
 * VC-288. Shift+wheel was the whole of how a clipped tab was reached: no
 * pointer affordance, and nothing at all for a keyboard — a strip could put the
 * SELECTED tab out of view and leave it there, which at a narrow pane is most
 * of the time.
 */
describe("tabScrollLeftFor", () => {
  /** A 300px window over a 900px strip, parked at the left edge. */
  const port = { clientWidth: 300, scrollWidth: 900, scrollLeft: 0 };

  it("leaves a tab that is already whole in view alone", () => {
    // `null` is "nothing to do", and it matters: a scroll written on every
    // render would fight a person's own drag of the strip.
    expect(tabScrollLeftFor(port, { left: 0, width: 100 })).toBeNull();
    expect(tabScrollLeftFor(port, { left: 120, width: 100 })).toBeNull();
    // Flush against the right edge, inset and all.
    expect(tabScrollLeftFor(port, { left: 300 - 100 - TAB_REVEAL_INSET, width: 100 })).toBeNull();
  });

  it("brings a tab clipped on the right just inside the edge", () => {
    // 420 + 100 = 520, past the 300px window: scroll so its right edge lands an
    // inset short of the port's, which leaves the neighbour beyond it half
    // drawn and therefore visibly there.
    expect(tabScrollLeftFor(port, { left: 420, width: 100 })).toBe(
      420 + 100 + TAB_REVEAL_INSET - 300,
    );
  });

  it("brings a tab clipped on the left back to the same inset", () => {
    const scrolled = { ...port, scrollLeft: 500 };
    expect(tabScrollLeftFor(scrolled, { left: 420, width: 100 })).toBe(420 - TAB_REVEAL_INSET);
  });

  it("never asks for a scroll position the strip does not have", () => {
    // The first tab cannot be revealed at a negative offset, and the last one
    // cannot be revealed past the end — both would leave the strip parked
    // against a rubber band on the platforms that have one.
    expect(tabScrollLeftFor({ ...port, scrollLeft: 200 }, { left: 0, width: 100 })).toBe(0);
    expect(tabScrollLeftFor(port, { left: 800, width: 100 })).toBe(600);
  });

  it("shows the START of a tab too wide for the window", () => {
    // A 400px tab in a 300px port cannot be whole in view. Its left edge is
    // the readable end: that is where the label and the status dot are.
    expect(tabScrollLeftFor({ ...port, scrollLeft: 0 }, { left: 350, width: 400 })).toBe(
      350 - TAB_REVEAL_INSET,
    );
  });
});

describe("tabOverflow", () => {
  it("says a short strip has nothing to reach", () => {
    expect(tabOverflow({ clientWidth: 300, scrollWidth: 300, scrollLeft: 0 })).toEqual({
      overflowing: false,
      atStart: true,
      atEnd: true,
    });
  });

  it("names which end is out of view, so only the live affordance is drawn", () => {
    const port = { clientWidth: 300, scrollWidth: 900, scrollLeft: 0 };
    expect(tabOverflow(port)).toEqual({ overflowing: true, atStart: true, atEnd: false });
    expect(tabOverflow({ ...port, scrollLeft: 300 })).toEqual({
      overflowing: true,
      atStart: false,
      atEnd: false,
    });
    expect(tabOverflow({ ...port, scrollLeft: 600 })).toEqual({
      overflowing: true,
      atStart: false,
      atEnd: true,
    });
  });

  it("treats a sub-pixel remainder as arrived", () => {
    // Browsers hand back fractional scroll offsets at fractional zoom levels
    // (125%, 150% — exactly the ones this ticket is about), so an exact
    // comparison leaves a chevron lit that scrolls nowhere.
    expect(tabOverflow({ clientWidth: 300, scrollWidth: 900, scrollLeft: 599.6 }).atEnd).toBe(true);
    expect(tabOverflow({ clientWidth: 300, scrollWidth: 900, scrollLeft: 0.4 }).atStart).toBe(true);
  });
});

describe("tabScrollStep", () => {
  it("travels most of a window, so one press overlaps the last", () => {
    const port = { clientWidth: 300, scrollWidth: 900, scrollLeft: 300 };
    // Not a whole window: a press that scrolled exactly 300px would leave no
    // tab in common between the two views, which is how a person loses their
    // place in a list they are scanning.
    expect(tabScrollStep(port, "next")).toBe(540);
    expect(tabScrollStep(port, "prev")).toBe(60);
  });

  it("stops at both ends rather than overshooting them", () => {
    const port = { clientWidth: 300, scrollWidth: 400, scrollLeft: 0 };
    expect(tabScrollStep(port, "next")).toBe(100);
    expect(tabScrollStep({ ...port, scrollLeft: 100 }, "prev")).toBe(0);
  });
});
