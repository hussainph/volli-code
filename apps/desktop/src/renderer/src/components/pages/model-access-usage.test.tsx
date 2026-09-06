/**
 * The usage row's notation, asserted where a screenshot cannot hold it still.
 *
 * Everything the row states is derived from one anchored `now` — the percent,
 * the hairline's position, the pace word, the countdown — so the assertions
 * here pin `now` the way the lab scratch does and check that each derived fact
 * landed where the drawing needs it: the bar's width is the REMAINING share
 * (not the used one), the hairline sits at the share of the window still to
 * come (so it meets the fill's edge when pace is on), and a window with no
 * reset still renders a row rather than vanishing.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { UsageLimits } from "@volli/shared";

import { ModelAccessUsage } from "./model-access-usage";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Sixty percent of a five-hour window elapsed, sixty percent used: on pace. */
const LIMITS: UsageLimits = {
  checkedAt: NOW,
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 60,
      resetsAt: iso(NOW + 2 * HOUR),
      windowDurationMins: 300,
    },
  ],
};

describe("ModelAccessUsage", () => {
  it("states the remaining share, the pace word, and the anchored countdown", () => {
    const html = renderToStaticMarkup(<ModelAccessUsage limits={LIMITS} now={NOW} />);
    expect(html).toContain("Session");
    expect(html).toContain("40% left");
    expect(html).toContain("resets in 2h");
    expect(html).toContain("On pace");
  });

  it("fills the bar with what is left and marks even spending at the time left", () => {
    const html = renderToStaticMarkup(<ModelAccessUsage limits={LIMITS} now={NOW} />);
    // On pace: the fill's edge and the hairline coincide at 40%.
    expect(html).toContain("width:40%");
    expect(html).toContain("left:40%");
    expect(html).not.toContain("left:60%");
  });

  it("draws the hairline past the fill's edge when spending runs ahead", () => {
    const ahead: UsageLimits = {
      checkedAt: NOW,
      windows: [{ ...LIMITS.windows[0]!, usedPercent: 90 }],
    };
    const html = renderToStaticMarkup(<ModelAccessUsage limits={ahead} now={NOW} />);
    // 10% left, but 40% of the window still to come: the gap is the overrun.
    expect(html).toContain("width:10%");
    expect(html).toContain("left:40%");
    expect(html).toContain("Ahead of pace");
    expect(html).toContain("10% left");
  });

  it("carries the pace word on the glyph only, and the row's facts in the bar's label", () => {
    const html = renderToStaticMarkup(<ModelAccessUsage limits={LIMITS} now={NOW} />);
    expect(html).toContain('role="img" title="On pace" aria-label="On pace"');
    expect(html).toContain("Session: 40% left, 40% of the window left, resets in 2h");
  });

  it("prints whole points however precisely the provider spoke", () => {
    const precise: UsageLimits = {
      checkedAt: NOW,
      windows: [{ ...LIMITS.windows[0]!, usedPercent: 0.29 * 100 }],
    };
    const html = renderToStaticMarkup(<ModelAccessUsage limits={precise} now={NOW} />);
    expect(html).toContain("71% left");
    expect(html).toContain("width:71%");
    expect(html).not.toContain("71.0");
  });

  it("draws no fill and no pace once the reset has passed, and says so", () => {
    const html = renderToStaticMarkup(<ModelAccessUsage limits={LIMITS} now={NOW + 3 * HOUR} />);
    expect(html).toContain("resets now");
    expect(html).toContain("left:0%");
    expect(html).not.toContain("pace");
  });

  it("draws no fill at all when nothing is left", () => {
    const spent: UsageLimits = {
      checkedAt: NOW,
      windows: [{ ...LIMITS.windows[0]!, usedPercent: 100 }],
    };
    const html = renderToStaticMarkup(<ModelAccessUsage limits={spent} now={NOW} />);
    expect(html).toContain("0% left");
    expect(html).not.toContain("width:");
  });

  it("still draws a window that states no reset — no countdown, no hairline, no pace", () => {
    const bare: UsageLimits = {
      checkedAt: NOW,
      windows: [{ id: "seven_day_opus", kind: "weekly", label: "Weekly · Opus", usedPercent: 8 }],
    };
    const html = renderToStaticMarkup(<ModelAccessUsage limits={bare} now={NOW} />);
    expect(html).toContain("Weekly · Opus");
    expect(html).toContain("92% left");
    expect(html).not.toContain("resets in");
    expect(html).not.toContain("left:");
    expect(html).not.toContain("pace");
    // The glyph's slot is still reserved, so the bar ends where its neighbours' do.
    expect(html).toContain("size-3.5 shrink-0");
  });

  it("says one line and draws no bar for an account with nothing to show", () => {
    const unsupported: UsageLimits = {
      checkedAt: NOW,
      windows: [],
      unavailable: { reason: "unsupported" },
    };
    const failed: UsageLimits = {
      checkedAt: NOW,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    const html = renderToStaticMarkup(
      <>
        <ModelAccessUsage limits={unsupported} now={NOW} />
        <ModelAccessUsage limits={failed} now={NOW} />
      </>,
    );
    expect(html).toContain("No subscription usage windows on this account.");
    expect(html).toContain("Usage limits couldn&#x27;t be read.");
    expect(html).not.toContain("width:");
    expect(html).not.toContain("% left");
  });

  it("draws nothing for a snapshot with windows absent rather than empty", () => {
    expect(
      renderToStaticMarkup(<ModelAccessUsage limits={{ checkedAt: NOW, windows: [] }} />),
    ).toBe("");
  });
});
