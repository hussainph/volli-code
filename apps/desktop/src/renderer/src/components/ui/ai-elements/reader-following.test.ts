import { describe, expect, it } from "vite-plus/test";

import {
  FOLLOW_ZONE_PX,
  foldJudgement,
  followingAfterScroll,
  followingOnLift,
  followingSettled,
  keyHand,
  placeBefore,
  scrollPlace,
  thumbMoved,
  wheelHand,
  type FollowingChange,
  type ReaderHand,
  type ScrollKey,
  type ScrollPlace,
} from "./reader-following";

const at = (top: number, fromEnd: number): ScrollPlace => ({ top, fromEnd });

describe("scrollPlace", () => {
  it("measures the distance to the end from the scroll element", () => {
    expect(scrollPlace({ scrollTop: 9_000, scrollHeight: 10_000, clientHeight: 800 })).toEqual({
      top: 9_000,
      fromEnd: 200,
    });
  });
});

describe("placeBefore", () => {
  const geometry = { scrollTop: 9_188, scrollHeight: 10_000, clientHeight: 800 };

  it("is the previous place when no write of the library's is pending, or this event is it", () => {
    expect(placeBefore(at(9_000, 200), undefined, geometry)).toEqual(at(9_000, 200));
    expect(placeBefore(at(9_000, 200), 9_188, geometry)).toEqual(at(9_000, 200));
  });

  it("starts a step that shared its event with the library's write at that write", () => {
    // The library wrote the end (9,199); the reader's wheel took 11 off it.
    expect(placeBefore(at(9_000, 200), 9_199, geometry)).toEqual(at(9_199, 1));
  });
});

describe("followingAfterScroll", () => {
  it("is the library's own zone", () => {
    expect(FOLLOW_ZONE_PX).toBe(70);
  });

  it("follows a reader who arrives within the zone, at any distance inside it", () => {
    for (const hand of ["none", "down", "up", "direct"] as const) {
      for (const fromEnd of [0, 10, 18, 40, 69, 70, 71]) {
        expect(followingAfterScroll(at(9_000, 400), at(9_400 - fromEnd, fromEnd), hand)).toBe(
          "follow",
        );
      }
    }
  });

  it("does not follow a reader who stops outside the zone", () => {
    // The library's end is a pixel above the true one: 70 from there is 71 from the true end.
    expect(followingAfterScroll(at(9_000, 400), at(9_328, 72), "none")).toBeNull();
    expect(followingAfterScroll(at(9_000, 400), at(9_310, 90), "down")).toBeNull();
    expect(followingAfterScroll(at(9_000, 400), at(9_310, 90), "up")).toBeNull();
  });

  it("counts a move nearer the end even when anchoring lowered scrollTop on the way", () => {
    // Down 30, while a block above shrank 46: scrollTop drops, the end is nearer.
    expect(followingAfterScroll(at(9_000, 60), at(8_984, 30), "none")).toBe("follow");
  });

  it("counts a scrollTop that grew under a hand going down, even with a line landing below", () => {
    // Down 10, while the reply added 18: the end is further, the reader moved toward it.
    expect(followingAfterScroll(at(9_000, 40), at(9_010, 48), "down")).toBe("follow");
  });

  it("does not take content growing above a reader for a move, with no hand or another", () => {
    // A row above grew 60 and anchoring raised scrollTop by as much.
    for (const hand of ["none", "up", "direct", "select"] as const) {
      expect(followingAfterScroll(at(9_000, 40), at(9_060, 40), hand)).toBeNull();
    }
  });

  it("never follows under a pointer held in the transcript, or the transcript's own release", () => {
    // A selection auto-scrolling into the zone.
    expect(followingAfterScroll(at(9_000, 400), at(9_390, 10), "select")).toBeNull();
    // A jump to a message near the end, just after the transcript let go.
    expect(followingAfterScroll(at(9_000, 400), at(9_390, 10), "app")).toBeNull();
    // A scroll no input announces, moments after a wheel up, still arrives.
    expect(followingAfterScroll(at(9_000, 400), at(9_390, 10), "up")).toBe("follow");
  });

  it("releases a reader whose hand scrolls away from the end", () => {
    for (const hand of ["up", "direct", "select", "app"] as const) {
      expect(followingAfterScroll(at(9_000, 1), at(8_960, 41), hand)).toBe("release");
      // Away and a line added in the same frame.
      expect(followingAfterScroll(at(9_000, 1), at(8_960, 59), hand)).toBe("release");
    }
  });

  it("does not release without a hand that can leave", () => {
    // Anchoring and a line below in one frame look like a scroll up.
    expect(followingAfterScroll(at(9_000, 1), at(8_954, 19), "none")).toBeNull();
    expect(followingAfterScroll(at(9_000, 1), at(8_954, 19), "down")).toBeNull();
    // Anchoring alone: a block above shrank, the end is as far as it was.
    expect(followingAfterScroll(at(9_000, 1), at(8_954, 1), "up")).toBeNull();
  });

  it("ignores sub-pixel rounding", () => {
    expect(followingAfterScroll(at(9_000, 40), at(9_000.4, 39.6), "down")).toBeNull();
    expect(followingAfterScroll(at(9_000, 40), at(8_999.6, 40.4), "up")).toBeNull();
  });

  it("follows a thumb taken to the end, and releases one moved away by its share of the range", () => {
    expect(followingAfterScroll(at(9_000, 300), at(9_300, 0), "thumb")).toBe("follow");
    expect(followingAfterScroll(at(9_000, 300), at(9_299, 1), "thumb")).toBe("follow");
    expect(followingAfterScroll(at(9_000, 1), at(8_900, 101), "thumb")).toBe("release");
    // Held at the end while lines land: nothing changes.
    expect(followingAfterScroll(at(9_000, 0), at(9_018, 0), "thumb")).toBeNull();
    // An empty range has no share to keep.
    expect(followingAfterScroll(at(0, 0), at(0, 0), "thumb")).toBeNull();
  });

  it("leaves a thumb that stops short of the end to its lift", () => {
    expect(followingAfterScroll(at(9_000, 300), at(9_282, 18), "thumb")).toBeNull();
    // Keeping its place as the reply grows: scrollTop and distance both move.
    expect(followingAfterScroll(at(9_000, 1_000), at(9_018, 1_002), "thumb")).toBeNull();
    // Keeping its place after another event already read the longer range.
    expect(followingAfterScroll(at(10_727, 86), at(10_744, 69), "thumb")).toBeNull();
  });
});

describe("thumbMoved", () => {
  it("tells a moved thumb from one keeping its share of a longer range", () => {
    expect(thumbMoved(at(9_000, 1_000), at(9_018, 1_002))).toBe(false);
    expect(thumbMoved(at(9_000, 1_000), at(9_100, 900))).toBe(true);
    expect(thumbMoved(at(9_000, 1_000), at(8_900, 1_100))).toBe(true);
  });
});

describe("followingOnLift", () => {
  it("follows a thumb brought down and let go within the zone", () => {
    const grabbed = at(8_000, 1_000);
    expect(followingOnLift(grabbed, at(9_000, 0), at(9_000, 0))).toBe("follow");
    expect(followingOnLift(grabbed, at(8_930, 70), at(8_930, 70))).toBe("follow");
    // Its last write is in the scroller but not yet in a scroll event.
    expect(followingOnLift(grabbed, at(8_800, 200), at(8_980, 20))).toBe("follow");
    // A line landed after its last move.
    expect(followingOnLift(grabbed, at(8_960, 40), at(8_960, 76))).toBe("follow");
  });

  it("leaves a thumb let go outside the zone, or taken up into it", () => {
    expect(followingOnLift(at(8_000, 1_000), at(8_928, 72), at(8_928, 72))).toBeNull();
    // Up 40 from the end: within the zone, but the reader went up.
    expect(followingOnLift(at(9_000, 1), at(8_960, 41), at(8_960, 41))).toBeNull();
  });
});

describe("foldJudgement", () => {
  it("takes the first waiting judgement as it is", () => {
    const first = { change: "follow" as const, hand: "none" as const, wasFollowing: false };
    expect(foldJudgement(null, first)).toBe(first);
  });

  it("lets a newer decision win, and a newer non-decision leave the older one", () => {
    const arrived = { change: "follow" as const, hand: "thumb" as const, wasFollowing: false };
    expect(foldJudgement(arrived, { change: "release", hand: "up", wasFollowing: true })).toEqual({
      change: "release",
      hand: "up",
      wasFollowing: false,
    });
    expect(foldJudgement(arrived, { change: null, hand: "thumb", wasFollowing: true })).toEqual({
      change: "follow",
      hand: "thumb",
      wasFollowing: false,
    });
  });
});

const settle = (
  change: FollowingChange,
  hand: ReaderHand,
  wasFollowing: boolean,
  following: boolean,
) => followingSettled({ change, hand, wasFollowing, following });

describe("followingSettled", () => {
  it("follows an arrival the library discarded, and leaves one it took", () => {
    expect(settle("follow", "none", false, false)).toBe("follow");
    expect(settle("follow", "none", false, true)).toBeNull();
  });

  it("releases again when the library undid a release", () => {
    expect(settle("release", "up", true, true)).toBe("release");
    expect(settle("release", "up", true, false)).toBeNull();
  });

  it("undoes a release the library made with no hand, or a hand going down", () => {
    // Anchoring, or the window swapping a row, read as the reader leaving.
    expect(settle(null, "none", true, false)).toBe("follow");
    expect(settle(null, "down", true, false)).toBe("follow");
  });

  it("lets a release the library made under a hand that can leave stand", () => {
    for (const hand of ["up", "direct", "select", "thumb", "app"] as const) {
      expect(settle(null, hand, true, false)).toBeNull();
    }
  });

  it("undoes the library's re-attach under a hand that was not going down", () => {
    for (const hand of ["up", "direct", "select", "thumb", "app"] as const) {
      expect(settle(null, hand, false, true)).toBe("release");
    }
  });

  it("lets the library's own re-attach stand with no hand or a hand going down", () => {
    expect(settle(null, "none", false, true)).toBeNull();
    expect(settle(null, "down", false, true)).toBeNull();
  });

  it("changes nothing when nothing changed", () => {
    expect(settle(null, "up", true, true)).toBeNull();
    expect(settle(null, "none", false, false)).toBeNull();
  });
});

const press = (key: string, more: Partial<ScrollKey> = {}) =>
  keyHand({ key, shiftKey: false, inTextEntry: false, onControl: false, ...more });

describe("keyHand", () => {
  it("is up for the keys that scroll toward the start", () => {
    expect(press("ArrowUp")).toBe("up");
    expect(press("PageUp")).toBe("up");
    expect(press("Home")).toBe("up");
    expect(press(" ", { shiftKey: true })).toBe("up");
  });

  it("is down for the keys that scroll toward the end", () => {
    expect(press("ArrowDown")).toBe("down");
    expect(press("PageDown")).toBe("down");
    expect(press("End")).toBe("down");
    expect(press(" ")).toBe("down");
  });

  it("is either way for Tab, whose focus scrolls into view", () => {
    expect(press("Tab")).toBe("direct");
  });

  it("is none for a key typed into a field, Space pressing a control, or a key that does not scroll", () => {
    expect(press("ArrowUp", { inTextEntry: true })).toBe("none");
    expect(press(" ", { shiftKey: true, onControl: true })).toBe("none");
    expect(press("a")).toBe("none");
    expect(press("Enter")).toBe("none");
    expect(press("ArrowUp", { onControl: true })).toBe("up");
  });
});

describe("wheelHand", () => {
  it("is the wheel's direction, and nothing for a sideways wheel", () => {
    expect(wheelHand(100)).toBe("down");
    expect(wheelHand(-4)).toBe("up");
    expect(wheelHand(0)).toBe("none");
  });
});
