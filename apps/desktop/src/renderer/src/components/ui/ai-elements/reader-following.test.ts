import { describe, expect, it } from "vite-plus/test";

import {
  FOLLOW_ZONE_PX,
  followingAfterScroll,
  keyScrollsUp,
  scrollPlace,
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
    for (const fromEnd of [0, 10, 18, 40, 69, 70]) {
      expect(followingAfterScroll(at(9_000, 400), at(9_400 - fromEnd, fromEnd), "none")).toBe(
        "follow",
      );
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

  it("counts a scrollTop that grew even when a line landed below in the same frame", () => {
    // Down 10, while the reply added 18: the end is further, the reader moved toward it.
    expect(followingAfterScroll(at(9_000, 40), at(9_010, 48), "none")).toBe("follow");
  });

  it("does not take a held thumb keeping its place as the reply grows for a move nearer", () => {
    // The drag rewrites scrollTop for the thumb's share of a longer range.
    expect(followingAfterScroll(at(9_000, 40), at(9_010, 48), "holding")).toBeNull();
    // A drag that does bring the end nearer still arrives.
    expect(followingAfterScroll(at(9_000, 300), at(9_300, 18), "holding")).toBe("follow");
  });

  it("releases a reader whose own hand scrolls away from the end", () => {
    expect(followingAfterScroll(at(9_000, 1), at(8_900, 101), "holding")).toBe("release");
    expect(followingAfterScroll(at(9_000, 1), at(8_960, 41), "recent")).toBe("release");
    // Away and a line added in the same frame.
    expect(followingAfterScroll(at(9_000, 1), at(8_960, 59), "recent")).toBe("release");
  });

  it("leaves following alone when nothing of the reader's moved it away", () => {
    // Anchoring: a block above shrank, the end is as far as it was.
    expect(followingAfterScroll(at(9_000, 1), at(8_954, 1), "recent")).toBeNull();
    // Anchoring and a line below in one frame look like a scroll up, without a hand.
    expect(followingAfterScroll(at(9_000, 1), at(8_954, 19), "none")).toBeNull();
  });

  it("ignores sub-pixel rounding", () => {
    expect(followingAfterScroll(at(9_000, 40), at(9_000.4, 39.6), "none")).toBeNull();
    expect(followingAfterScroll(at(9_000, 40), at(8_999.6, 40.4), "recent")).toBeNull();
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
