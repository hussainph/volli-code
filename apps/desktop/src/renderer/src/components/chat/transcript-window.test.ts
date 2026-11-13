/**
 * What the transcript mounts, and what it forgets (VC-338).
 *
 * The arithmetic is small and the consequence is not: an off-by-one in the
 * anchor clamp is a transcript that ends before its newest turn, and a window
 * measured from the end rather than from a row is one that walks out from under
 * a reader while the Session streams.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  fillHeld,
  forgetTranscriptViews,
  landingHeld,
  readTranscriptView,
  rememberTranscriptView,
  TRANSCRIPT_PAGE_ROWS,
  TRANSCRIPT_FILL_ROWS,
  TRANSCRIPT_LANDING_ROWS,
  TRANSCRIPT_TAIL_ROWS,
  transcriptWindow,
} from "./transcript-window";

/** What a 1200-row window anchored at `anchor` keeps of `held`. */
const whole = (held: { start: number; end: number }, anchor = 100) =>
  transcriptWindow(1200, anchor, 60, 40, held).held;

describe("rows a far jump holds back (VC-1226)", () => {
  it("keeps a hold inside an anchored window", () => {
    const shown = transcriptWindow(1200, 0, 60, 40, { start: 40, end: 1140 });
    expect(shown).toEqual({
      start: 0,
      earlier: 0,
      earlierStart: -1,
      held: { start: 40, end: 1140 },
    });
    expect(transcriptWindow(1200, 300, 60, 40, { start: 340, end: 1140 }).held).toEqual({
      start: 340,
      end: 1140,
    });
  });

  it("mounts the window whole when the hold does not fit inside it", () => {
    // No anchor: the tail never holds rows back.
    expect(whole({ start: 40, end: 1140 }, -1)).toBeNull();
    // A retired key resolves to -1 at either end.
    expect(whole({ start: -1, end: 1140 })).toBeNull();
    expect(whole({ start: 140, end: -1 })).toBeNull();
    // Starting at or above the window's first row: nothing above it may be hidden.
    expect(whole({ start: 100, end: 1140 })).toBeNull();
    // A closed range, and one that would hide the last row.
    expect(whole({ start: 140, end: 140 })).toBeNull();
    expect(whole({ start: 140, end: 1200 })).toBeNull();
  });

  it("lands a far jump with one page and holds the rest down to the mounted rows", () => {
    // Window at rest on the tail of 1200 rows: start 1140, nothing held.
    expect(landingHeld(0, { start: 1140, held: null }, 40)).toEqual({ start: 40, end: 1140 });
    expect(landingHeld(600, { start: 1140, held: null }, 40)).toEqual({ start: 640, end: 1140 });
  });

  it("holds nothing when the landing reaches the mounted rows", () => {
    expect(landingHeld(1100, { start: 1140, held: null }, 40)).toBeNull();
    expect(landingHeld(1120, { start: 1140, held: null }, 40)).toBeNull();
  });

  it("keeps a hold when a jump lands just above the window's first rows", () => {
    // Mounted 300-340 and 1140 on; a jump to 280 runs into the first rows.
    const shown = { start: 300, held: { start: 340, end: 1140 } };
    expect(landingHeld(280, shown, 40)).toEqual({ start: 340, end: 1140 });
  });

  it("gives up the first rows when a jump lands far above them or inside the hold", () => {
    const shown = { start: 300, held: { start: 340, end: 1140 } };
    expect(landingHeld(0, shown, 40)).toEqual({ start: 40, end: 1140 });
    expect(landingHeld(700, shown, 40)).toEqual({ start: 740, end: 1140 });
    // Inside the hold, near enough to its end to mount the rest.
    expect(landingHeld(1110, shown, 40)).toBeNull();
  });

  it("fills a page at a time from the top and closes on the mounted rows", () => {
    expect(fillHeld({ start: 40, end: 1140 }, false, 40)).toEqual({ start: 80, end: 1140 });
    expect(fillHeld({ start: 1100, end: 1140 }, false, 40)).toBeNull();
    expect(fillHeld({ start: 1110, end: 1140 }, false, 40)).toBeNull();
  });

  it("fills from the bottom for a reader below the hold", () => {
    expect(fillHeld({ start: 40, end: 1140 }, true, 40)).toEqual({ start: 40, end: 1100 });
    expect(fillHeld({ start: 40, end: 80 }, true, 40)).toBeNull();
    expect(fillHeld({ start: 40, end: 70 }, true, 40)).toBeNull();
  });

  it("lands and fills a page at a time by default", () => {
    expect(TRANSCRIPT_LANDING_ROWS).toBe(TRANSCRIPT_PAGE_ROWS);
    expect(TRANSCRIPT_FILL_ROWS).toBe(TRANSCRIPT_PAGE_ROWS);
    expect(landingHeld(0, { start: 1140, held: null })).toEqual({
      start: TRANSCRIPT_LANDING_ROWS,
      end: 1140,
    });
    expect(fillHeld({ start: 0, end: 1140 }, false)).toEqual({
      start: TRANSCRIPT_FILL_ROWS,
      end: 1140,
    });
  });
});

describe("the window a transcript mounts", () => {
  it("mounts only the tail of a long conversation", () => {
    const shown = transcriptWindow(4000, -1, 60, 40);
    expect(shown.start).toBe(3940);
    expect(shown.earlier).toBe(3940);
    expect(shown.earlierStart).toBe(3900);
  });

  it("mounts everything when the conversation is shorter than the tail", () => {
    expect(transcriptWindow(12, -1, 60, 40)).toEqual({
      start: 0,
      earlier: 0,
      earlierStart: -1,
      held: null,
    });
  });

  it("mounts everything when exactly the tail is left", () => {
    expect(transcriptWindow(60, -1, 60, 40)).toEqual({
      start: 0,
      earlier: 0,
      earlierStart: -1,
      held: null,
    });
  });

  it("starts where the reader asked, not where the tail would", () => {
    const shown = transcriptWindow(4000, 2000, 60, 40);
    expect(shown).toEqual({ start: 2000, earlier: 2000, earlierStart: 1960, held: null });
  });

  it("stops offering earlier rows once the first row is mounted", () => {
    const shown = transcriptWindow(4000, 0, 60, 40);
    expect(shown).toEqual({ start: 0, earlier: 0, earlierStart: -1, held: null });
  });

  it("pages to the first row rather than past it", () => {
    expect(transcriptWindow(4000, 20, 60, 40).earlierStart).toBe(0);
  });

  it("never mounts less than the tail, however late the anchor sits", () => {
    // An anchor inside the tail — a reveal the reader made before the Session
    // streamed another hundred turns — must not shrink the window.
    expect(transcriptWindow(4000, 3990, 60, 40).start).toBe(3940);
  });

  it("holds an anchor still while the conversation grows under it", () => {
    const first = transcriptWindow(4000, 3000, 60, 40);
    const later = transcriptWindow(4400, 3000, 60, 40);
    expect(later.start).toBe(first.start);
  });

  it("falls back to the tail when the anchored row is gone", () => {
    // -1 is what the caller passes when a compaction retired the anchor's row.
    expect(transcriptWindow(4000, -1, 60, 40).start).toBe(3940);
  });

  it("answers an empty conversation without a negative start", () => {
    expect(transcriptWindow(0, -1, 60, 40)).toEqual({
      start: 0,
      earlier: 0,
      earlierStart: -1,
      held: null,
    });
  });

  it("ships a tail and a page the plane can actually read", () => {
    expect(TRANSCRIPT_TAIL_ROWS).toBeGreaterThan(0);
    expect(TRANSCRIPT_PAGE_ROWS).toBeGreaterThan(0);
    expect(transcriptWindow(10_000, -1).start).toBe(10_000 - TRANSCRIPT_TAIL_ROWS);
    expect(transcriptWindow(10_000, -1).earlierStart).toBe(
      10_000 - TRANSCRIPT_TAIL_ROWS - TRANSCRIPT_PAGE_ROWS,
    );
  });
});

describe("where a transcript was left", () => {
  beforeEach(() => {
    forgetTranscriptViews();
  });

  it("has no answer for a Session nobody has read", () => {
    expect(readTranscriptView("s1")).toBeNull();
  });

  it("answers the last position recorded", () => {
    rememberTranscriptView("s1", { anchorKey: "turn-3", offset: 1200 });
    expect(readTranscriptView("s1")).toEqual({ anchorKey: "turn-3", offset: 1200 });
    rememberTranscriptView("s1", { anchorKey: null, offset: null });
    expect(readTranscriptView("s1")).toEqual({ anchorKey: null, offset: null });
  });

  it("keeps Sessions apart", () => {
    rememberTranscriptView("s1", { anchorKey: "a", offset: 1 });
    rememberTranscriptView("s2", { anchorKey: "b", offset: 2 });
    expect(readTranscriptView("s1")?.anchorKey).toBe("a");
    expect(readTranscriptView("s2")?.anchorKey).toBe("b");
  });

  it("evicts the oldest position rather than growing forever", () => {
    for (let index = 0; index < 60; index += 1) {
      rememberTranscriptView(`s${index}`, { anchorKey: null, offset: index });
    }
    expect(readTranscriptView("s0")).toBeNull();
    expect(readTranscriptView("s59")?.offset).toBe(59);
  });

  it("keeps the Session being read even after fifty others", () => {
    rememberTranscriptView("reading", { anchorKey: null, offset: 10 });
    for (let index = 0; index < 49; index += 1) {
      rememberTranscriptView(`other${index}`, { anchorKey: null, offset: index });
      // Re-reading the live one is what moves it back to the end of the queue.
      rememberTranscriptView("reading", { anchorKey: null, offset: 10 + index });
    }
    expect(readTranscriptView("reading")?.offset).toBe(58);
  });
});
