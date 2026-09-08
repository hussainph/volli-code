import { describe, expect, it } from "vite-plus/test";

import {
  DIFF_SIDE_BY_SIDE_MIN_WIDTH,
  diffFitsSideBySide,
  fitDiffPresentation,
  isDiffInlineFallback,
} from "./diff-fit";

/** The pane widths VC-288 names, and the one the split's own clamp allows. */
const PANES = [240, 320, 480, 639, 640, 720, 1200] as const;

describe("fitDiffPresentation", () => {
  it("draws inline everywhere the reader asked for inline", () => {
    for (const width of [...PANES, null])
      expect([width, fitDiffPresentation("inline", width)]).toEqual([width, "inline"]);
  });

  it("falls back to one column below the width two columns need", () => {
    // VC-288's own acceptance widths. Two 13px monospace columns cannot both
    // stay readable in a third of a 940px window at 150% zoom, and what a
    // side-by-side diff degrades into there is two ellipses.
    for (const width of [240, 320, 480, 639])
      expect([width, fitDiffPresentation("side-by-side", width)]).toEqual([width, "inline"]);
  });

  it("keeps the columns the moment the pane can hold them", () => {
    for (const width of [640, 720, 1200])
      expect([width, fitDiffPresentation("side-by-side", width)]).toEqual([width, "side-by-side"]);
  });

  it("obeys the stored choice until the pane has actually been measured", () => {
    // The first frame after a mount has no `ResizeObserver` reading yet. Zero
    // is that same frame seen from a different angle — a display:none ancestor,
    // or a pane mid-transition — and treating either as "narrow" would flash a
    // one-column diff into a wide pane and then swap it back a frame later.
    expect(fitDiffPresentation("side-by-side", null)).toBe("side-by-side");
    expect(fitDiffPresentation("side-by-side", 0)).toBe("side-by-side");
  });
});

describe("isDiffInlineFallback", () => {
  it("is true only where the reader's choice is not what the pane is drawing", () => {
    expect(isDiffInlineFallback("side-by-side", 320)).toBe(true);
    expect(isDiffInlineFallback("side-by-side", 720)).toBe(false);
    expect(isDiffInlineFallback("side-by-side", null)).toBe(false);
    // Inline is never a fallback: it is what was asked for.
    expect(isDiffInlineFallback("inline", 320)).toBe(false);
    expect(isDiffInlineFallback("inline", 720)).toBe(false);
  });
});

describe("diffFitsSideBySide", () => {
  it("names the threshold once, so the band and the editor cannot disagree", () => {
    expect(DIFF_SIDE_BY_SIDE_MIN_WIDTH).toBe(640);
    expect(diffFitsSideBySide(DIFF_SIDE_BY_SIDE_MIN_WIDTH)).toBe(true);
    expect(diffFitsSideBySide(DIFF_SIDE_BY_SIDE_MIN_WIDTH - 1)).toBe(false);
  });
});
