/**
 * VC-263's usage windows and VC-271's popover, at every state they survive.
 *
 * The question this scratch answers is not "is it pretty" but "does the
 * notation still say the right thing when the numbers get awkward". Things a
 * still frame cannot check by existing:
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
 *   • THE POPOVER IS THE REAL SURFACE (VC-271). The last panel mounts the
 *     actual chrome-band control over a fixture snapshot: open it, and check
 *     that the CLOSED rows already answer "am I about to run out" — the
 *     account nearest the wall on top and open, its binding number in its own
 *     tone. Then check the accordion's height animation against a three-window
 *     account (OpenCode Go) and a one-window account (xAI): the surface
 *     resizing IS the effect, so it must not feel like a jump.
 *
 * Every fixture is pinned to one fixed `now`, the way the real component
 * anchors a snapshot — a scratch that ticked would be judging a liveness the
 * feature does not have.
 */
import * as React from "react";
import type {
  ModelAccessProvider as CatalogProvider,
  ModelAccessSnapshot,
  UsageLimits,
} from "@volli/shared";

import { AccountUsage } from "@renderer/components/usage-limits/account-usage";
import { UsageLimitsPopover } from "@renderer/components/usage-limits/usage-limits-popover";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

export const title = "Usage limits (VC-263 · VC-271)";
export const note =
  "Remaining bar, elapsed hairline, tone by colour — and the chrome popover that now hosts them";

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
 * hairline standing alone) and one whose reset has passed with nothing newer
 * reported yet (`resets now`, hairline at the left edge). Both must still read
 * as the same control as a healthy account's.
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

/**
 * GitHub Copilot (VC-271): a MONTHLY window measured in premium requests, and
 * the only account whose window is a month long — `resets in 30d` beside a
 * hairline barely off the left edge is the shape to judge. A Pro seat draws
 * exactly one row because chat and completions come back `unlimited`.
 */
const GITHUB_COPILOT: UsageLimits = {
  checkedAt: NOW - 3 * 60_000,
  windows: [
    {
      id: "premium_interactions",
      kind: "monthly",
      // The longest label the three classes produce.
      label: "Premium requests",
      usedPercent: 68.83,
      resetsAt: iso(NOW + 30 * DAY + 12 * HOUR),
      windowDurationMins: 31 * 1_440,
    },
  ],
};

/**
 * Kimi Code (VC-271): counts rather than percentages upstream, so the numbers
 * land on awkward fractions — check that `37% left` never renders fourteen
 * decimal places, and that a five-hour window beside a seven-day one reads as
 * the same control at very different countdowns.
 */
const KIMI: UsageLimits = {
  checkedAt: NOW - 30_000,
  windows: [
    {
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: 63.33333333333333,
      resetsAt: iso(NOW + 1 * HOUR + 52 * 60_000),
      windowDurationMins: 300,
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 12,
      resetsAt: iso(NOW + 4 * DAY + 2 * HOUR),
      windowDurationMins: 10_080,
    },
  ],
};

/**
 * xAI (VC-271): ONE window, and the account with the least left. A single row
 * has no sibling to line up with, so it is the one that shows whether the
 * block still reads as a control rather than as a stray bar.
 */
const XAI: UsageLimits = {
  checkedAt: NOW - 90_000,
  windows: [
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 96,
      resetsAt: iso(NOW + 2 * DAY + 6 * HOUR),
      windowDurationMins: 10_080,
    },
  ],
};

/** The provider rows a snapshot carries, as the popover reads them. */
function account(id: string, label: string, usageLimits?: UsageLimits): CatalogProvider {
  return {
    id,
    label,
    state: "available",
    accountLabel: null,
    billingSource: "subscription",
    recovery: null,
    signIn: [],
    hasStoredCredential: true,
    ...(usageLimits === undefined ? {} : { usageLimits }),
  };
}

const SNAPSHOT: ModelAccessSnapshot = {
  observedAt: NOW,
  models: [],
  providers: [
    account("anthropic", "Anthropic", HEALTHY),
    account("openai-codex", "OpenAI Codex", CODEX),
    account("github-copilot", "GitHub Copilot", GITHUB_COPILOT),
    account("kimi-coding", "Kimi For Coding", KIMI),
    account("xai", "xAI", XAI),
    account("opencode-go", "OpenCode Go", OPENCODE_GO),
    // Signed in, read, and not metered in windows: must not appear at all.
    account("mistral", "Mistral", UNSUPPORTED),
    // Read failed: appears last, with its retry line inside.
    account("zai", "Z.ai", PROBE_FAILED),
    // No reader: never probed, never listed.
    account("groq", "Groq"),
  ],
};

/**
 * Enough of a client for the popover: it inspects and nothing else. A Refresh
 * takes the same path, so the spinner and the disabled control are real here.
 */
const CLIENT: ModelAccessClient = {
  inspect: async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    return SNAPSHOT;
  },
  defaults: () => Promise.reject(new Error("not part of this scratch")),
  setDefault: () => Promise.reject(new Error("not part of this scratch")),
  hiddenModels: () => Promise.reject(new Error("not part of this scratch")),
  setHiddenModels: () => Promise.reject(new Error("not part of this scratch")),
  compactionPolicy: () => Promise.reject(new Error("not part of this scratch")),
  setCompactionPolicy: () => Promise.reject(new Error("not part of this scratch")),
  pickerView: () => Promise.reject(new Error("not part of this scratch")),
  setPickerView: () => Promise.reject(new Error("not part of this scratch")),
  beginSignIn: () => Promise.reject(new Error("not part of this scratch")),
  signOut: () => Promise.reject(new Error("not part of this scratch")),
};

export default function UsageLimitsScratch() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Frame label="The popover, as the chrome band mounts it">
        {/* On a band of its own so the trigger is judged at the size and on
            the material it really wears, not against the stage's card. */}
        <div className="flex h-9 items-center justify-center rounded-md bg-background/40">
          <ModelAccessProvider client={CLIENT}>
            <UsageLimitsPopover />
          </ModelAccessProvider>
        </div>
      </Frame>
      <Frame label="Healthy · Anthropic">
        <AccountUsage limits={HEALTHY} now={NOW} />
      </Frame>
      <Frame label="Ahead of pace · long Session">
        <AccountUsage limits={AHEAD} now={NOW} />
      </Frame>
      <Frame label="Healthy · Codex">
        <AccountUsage limits={CODEX} now={NOW} />
      </Frame>
      <Frame label="One monthly window · GitHub Copilot">
        <AccountUsage limits={GITHUB_COPILOT} now={NOW} />
      </Frame>
      <Frame label="Counts, not percents · Kimi Code">
        <AccountUsage limits={KIMI} now={NOW} />
      </Frame>
      <Frame label="A single window, nearly spent · xAI">
        <AccountUsage limits={XAI} now={NOW} />
      </Frame>
      <Frame label="Three windows · OpenCode Go">
        <AccountUsage limits={OPENCODE_GO} now={NOW} />
      </Frame>
      <Frame label="Spent · reset passed">
        <AccountUsage limits={EDGES} now={NOW} />
      </Frame>
      <Frame label="Unsupported / couldn't read">
        <AccountUsage limits={UNSUPPORTED} now={NOW} />
        <AccountUsage limits={PROBE_FAILED} now={NOW} />
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
