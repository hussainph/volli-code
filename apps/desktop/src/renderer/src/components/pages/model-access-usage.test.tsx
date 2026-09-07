/**
 * The usage row's notation, asserted where a screenshot cannot hold it still.
 *
 * Everything the row states is derived from one anchored `now` — the percent,
 * the hairline's position, the bar's tone, the countdown, the age — so the
 * assertions here pin `now` the way the lab scratch does and check that each
 * derived fact landed where the drawing needs it: the bar's width is the
 * REMAINING share (not the used one), the hairline sits at the share of the
 * window still to come (so it meets the fill's edge when pace is on), the
 * fill's colour follows the tone rule, and a window with no reset still
 * renders a row rather than vanishing.
 *
 * The reading's own age is deliberately NOT on the surface and not in the
 * title: the numbers are refreshed on every open and Refresh, so a caption
 * about their age would be prose the control does not need.
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
  checkedAt: NOW - 60_000,
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

function withUsed(usedPercent: number): UsageLimits {
  return { ...LIMITS, windows: [{ ...LIMITS.windows[0]!, usedPercent }] };
}

describe("ModelAccessUsage", () => {
  it("states the remaining share and the anchored countdown, and no pace words", () => {
    const html = renderToStaticMarkup(<ModelAccessUsage limits={LIMITS} now={NOW} />);
    expect(html).toContain("Session");
    expect(html).toContain("40% left");
    expect(html).toContain("resets in 2h");
    expect(html).not.toContain("pace");
  });

  it("fills the bar with what is left and marks even spending at the time left", () => {
    const html = renderToStaticMarkup(<ModelAccessUsage limits={LIMITS} now={NOW} />);
    // On pace: the fill's edge and the hairline coincide at 40%.
    expect(html).toContain("width:40%");
    expect(html).toContain("left:40%");
    expect(html).not.toContain("left:60%");
  });

  it("draws the hairline past the fill's edge when spending runs ahead", () => {
    const html = renderToStaticMarkup(<ModelAccessUsage limits={withUsed(70)} now={NOW} />);
    // 30% left, but 40% of the window still to come: the gap is the overrun.
    expect(html).toContain("width:30%");
    expect(html).toContain("left:40%");
  });

  it("colours the fill by the tone rule: ordinary, attention, critical", () => {
    // 60% left at 40% of the window to go: plenty, and lasting.
    expect(renderToStaticMarkup(<ModelAccessUsage limits={withUsed(40)} now={NOW} />)).toContain(
      'data-tone="normal"',
    );
    // 30% left with 40% to go: ahead of pace, the early warning.
    expect(renderToStaticMarkup(<ModelAccessUsage limits={withUsed(70)} now={NOW} />)).toContain(
      'data-tone="attention"',
    );
    // A tenth left.
    expect(renderToStaticMarkup(<ModelAccessUsage limits={withUsed(90)} now={NOW} />)).toContain(
      'data-tone="critical"',
    );
    const html = renderToStaticMarkup(<ModelAccessUsage limits={withUsed(90)} now={NOW} />);
    expect(html).toContain("bg-destructive");
    expect(html).not.toContain("bg-primary");
  });

  it("carries the row's facts in the bar's label and its title, and nothing else", () => {
    const html = renderToStaticMarkup(<ModelAccessUsage limits={LIMITS} now={NOW} />);
    expect(html).toContain('aria-label="Session: 40% left, 40% of the window left, resets in 2h"');
    expect(html).toContain('title="Session: 40% left, 40% of the window left, resets in 2h"');
  });

  it("never says how old the reading is, however old it is", () => {
    const ancient = renderToStaticMarkup(
      <ModelAccessUsage limits={{ ...LIMITS, checkedAt: NOW - 23 * 60_000 }} now={NOW} />,
    );
    expect(ancient).not.toContain("checked");
    expect(ancient).not.toContain("ago");
    // Still a whole row, drawn from the same numbers as a fresh one.
    expect(ancient).toContain("40% left");
    expect(ancient).toContain("resets in 2h");
  });

  it("prints whole points however precisely the provider spoke", () => {
    const html = renderToStaticMarkup(<ModelAccessUsage limits={withUsed(0.29 * 100)} now={NOW} />);
    expect(html).toContain("71% left");
    expect(html).toContain("width:71%");
    expect(html).not.toContain("71.0");
  });

  it("draws no fill once nothing is left, and no hairline off the bar once the reset has passed", () => {
    const spent = renderToStaticMarkup(<ModelAccessUsage limits={withUsed(100)} now={NOW} />);
    expect(spent).toContain("0% left");
    expect(spent).not.toContain("width:");
    const passed = renderToStaticMarkup(<ModelAccessUsage limits={LIMITS} now={NOW + 3 * HOUR} />);
    expect(passed).toContain("resets now");
    expect(passed).toContain("left:0%");
  });

  it("still draws a window that states no reset — no countdown, no hairline", () => {
    const bare: UsageLimits = {
      checkedAt: NOW,
      windows: [{ id: "seven_day_opus", kind: "weekly", label: "Weekly · Opus", usedPercent: 8 }],
    };
    const html = renderToStaticMarkup(<ModelAccessUsage limits={bare} now={NOW} />);
    expect(html).toContain("Weekly · Opus");
    expect(html).toContain("92% left");
    expect(html).not.toContain("resets in");
    expect(html).not.toContain("left:");
    expect(html).toContain('data-tone="normal"');
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
    // The failed line names its retry: the page's own Refresh.
    expect(html).toContain("Usage limits couldn&#x27;t be read. Refresh to try again.");
    expect(html).not.toContain("width:");
    expect(html).not.toContain("% left");
  });

  it("draws nothing for a snapshot with windows absent rather than empty", () => {
    expect(
      renderToStaticMarkup(<ModelAccessUsage limits={{ checkedAt: NOW, windows: [] }} />),
    ).toBe("");
  });
});
