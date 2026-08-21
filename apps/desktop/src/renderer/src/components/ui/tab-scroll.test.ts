import { describe, expect, it } from "vite-plus/test";

import { scrollTabsWithWheel, tabWheelScrollDelta } from "./tab-scroll";

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
