import { describe, expect, it } from "vite-plus/test";

import {
  FOLLOW_ZONE_PX,
  followingAfterScroll,
  followingOnLift,
  followingSettled,
  keyScrollsUp,
  scrollPlace,
  thumbMoved,
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

describe("followingAfterScroll", () => {
  it("is the library's own zone", () => {
    expect(FOLLOW_ZONE_PX).toBe(70);
  });

  it("follows a reader who arrives within the zone, at any distance inside it", () => {
    for (const hand of ["none", "direct"] as const) {
      for (const fromEnd of [0, 10, 18, 40, 69, 70]) {
        expect(followingAfterScroll(at(9_000, 400), at(9_400 - fromEnd, fromEnd), hand)).toBe(
          "follow",
        );
      }
    }
  });

  it("does not follow a reader who stops outside the zone", () => {
    expect(followingAfterScroll(at(9_000, 400), at(9_329, 71), "none")).toBeNull();
    expect(followingAfterScroll(at(9_000, 400), at(9_310, 90), "none")).toBeNull();
  });

  it("counts a move nearer the end even when anchoring lowered scrollTop on the way", () => {
    // Down 30, while a block above shrank 46: scrollTop drops, the end is nearer.
    expect(followingAfterScroll(at(9_000, 60), at(8_984, 30), "none")).toBe("follow");
  });

  it("counts a scrollTop that grew, with no hand, even when a line landed below in the same frame", () => {
    // Down 10, while the reply added 18: the end is further, the reader moved toward it.
    expect(followingAfterScroll(at(9_000, 40), at(9_010, 48), "none")).toBe("follow");
  });

  it("does not count a scrollTop that grew under a key that scrolls up", () => {
    // The library's write to the end and the key's first step, in one event.
    expect(followingAfterScroll(at(9_000, 1), at(9_028, 7), "direct")).toBeNull();
  });

  it("follows a thumb taken to the end, and releases one moved away by its share of the range", () => {
    expect(followingAfterScroll(at(9_000, 300), at(9_300, 0), "thumb")).toBe("follow");
    expect(followingAfterScroll(at(9_000, 300), at(9_299, 1), "thumb")).toBe("follow");
    // Dragged up: the share shrinks.
    expect(followingAfterScroll(at(9_000, 1), at(8_900, 101), "thumb")).toBe("release");
    // Held at the end while lines land: nothing changes.
    expect(followingAfterScroll(at(9_000, 0), at(9_018, 0), "thumb")).toBeNull();
    // An empty range has no share to keep.
    expect(followingAfterScroll(at(0, 0), at(0, 0), "thumb")).toBeNull();
  });

  it("leaves a thumb that stops short of the end to its lift", () => {
    // Dragged down into the zone.
    expect(followingAfterScroll(at(9_000, 300), at(9_282, 18), "thumb")).toBeNull();
    // Keeping its place as the reply grows: scrollTop and distance both move.
    expect(followingAfterScroll(at(9_000, 1_000), at(9_018, 1_002), "thumb")).toBeNull();
    // Keeping its place after another event already read the longer range.
    expect(followingAfterScroll(at(10_727, 86), at(10_744, 69), "thumb")).toBeNull();
  });

  it("releases a reader whose own hand scrolls away from the end", () => {
    expect(followingAfterScroll(at(9_000, 1), at(8_960, 41), "direct")).toBe("release");
    // Away and a line added in the same frame.
    expect(followingAfterScroll(at(9_000, 1), at(8_960, 59), "direct")).toBe("release");
  });

  it("leaves following alone when nothing of the reader's moved it away", () => {
    // Anchoring: a block above shrank, the end is as far as it was.
    expect(followingAfterScroll(at(9_000, 1), at(8_954, 1), "direct")).toBeNull();
    // A line below grew the distance with no scroll up.
    expect(followingAfterScroll(at(9_000, 1), at(9_000, 19), "direct")).toBeNull();
    // Anchoring and a line below in one frame look like a scroll up, without a hand.
    expect(followingAfterScroll(at(9_000, 1), at(8_954, 19), "none")).toBeNull();
  });

  it("ignores sub-pixel rounding", () => {
    expect(followingAfterScroll(at(9_000, 40), at(9_000.4, 39.6), "none")).toBeNull();
    expect(followingAfterScroll(at(9_000, 40), at(8_999.6, 40.4), "direct")).toBeNull();
  });
});

const settle = (
  change: FollowingChange,
  hand: ReaderHand,
  wasFollowing: boolean,
  following: boolean,
) => followingSettled({ change, hand, wasFollowing, following });

describe("thumbMoved", () => {
  it("tells a moved thumb from one keeping its share of a longer range", () => {
    expect(thumbMoved(at(9_000, 1_000), at(9_018, 1_002))).toBe(false);
    expect(thumbMoved(at(9_000, 1_000), at(9_100, 900))).toBe(true);
    expect(thumbMoved(at(9_000, 1_000), at(8_900, 1_100))).toBe(true);
  });
});

describe("followingOnLift", () => {
  it("follows a thumb brought down and let go within the zone", () => {
    expect(followingOnLift(at(8_000, 1_000), at(9_000, 0))).toBe("follow");
    expect(followingOnLift(at(8_000, 1_000), at(8_930, 70))).toBe("follow");
  });

  it("leaves a thumb let go outside the zone, or taken up into it", () => {
    expect(followingOnLift(at(8_000, 1_000), at(8_929, 71))).toBeNull();
    // Up 40 from the end: within the zone, but the reader went up.
    expect(followingOnLift(at(9_000, 1), at(8_960, 41))).toBeNull();
  });
});

describe("followingSettled", () => {
  it("follows an arrival the library discarded, and leaves one it took", () => {
    expect(settle("follow", "none", false, false)).toBe("follow");
    expect(settle("follow", "none", false, true)).toBeNull();
  });

  it("releases again when the library undid a release", () => {
    expect(settle("release", "direct", true, true)).toBe("release");
    expect(settle("release", "direct", true, false)).toBeNull();
  });

  it("undoes the library's re-attach on a move under a hand that was not toward the end", () => {
    expect(settle(null, "thumb", false, true)).toBe("release");
    expect(settle(null, "direct", false, true)).toBe("release");
    // Already following before the event: nothing was re-attached.
    expect(settle(null, "thumb", true, true)).toBeNull();
    expect(settle(null, "thumb", false, false)).toBeNull();
  });

  it("leaves the library's own re-attach alone with no hand", () => {
    expect(settle(null, "none", false, true)).toBeNull();
  });
});

const press = (key: string, more: Partial<ScrollKey> = {}) =>
  keyScrollsUp({ key, shiftKey: false, inTextEntry: false, onControl: false, ...more });

describe("keyScrollsUp", () => {
  it("is the keys that scroll toward the start", () => {
    expect(press("ArrowUp")).toBe(true);
    expect(press("PageUp")).toBe(true);
    expect(press("Home")).toBe(true);
    expect(press(" ", { shiftKey: true })).toBe(true);
  });

  it("is not a key that scrolls toward the end, or does not scroll", () => {
    for (const key of ["ArrowDown", "PageDown", "End", " ", "a", "Enter"]) {
      expect(press(key)).toBe(false);
    }
  });

  it("is not a key typed into a field, or Space pressing a control", () => {
    expect(press("ArrowUp", { inTextEntry: true })).toBe(false);
    expect(press(" ", { shiftKey: true, onControl: true })).toBe(false);
    expect(press("ArrowUp", { onControl: true })).toBe(true);
  });
});
