import { describe, expect, it, vi } from "vite-plus/test";

import {
  type ContentMotionJourney,
  type ContentMotionState,
  isContentMoving,
  MIN_TRAVEL_PX,
  planContentMotion,
} from "./content-motion";

/** The panel width the shell's own arithmetic produces at the default size. */
const TRAVEL = 250;

/** A settled, pinned shell — the state every case below deviates from. */
const DOCKED: ContentMotionState = {
  pinned: true,
  target: true,
  layoutPinned: true,
  instant: false,
  journey: null,
  closingFrom: null,
};

function state(overrides: Partial<ContentMotionState>): ContentMotionState {
  return { ...DOCKED, ...overrides };
}

const travelling = (targetPinned: boolean): ContentMotionJourney => ({
  targetPinned,
  settling: false,
});
const settling = (targetPinned: boolean): ContentMotionJourney => ({
  targetPinned,
  settling: true,
});

/** A measurement that records whether the plan needed to force layout at all. */
function measurer(measurement = { travel: TRAVEL, at: 0 }) {
  return vi.fn(() => measurement);
}

describe("planContentMotion — the passes that must not force layout", () => {
  it("holds without measuring when the surface is already where it was asked to be", () => {
    const measure = measurer();
    expect(planContentMotion(DOCKED, measure)).toEqual({ kind: "hold" });
    expect(measure).not.toHaveBeenCalled();
  });

  it("holds without measuring while a journey it already started is running", () => {
    const measure = measurer();
    const plan = planContentMotion(
      state({ pinned: true, target: true, layoutPinned: false, journey: travelling(true) }),
      measure,
    );
    expect(plan).toEqual({ kind: "hold" });
    expect(measure).not.toHaveBeenCalled();
  });

  it("settles at the endpoint without measuring when an escape hatch is holding", () => {
    const measure = measurer();
    const plan = planContentMotion(
      state({ pinned: false, target: true, layoutPinned: true, instant: true }),
      measure,
    );
    expect(plan).toEqual({ kind: "settle", layoutPinned: false });
    expect(measure).not.toHaveBeenCalled();
  });

  it("settles a hatch that arrives mid-journey, whatever the journey was doing", () => {
    expect(
      planContentMotion(
        state({
          pinned: true,
          target: true,
          layoutPinned: false,
          instant: true,
          journey: travelling(true),
        }),
        measurer(),
      ),
    ).toEqual({ kind: "settle", layoutPinned: true });
  });
});

describe("planContentMotion — an ordinary open", () => {
  it("travels the full width from rest, keeping the unpinned layout", () => {
    const plan = planContentMotion(
      state({ pinned: true, target: false, layoutPinned: false }),
      measurer(),
    );
    expect(plan).toEqual({ kind: "animate", from: 0, to: TRAVEL });
  });

  it("releases the held transform once the layout has caught up", () => {
    const plan = planContentMotion(
      state({ pinned: true, target: true, layoutPinned: true, journey: settling(true) }),
      measurer(),
    );
    expect(plan).toEqual({ kind: "clear-fill" });
  });

  it("keeps holding the transform while the layout has NOT caught up yet", () => {
    // The commit between `onfinish` and React's state flush: the fill is the
    // only thing keeping the surface at the endpoint, so it must stay.
    const plan = planContentMotion(
      state({ pinned: true, target: true, layoutPinned: false, journey: settling(true) }),
      measurer(),
    );
    expect(plan).toEqual({ kind: "hold" });
  });
});

describe("planContentMotion — an ordinary close", () => {
  it("gives the wide layout back first, under an equal translate", () => {
    const plan = planContentMotion(
      state({ pinned: false, target: true, layoutPinned: true }),
      measurer(),
    );
    expect(plan).toEqual({ kind: "release-layout", from: TRAVEL });
  });

  it("then walks the parked translate back to zero", () => {
    const plan = planContentMotion(
      state({ pinned: false, target: false, layoutPinned: false, closingFrom: TRAVEL }),
      measurer(),
    );
    expect(plan).toEqual({ kind: "animate", from: TRAVEL, to: 0 });
  });
});

describe("planContentMotion — reversals", () => {
  it("picks a reversing open up from where the compositor actually has it", () => {
    const plan = planContentMotion(
      state({ pinned: false, target: true, layoutPinned: false, journey: travelling(true) }),
      measurer({ travel: TRAVEL, at: 120 }),
    );
    expect(plan).toEqual({ kind: "animate", from: 120, to: 0 });
  });

  it("picks a reversing close up from its live position too", () => {
    const plan = planContentMotion(
      state({ pinned: true, target: false, layoutPinned: false, journey: travelling(false) }),
      measurer({ travel: TRAVEL, at: 90 }),
    );
    expect(plan).toEqual({ kind: "animate", from: 90, to: TRAVEL });
  });

  it("does not release a layout out from under a live closing journey", () => {
    // `release-layout` already ran for this close; running it again would reset
    // `closingFrom` and restart the journey from the far end.
    const plan = planContentMotion(
      state({ pinned: false, target: true, layoutPinned: true, journey: travelling(false) }),
      measurer({ travel: TRAVEL, at: 200 }),
    );
    expect(plan).toEqual({ kind: "animate", from: 200, to: 0 });
  });
});

describe("planContentMotion — the stranded-state trap", () => {
  /*
   * The reachable sequence, by hand: an open finishes, so its record is
   * `settling` and `layoutPinned` is true. In that same React commit the user
   * presses ⌘B again. Reading the settling record as a LIVE journey made this
   * close skip `release-layout`, animate back to zero with the spacer still
   * reserving a panel width, and finish with no layout left to release — a
   * permanent phantom gutter that no further input could clear.
   */
  it("treats a landed opening's held fill as walkable, not as a live journey", () => {
    const plan = planContentMotion(
      state({ pinned: false, target: true, layoutPinned: true, journey: settling(true) }),
      measurer({ travel: TRAVEL, at: TRAVEL }),
    );
    expect(plan).toEqual({ kind: "release-layout", from: TRAVEL });
  });

  it("then animates that release home from the position the fill was holding", () => {
    const plan = planContentMotion(
      state({
        pinned: false,
        target: false,
        layoutPinned: false,
        journey: settling(true),
        closingFrom: TRAVEL,
      }),
      measurer({ travel: TRAVEL, at: TRAVEL }),
    );
    expect(plan).toEqual({ kind: "animate", from: TRAVEL, to: 0 });
  });
});

describe("planContentMotion — geometry with nothing to say", () => {
  it("settles rather than animating a panel that has no width yet", () => {
    // First layout pass, or a window narrow enough that the two arrangements
    // coincide. `offsetWidth` is 0 before the panel is laid out at all.
    const plan = planContentMotion(
      state({ pinned: true, target: false, layoutPinned: false }),
      measurer({ travel: 0, at: 0 }),
    );
    expect(plan).toEqual({ kind: "settle", layoutPinned: true });
  });

  it("settles rather than animating a sub-pixel journey", () => {
    const plan = planContentMotion(
      state({ pinned: false, target: true, layoutPinned: false, journey: travelling(true) }),
      measurer({ travel: TRAVEL, at: MIN_TRAVEL_PX / 2 }),
    );
    expect(plan).toEqual({ kind: "settle", layoutPinned: false });
  });
});

describe("isContentMoving", () => {
  it("is true while an animation runs", () => {
    expect(isContentMoving({ animating: true, layoutPinned: true, pinned: true })).toBe(true);
  });

  it("is true in the commit where the layout and the request disagree", () => {
    // No `Animation` exists yet — this is the pass that released the layout —
    // but the surface is emphatically not where its box says it is.
    expect(isContentMoving({ animating: false, layoutPinned: true, pinned: false })).toBe(true);
  });

  it("is false once both facts agree again", () => {
    expect(isContentMoving({ animating: false, layoutPinned: false, pinned: false })).toBe(false);
  });
});
