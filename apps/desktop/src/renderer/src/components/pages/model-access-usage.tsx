/**
 * One account's subscription windows, under its provider row (VC-263).
 *
 * The drawing is notation: a **remaining** bar (the part a long Session can
 * still spend), a hairline at where even spending would have left the bar's
 * edge, and the bar's colour for what a glance should take away. When the
 * edge and the hairline coincide, spending is on pace; the edge short of the
 * hairline is the overrun, drawn rather than stated. No words say "ahead" or
 * "under" — the gap is the sentence.
 *
 * THE HAIRLINE IS THE TIME LEFT, NOT THE TIME SPENT. The bar's fill is quota
 * left, so the mark for "what even spending would leave" is the share of the
 * window still to come — `1 − elapsed`, measured from the same left edge as
 * the fill. Placing it at `elapsed` mirrors it about the bar's middle, and the
 * two only agree at half-way.
 *
 * THE COLOUR IS THE VERDICT. Primary while there is plenty and it is lasting;
 * attention at a quarter left, or sooner when spending runs ahead of the
 * window (the early warning — it will run out before the reset if the rate
 * holds); destructive at a tenth left. The rule is `usageTone` in shared, so
 * a second surface reads the same bar the same way.
 *
 * Time is anchored once per snapshot and never ticks: these numbers are a
 * snapshot the account stated, `resets in 2h 13m` is that snapshot read once,
 * and a countdown that moved would promise a liveness the source does not have.
 * A newer reading arrives with the next snapshot, and the anchor travels with
 * it — per snapshot, not per mount, because the account row stays mounted
 * across a Refresh, and a fresh `resetsAt` read against the clock as it stood
 * when the page opened would be wrong by however long the page had been open.
 *
 * No prose. The label is the window's own name, `N% left` is the number, and
 * the only sentence on the surface is the reset — the same rule the rest of
 * Model Access already obeys. There is no "checked N ago" line: the numbers
 * are refreshed whenever the page is opened or Refreshed, and a caption about
 * their age would be the surface apologising for itself. The one line an
 * account with nothing to show earns is a state, not an explanation, and the
 * failed one names its retry: the page's Refresh.
 */
import * as React from "react";
import {
  elapsedShare,
  formatResetsIn,
  remainingPercent,
  usageTone,
  type UsageLimits,
  type UsageTone,
  type UsageWindow,
} from "@volli/shared";

import { cn } from "@renderer/lib/utils";

export function ModelAccessUsage({
  limits,
  now,
  testId,
}: {
  limits: UsageLimits;
  /** Anchor for the countdown, the hairline and the age. Defaults to the snapshot's arrival. */
  now?: number;
  testId?: string;
}) {
  if (limits.unavailable !== undefined) {
    return (
      <p data-testid={testId} className="-mt-2 mb-4 text-ui text-muted-foreground last:mb-0">
        {limits.unavailable.reason === "unsupported"
          ? "No subscription usage windows on this account."
          : "Usage limits couldn't be read. Refresh to try again."}
      </p>
    );
  }
  if (limits.windows.length === 0) return null;
  // One anchor per snapshot: the windows remount when a snapshot with a new
  // `checkedAt` arrives, and only then. The holder hands back the very same
  // object when nothing changed, so a confirming inspection keeps the key and
  // the anchor with it.
  return <UsageWindows key={limits.checkedAt} limits={limits} now={now} testId={testId} />;
}

function UsageWindows({
  limits,
  now,
  testId,
}: {
  limits: UsageLimits;
  now: number | undefined;
  testId: string | undefined;
}) {
  // Taken once, before anything draws, and held for this snapshot's life.
  const [at] = React.useState(() => now ?? Date.now());
  return (
    // Tucked under its PrefRow's bottom padding, and the last account's block
    // ends the section flush the way a lone PrefRow's `last:pb-0` would have.
    // Every step is on the spacing ladder (docs/DESIGN.md): 2 up, 4 below.
    <div data-testid={testId} className="-mt-2 mb-4 flex flex-col gap-2 last:mb-0">
      {limits.windows.map((window) => (
        <UsageWindowRow key={window.id} window={window} now={at} />
      ))}
    </div>
  );
}

function UsageWindowRow({ window, now }: { window: UsageWindow; now: number }) {
  // Whole points on the surface. The mappers hand through what the provider
  // said — a header's `0.29` becomes `28.999999999999996` — and a bar labelled
  // to fourteen places would be precision the reading does not have.
  const remaining = Math.round(remainingPercent(window));
  const elapsed = elapsedShare(window, now);
  // The fill is what is left, so the even-spending mark is the time left.
  const evenAt = elapsed === null ? null : (1 - elapsed) * 100;
  const tone = usageTone(window, now);
  const resetsIn = formatResetsIn(window, now);
  const summary = usageWindowSummary(window.label, remaining, evenAt, resetsIn);

  return (
    <div className="flex flex-col gap-1">
      {/* Two lines per window, not three: the countdown rides beside the label
          so a provider with three windows is six lines under its row, and the
          bar below keeps the full width for the drawing. */}
      <div className="flex items-baseline justify-between gap-4">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium">{window.label}</span>
          {resetsIn === null ? null : (
            <span className="truncate text-ui tabular-nums text-muted-foreground">{resetsIn}</span>
          )}
        </span>
        <span className="shrink-0 text-ui tabular-nums text-muted-foreground">
          {remaining}% left
        </span>
      </div>
      {/* The bar is the picture of one division, so it is `role="img"` with
          the same facts the line above already carries in words — the repo's
          own UsageBar precedent, which keeps bar rows out of the tab order for
          the price of one focusable nothing. A native title rather than a
          Tooltip, for the same reason that precedent gives: the exact figures
          are a reinforcement of the caption, not a control, and a Radix portal
          per bar is not worth mounting for one.

          The box is taller than the track so the hairline can stand proud of
          it above and below: a tick that only spans the fill's height reads
          as a seam in the fill where they overlap, and disappears altogether
          at the track's far edge. */}
      <span role="img" aria-label={summary} title={summary} className="relative h-4 w-full">
        <span aria-hidden className="absolute inset-x-0 inset-y-1 rounded-full bg-muted" />
        {remaining > 0 ? (
          <span
            aria-hidden
            data-tone={tone}
            className={cn("absolute inset-y-1 left-0 rounded-full", TONE_FILL[tone])}
            style={{ width: `${remaining}%` }}
          />
        ) : null}
        {evenAt === null ? null : (
          <span
            aria-hidden
            className="absolute inset-y-0 w-px -translate-x-1/2 bg-foreground/70"
            style={{ left: `${evenAt}%` }}
          />
        )}
      </span>
    </div>
  );
}

/** Semantic tokens, never raw palette — `check-design-tokens.mjs` bans the latter. */
const TONE_FILL: Record<UsageTone, string> = {
  normal: "bg-primary",
  attention: "bg-attention",
  critical: "bg-destructive",
};

/** The row's facts as one sentence, in the order the drawing states them. */
function usageWindowSummary(
  label: string,
  remaining: number,
  evenAt: number | null,
  resetsIn: string | null,
): string {
  const parts = [`${label}: ${remaining}% left`];
  if (evenAt !== null) parts.push(`${Math.round(evenAt)}% of the window left`);
  if (resetsIn !== null) parts.push(resetsIn);
  return parts.join(", ");
}
