/**
 * VC-263's usage windows, at every state the row has to survive.
 *
 * The question this scratch answers is not "is it pretty" but "does the
 * notation still say the right thing when the numbers get awkward". Three
 * things a still frame cannot check by existing:
 *
 *   • THE HAIRLINE VERSUS THE EDGE. Pace is drawn, not written — when spending
 *     is on pace the hairline sits ON the bar's edge, ahead leaves a gap
 *     between them (the overrun, in bar-widths), under puts the edge past the
 *     hairline. Squint at the "Ahead" panel: if the hairline reads as a glitch
 *     in the fill rather than a second fact, the fix is the hairline's
 *     contrast, not a legend.
 *   • THE LONG COUNTDOWN. `resets in 6d 23h` beside `resets in 45m` — the
 *     weekly row must not read as a different control because its number is
 *     wider. tabular-nums is doing that work; check it survives a light canvas.
 *   • LIGHT IS A DIFFERENT COLOUR. Toggle Light/Dark. The pace glyphs carry
 *     hue (`--attention`, `--positive`, both solved per appearance), so the
 *     Ahead panel's trend-up must stay a legible amber-brown on light, not mud.
 *
 * Every fixture is pinned to one fixed `now`, the way the real component
 * anchors a mount — a scratch that ticked would be judging a liveness the
 * feature does not have.
 */
import * as React from "react";
import type { UsageLimits } from "@volli/shared";

import { ModelAccessUsage } from "@renderer/components/pages/model-access-usage";

export const title = "Usage limits (VC-263)";
export const note = "Remaining bar, elapsed hairline, pace glyph — healthy, ahead, unsupported";

/** One moment, so every countdown and pace reading is exact. */
const NOW = Date.parse("2026-03-01T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A healthy account: both windows under even pace, resets comfortably out. */
const HEALTHY: UsageLimits = {
  checkedAt: NOW - 5 * 60_000,
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 37,
      resetsAt: iso(NOW + 2 * HOUR + 13 * 60_000),
      windowDurationMins: 300,
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 4,
      resetsAt: iso(NOW + 6 * DAY + 23 * HOUR),
      windowDurationMins: 10_080,
    },
  ],
};

/** A long Session mid-flight: the session window is spent well ahead of even. */
const AHEAD: UsageLimits = {
  checkedAt: NOW - 60_000,
  windows: [
    {
      id: "session",
      kind: "session",
      label: "Session",
      // 94% used with 18 of 300 minutes left: nearly empty, and far ahead of
      // the hairline near the bar's right end.
      usedPercent: 94,
      resetsAt: iso(NOW + 18 * 60_000),
      windowDurationMins: 300,
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 61,
      resetsAt: iso(NOW + 3 * DAY + 4 * HOUR),
      windowDurationMins: 10_080,
    },
    {
      id: "seven_day_opus",
      kind: "weekly",
      label: "Weekly · Opus",
      usedPercent: 8,
      // No reset stated: the row must survive without its countdown and without
      // a pace reading, and still line up with its neighbours.
      windowDurationMins: 10_080,
    },
  ],
};

/** An API-key account: no windows, and never any. */
const UNSUPPORTED: UsageLimits = {
  checkedAt: NOW - 60_000,
  windows: [],
  unavailable: { reason: "unsupported" },
};

/** The endpoint answered nothing this time: one line, no bar. */
const PROBE_FAILED: UsageLimits = {
  checkedAt: NOW - 60_000,
  windows: [],
  unavailable: { reason: "probeFailed" },
};

/** Both providers' vocabulary side by side, since the ids differ but the rows must not. */
const CODEX: UsageLimits = {
  checkedAt: NOW - 60_000,
  windows: [
    {
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: 49,
      resetsAt: iso(NOW + 45 * 60_000),
      windowDurationMins: 300,
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 62,
      resetsAt: iso(NOW + 3 * DAY + 19 * HOUR),
      windowDurationMins: 10_080,
    },
  ],
};

export default function UsageLimitsScratch() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Frame label="Healthy · Anthropic">
        <ModelAccessUsage limits={HEALTHY} now={NOW} />
      </Frame>
      <Frame label="Ahead of pace · long Session">
        <ModelAccessUsage limits={AHEAD} now={NOW} />
      </Frame>
      <Frame label="Healthy · Codex">
        <ModelAccessUsage limits={CODEX} now={NOW} />
      </Frame>
      <Frame label="Unsupported / couldn't read">
        <ModelAccessUsage limits={UNSUPPORTED} now={NOW} />
        <ModelAccessUsage limits={PROBE_FAILED} now={NOW} />
      </Frame>
      <Frame label="In a row, as the page draws it">
        <div className="flex flex-col">
          <div className="flex items-center justify-between border-t border-border/50 py-4 first:border-t-0">
            <span className="text-sm font-medium">Anthropic</span>
            <span className="text-ui text-muted-foreground">Subscription</span>
          </div>
          <ModelAccessUsage limits={HEALTHY} now={NOW} />
          <div className="flex items-center justify-between border-t border-border/50 py-4">
            <span className="text-sm font-medium">OpenAI Codex</span>
            <span className="text-ui text-muted-foreground">Subscription</span>
          </div>
          <ModelAccessUsage limits={CODEX} now={NOW} />
        </div>
      </Frame>
    </div>
  );
}

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-raised">
      <h2 className="font-mono text-label uppercase text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}
