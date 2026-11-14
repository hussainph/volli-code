import { describe, expect, it } from "vite-plus/test";

import {
  THUMB_MIN_LENGTH,
  TRACK_INSET,
  hitsThumb,
  inThumbLane,
  laneMetrics,
  overflows,
  scrollForOffset,
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
    expect(thumbRatio(300, 300, 296)).toBe(1);
    expect(thumbRatio(300, 120, 296)).toBe(1);
    expect(thumbRatio(0, 500, 0)).toBe(1);
  });

  it("is the visible share of the content, floored at the minimum drawn length", () => {
    expect(thumbRatio(200, 800, 196)).toBe(0.25);
    // 160 / 100000 would be a 0.25px thumb: the floor is 20px of a 156px track.
    expect(thumbRatio(160, 100_000, 156)).toBe(THUMB_MIN_LENGTH / 156);
  });

  it("places the thumb at the scroll progress along the track less the thumb", () => {
    // 200px box, 800px content: track 196, thumb 49, travel 147.
    const at = (scrollPos: number) =>
      laneMetrics({ clientSize: 200, scrollSize: 800, scrollPos, scale: 1 });
    expect(at(0)).toEqual({ overflow: true, track: 196, length: 49, travel: 147, offset: 0, range: 600 });
    expect(at(300).offset).toBe(73.5);
    expect(at(600).offset).toBe(147);
    // Overscroll pins it.
    expect(at(900).offset).toBe(147);
    expect(at(-20).offset).toBe(0);
    expect(laneMetrics({ clientSize: 200, scrollSize: 200, scrollPos: 10, scale: 1 })).toMatchObject({
      overflow: false,
      offset: 0,
      range: 0,
    });
  });

  it("draws in viewport px under zoom: the track spans the drawn box, the range stays content px", () => {
    // A 200px scroller under zoom 1.25 is drawn 250px tall.
    const zoomed = laneMetrics({ clientSize: 200, scrollSize: 800, scrollPos: 300, scale: 1.25 });
    expect(zoomed.track).toBe(246);
    expect(zoomed.length).toBe(61.5);
    expect(zoomed.travel).toBe(184.5);
    expect(zoomed.range).toBe(600);
    // So a pointer pixel is range / travel of content: 600 / 184.5, not 600 / 147.
    expect(scrollForOffset(zoomed.travel / 2, zoomed.travel, zoomed.range)).toBe(300);
  });

  it("maps a thumb offset back onto the content, clamped", () => {
    expect(scrollForOffset(36, 72, 300)).toBe(150);
    expect(scrollForOffset(-10, 72, 300)).toBe(0);
    expect(scrollForOffset(500, 72, 300)).toBe(300);
    expect(scrollForOffset(10, 0, 300)).toBe(0);
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
