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
 *     hairline. The hairline is the TIME LEFT, measured from the same left
 *     edge as the fill, so the two agree exactly when pace is on; the Healthy
 *     panel's weekly row (0.6% elapsed, 4% used) is the near-coincidence to
 *     squint at. If the hairline reads as a glitch in the fill rather than a
 *     second fact, the fix is the hairline's contrast, not a legend.
 *   • THE COLOUR IS THE VERDICT. Primary, then `--attention` at a quarter
 *     left or when ahead of pace, then `--destructive` at a tenth. The Ahead
 *     panel puts all three in one account: check that amber on a 39%-left bar
 *     reads as "watch this" and not as a different kind of bar, and that the
 *     6% stub in destructive is still a bar and not a dot.
 *   • THE LONG LABEL AND THE LONG COUNTDOWN. `Weekly · Claude sonnet 4 5` is
 *     what a model-scoped header actually produces, and it shares a line with
 *     its countdown; `resets in 6d 23h` beside `resets in 45m` must not make
 *     the weekly row read as a different control. Narrow the window: the
 *     countdown clips before the percent does.
 *   • LIGHT IS A DIFFERENT COLOUR. Toggle Light/Dark. The three fills are
 *     solved per appearance, so amber must stay a legible amber-brown on
 *     light, not mud, and the hairline must still read on every fill.
 *
 * Every fixture is pinned to one fixed `now`, the way the real component
 * anchors a snapshot — a scratch that ticked would be judging a liveness the
 * feature does not have.
 */
import * as React from "react";
import type { UsageLimits } from "@volli/shared";

import { ModelAccessUsage } from "@renderer/components/pages/model-access-usage";

export const title = "Usage limits (VC-263)";
export const note =
  "Remaining bar, elapsed hairline, tone by colour — healthy, ahead, stale, unsupported";

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
      // 94% used with 2 of 5 hours still to come: a 6% stub at the left and
      // the hairline out at 40%, the gap between them being the overrun.
      usedPercent: 94,
      resetsAt: iso(NOW + 2 * HOUR),
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
      id: "seven_day_claude_sonnet_4_5",
      kind: "weekly",
      // The label a model-scoped header really yields, and the longest one.
      label: "Weekly · Claude sonnet 4 5",
      usedPercent: 8,
      // No reset stated: the row must survive without its countdown and without
      // a hairline, and still line up with its neighbours.
      windowDurationMins: 10_080,
    },
  ],
};

/**
 * OpenCode Go: an API-key subscription with a third, monthly window — the
 * first use of `kind: "monthly"`, and the tallest account on the page. Three
 * rows must still read as one control, and `Monthly · resets in 12d 4h` is
 * the longest label-plus-countdown a real provider produces.
 */
const OPENCODE_GO: UsageLimits = {
  checkedAt: NOW - 2 * 60_000,
  windows: [
    {
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: 22,
      resetsAt: iso(NOW + 3 * HOUR + 40 * 60_000),
      windowDurationMins: 300,
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 47,
      resetsAt: iso(NOW + 4 * DAY + 12 * HOUR),
      windowDurationMins: 10_080,
    },
    {
      id: "monthly",
      kind: "monthly",
      label: "Monthly",
      usedPercent: 58,
      resetsAt: iso(NOW + 12 * DAY + 4 * HOUR),
      windowDurationMins: 28 * 1_440,
    },
  ],
};

/**
 * The edges: a session window fully spent with time left (no fill at all,
 * hairline standing alone), one whose reset has passed with nothing newer
 * reported yet (`resets now`, hairline at the left edge), and the whole
 * reading old enough — forty minutes — that the account says when it was
 * checked. All of it must still read as the same control.
 */
const EDGES: UsageLimits = {
  checkedAt: NOW - 40 * 60_000,
  windows: [
    {
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: 100,
      resetsAt: iso(NOW + 1 * HOUR + 30 * 60_000),
      windowDurationMins: 300,
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 71,
      resetsAt: iso(NOW - 4 * 60_000),
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
      <Frame label="Three windows · OpenCode Go">
        <ModelAccessUsage limits={OPENCODE_GO} now={NOW} />
      </Frame>
      <Frame label="Spent · reset passed · stale">
        <ModelAccessUsage limits={EDGES} now={NOW} />
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
