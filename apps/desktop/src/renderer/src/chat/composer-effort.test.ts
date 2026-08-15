import { describe, expect, it } from "vite-plus/test";

import {
  EFFORT_DEAD_ZONE,
  EFFORT_STRETCH_LIMIT,
  EFFORT_CHROMA_CEILING,
  EFFORT_CHROMA_FLOOR,
  effortChroma,
  effortIndex,
  effortLabel,
  effortStopPercent,
  readEffortPointer,
  reclampEffort,
  rubberBand,
  type EffortTrack,
} from "./composer-effort";

describe("how a level is named", () => {
  it("title-cases the wire format, including the one nobody would guess", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("minimal")).toBe("Minimal");
    expect(effortLabel("off")).toBe("Off");
  });

  it("renders a level this build does not know as itself", () => {
    // A Session pinned to a level a later build named still has to say which
    // level it is pinned to; blanking it would hide the pinning.
    expect(effortLabel("ultra")).toBe("ultra");
    expect(effortLabel("")).toBe("");
  });
});

describe("which stop a level sits on", () => {
  it("finds the level in the model's own set", () => {
    expect(effortIndex(["low", "medium", "high"], "high")).toBe(2);
  });

  it("falls to the first stop rather than reporting a stop that is not there", () => {
    expect(effortIndex(["low", "medium", "high"], "max")).toBe(0);
    expect(effortIndex([], "high")).toBe(0);
  });
});

describe("what a model change does to the level", () => {
  it("keeps a level the incoming model can actually run", () => {
    expect(reclampEffort(["low", "medium", "high"], "medium")).toBe("medium");
  });

  it("rewrites a level the incoming model would refuse", () => {
    expect(reclampEffort(["low", "medium", "high"], "xhigh")).toBe("low");
  });

  it("lands on off when the model offers nothing at all", () => {
    expect(reclampEffort([], "high")).toBe("off");
  });
});

describe("the resistance curve", () => {
  it("gives nothing at rest and keeps the direction of the pull", () => {
    expect(rubberBand(0, EFFORT_STRETCH_LIMIT)).toBe(0);
    expect(rubberBand(-30, EFFORT_STRETCH_LIMIT)).toBe(-rubberBand(30, EFFORT_STRETCH_LIMIT));
  });

  it("approaches the ceiling without ever reaching it, however hard it is pulled", () => {
    expect(rubberBand(10_000, EFFORT_STRETCH_LIMIT)).toBeLessThan(EFFORT_STRETCH_LIMIT);
    expect(rubberBand(10_000, EFFORT_STRETCH_LIMIT)).toBeGreaterThan(EFFORT_STRETCH_LIMIT * 0.99);
  });

  it("gives less and less the further it is pulled", () => {
    const first = rubberBand(20, EFFORT_STRETCH_LIMIT) - rubberBand(10, EFFORT_STRETCH_LIMIT);
    const later = rubberBand(60, EFFORT_STRETCH_LIMIT) - rubberBand(50, EFFORT_STRETCH_LIMIT);

    expect(first).toBeGreaterThan(later);
    expect(later).toBeGreaterThan(0);
  });

  it("is inert when there is no room to give — the reduced-motion setting", () => {
    expect(rubberBand(200, 0)).toBe(0);
  });
});

/** Five stops across 200px: a stop every 50px, the last one at x = 200. */
const TRACK: EffortTrack = {
  width: 200,
  stops: 5,
  deadZone: EFFORT_DEAD_ZONE,
  stretchLimit: EFFORT_STRETCH_LIMIT,
};

describe("where the pointer is on the track", () => {
  it("commits the nearest stop, not the one it has passed", () => {
    expect(readEffortPointer(0, TRACK).index).toBe(0);
    expect(readEffortPointer(74, TRACK).index).toBe(1);
    expect(readEffortPointer(76, TRACK).index).toBe(2);
    expect(readEffortPointer(200, TRACK).index).toBe(4);
  });

  it("costs nothing to overshoot either end by a hand's slop", () => {
    for (const offset of [-1, -EFFORT_DEAD_ZONE]) {
      expect(readEffortPointer(offset, TRACK)).toEqual({ index: 0, stretch: 0, scaleX: 1 });
    }
    for (const offset of [201, 200 + EFFORT_DEAD_ZONE]) {
      expect(readEffortPointer(offset, TRACK)).toEqual({ index: 4, stretch: 0, scaleX: 1 });
    }
  });

  it("stretches past the dead zone while the value stays pinned to the end", () => {
    const left = readEffortPointer(-60, TRACK);
    const right = readEffortPointer(260, TRACK);

    expect(left.index).toBe(0);
    expect(right.index).toBe(4);
    // Signed towards the pull, and the scale is that pull over the track.
    expect(left.stretch).toBeLessThan(0);
    expect(right.stretch).toBeGreaterThan(0);
    expect(left.scaleX).toBeCloseTo(1 + Math.abs(left.stretch) / TRACK.width, 10);
    expect(right.stretch).toBeCloseTo(-left.stretch, 10);
  });

  it("measures the stretch from the dead zone's edge, not from the track's", () => {
    // Otherwise the first 16px past the end would stretch and pin at once, and
    // the dead zone would only be a dead zone for the value.
    expect(readEffortPointer(-(EFFORT_DEAD_ZONE + 40), TRACK).stretch).toBeCloseTo(
      -rubberBand(40, EFFORT_STRETCH_LIMIT),
      10,
    );
  });

  it("refuses to stretch at all when the elasticity is turned off", () => {
    expect(readEffortPointer(-400, { ...TRACK, stretchLimit: 0 })).toEqual({
      index: 0,
      stretch: 0,
      scaleX: 1,
    });
  });

  it("reads a track with nothing to choose as stop zero rather than dividing by it", () => {
    expect(readEffortPointer(500, { ...TRACK, stops: 1 })).toEqual({
      index: 0,
      stretch: 0,
      scaleX: 1,
    });
    // A rail the layout has not measured yet — the first render before a
    // pointer could possibly be on it, and the divide-by-zero if it were.
    expect(readEffortPointer(500, { ...TRACK, width: 0 })).toEqual({
      index: 0,
      stretch: 0,
      scaleX: 1,
    });
  });
});

describe("how vibrant the wash is", () => {
  it("starts desaturated, ends at the accent as the canvas derived it", () => {
    expect(effortChroma(0, 5)).toBe(EFFORT_CHROMA_FLOOR);
    expect(effortChroma(4, 5)).toBe(EFFORT_CHROMA_CEILING);
  });

  it("climbs on every single stop, so no two neighbours look alike", () => {
    // The whole point: three shared values across seven stops would leave four
    // adjacent pairs indistinguishable, which is the complaint being answered.
    const seven = [0, 1, 2, 3, 4, 5, 6].map((at) => effortChroma(at, 7));

    for (let at = 1; at < seven.length; at += 1) {
      expect(seven[at]).toBeGreaterThan(seven[at - 1] ?? 0);
    }
  });

  it("never leaves the ramp, whatever index it is handed", () => {
    expect(effortChroma(-4, 5)).toBe(EFFORT_CHROMA_FLOOR);
    expect(effortChroma(99, 5)).toBe(EFFORT_CHROMA_CEILING);
  });

  it("gives a single-stop set the full accent rather than the floor", () => {
    // One stop is not a ramp: there is nothing to be less vibrant *than*, and a
    // lone control drawn at the dimmest end would read as disabled.
    expect(effortChroma(0, 1)).toBe(EFFORT_CHROMA_CEILING);
  });
});

describe("where a stop is drawn", () => {
  it("puts the ends on the track's own ends and the rest in between", () => {
    expect(effortStopPercent(0, 5)).toBe(0);
    expect(effortStopPercent(2, 5)).toBe(50);
    expect(effortStopPercent(4, 5)).toBe(100);
  });

  it("never draws off the track, whatever it is handed", () => {
    expect(effortStopPercent(9, 5)).toBe(100);
    expect(effortStopPercent(-3, 5)).toBe(0);
    expect(effortStopPercent(0, 1)).toBe(0);
  });
});
