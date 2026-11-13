import { describe, expect, it } from "vite-plus/test";

import {
  THUMB_MIN_LENGTH,
  TRACK_INSET,
  dragScrollPosition,
  hitsThumb,
  inThumbLane,
  overflows,
  thumbOffset,
  thumbRatio,
  trackLength,
} from "./geometry";

describe("scroll thumb geometry", () => {
  it("treats a sub-pixel difference as no overflow", () => {
    expect(overflows(200, 200.6)).toBe(false);
    expect(overflows(200, 201)).toBe(false);
    expect(overflows(200, 201.5)).toBe(true);
  });

  it("insets the track on both ends and never goes negative", () => {
    expect(trackLength(160)).toBe(160 - TRACK_INSET * 2);
    expect(trackLength(2)).toBe(0);
  });

  it("fills the whole track when nothing overflows", () => {
    expect(thumbRatio(300, 300)).toBe(1);
    expect(thumbRatio(300, 120)).toBe(1);
    expect(thumbRatio(0, 500)).toBe(1);
  });

  it("is the visible share of the content, floored at the minimum length", () => {
    expect(thumbRatio(200, 800)).toBe(0.25);
    // 160 / 100000 would be a 0.25px thumb: the floor is 20px of a 156px track.
    expect(thumbRatio(160, 100_000)).toBe(THUMB_MIN_LENGTH / trackLength(160));
  });

  it("places the thumb at the scroll progress along the track less the thumb", () => {
    // 200px box, 800px content: track 196, thumb 49, travel 147.
    expect(thumbOffset(0, 200, 800)).toBe(0);
    expect(thumbOffset(300, 200, 800)).toBe(73.5);
    expect(thumbOffset(600, 200, 800)).toBe(147);
    // Overscroll and nothing to scroll both pin it.
    expect(thumbOffset(900, 200, 800)).toBe(147);
    expect(thumbOffset(-20, 200, 800)).toBe(0);
    expect(thumbOffset(10, 200, 200)).toBe(0);
  });

  it("maps pointer travel onto content travel, the track less the thumb against the overflow", () => {
    // 200px box, 800px content: ratio 0.25, track 196, thumb travel 147, range 600.
    const start = { pointer: 100, scroll: 0, clientSize: 200, scrollSize: 800 };
    expect(dragScrollPosition(start, 100 + 147)).toBeCloseTo(600);
    expect(dragScrollPosition(start, 100 + 49)).toBeCloseTo(200);
    expect(dragScrollPosition({ ...start, scroll: 300 }, 100)).toBe(300);
  });

  it("clamps a drag to the scroll range", () => {
    const start = { pointer: 50, scroll: 100, clientSize: 200, scrollSize: 800 };
    expect(dragScrollPosition(start, -1000)).toBe(0);
    expect(dragScrollPosition(start, 5000)).toBe(600);
  });

  it("leaves the scroll alone when there is nothing to drag", () => {
    expect(
      dragScrollPosition({ pointer: 0, scroll: 0, clientSize: 200, scrollSize: 200 }, 80),
    ).toBe(0);
  });

  it("finds the lane along the right edge for y and the bottom edge for x", () => {
    const box = { left: 0, top: 0, right: 200, bottom: 100 };
    expect(inThumbLane(box, "y", 195, 50)).toBe(true);
    expect(inThumbLane(box, "y", 191, 50)).toBe(false);
    expect(inThumbLane(box, "y", 195, 101)).toBe(false);
    expect(inThumbLane(box, "x", 100, 96)).toBe(true);
    expect(inThumbLane(box, "x", 100, 80)).toBe(false);
  });

  it("hits only within the thumb's extent along the scroll axis", () => {
    const box = { left: 0, top: 0, right: 200, bottom: 100 };
    const thumb = { left: 193, top: 20, right: 197, bottom: 40 };
    expect(hitsThumb(box, thumb, "y", 199, 30)).toBe(true);
    expect(hitsThumb(box, thumb, "y", 199, 60)).toBe(false);
    expect(hitsThumb(box, thumb, "y", 150, 30)).toBe(false);
    const xThumb = { left: 20, top: 93, right: 60, bottom: 97 };
    expect(hitsThumb(box, xThumb, "x", 40, 99)).toBe(true);
    expect(hitsThumb(box, xThumb, "x", 80, 99)).toBe(false);
  });
});
