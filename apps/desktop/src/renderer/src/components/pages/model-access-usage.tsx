/**
 * One account's subscription windows, under its provider row (VC-263).
 *
 * The drawing is notation, and the notation is the reference implementation's:
 * a **remaining** bar (the part a long Session can still spend), a hairline at
 * where even spending would have left the bar's edge, and a pace glyph that
 * says which side of that line the edge is on. When pace is `on`, the hairline
 * and the edge coincide; when spending runs ahead, the gap between them is the
 * overrun, drawn rather than stated.
 *
 * THE HAIRLINE IS THE TIME LEFT, NOT THE TIME SPENT. The bar's fill is quota
 * left, so the mark for "what even spending would leave" is the share of the
 * window still to come — `1 − elapsed`, measured from the same left edge as
 * the fill. Placing it at `elapsed` mirrors it about the bar's middle, and the
 * two only agree at half-way: a window 94% spent at 94% elapsed (dead on pace)
 * would draw a stub at the left and a tick at the far right, the picture of
 * being maximally ahead, beside an `=` glyph saying the opposite.
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
 * Model Access already obeys. The one line of text an account with nothing to
 * show earns is a state, not an explanation.
 */
import { EqualsIcon } from "@phosphor-icons/react/dist/csr/Equals";
import { TrendDownIcon } from "@phosphor-icons/react/dist/csr/TrendDown";
import { TrendUpIcon } from "@phosphor-icons/react/dist/csr/TrendUp";
import * as React from "react";
import {
  elapsedShare,
  formatResetsIn,
  paceOf,
  remainingPercent,
  type UsageLimits,
  type UsagePace,
  type UsageWindow,
} from "@volli/shared";

import { cn } from "@renderer/lib/utils";

export function ModelAccessUsage({
  limits,
  now,
  testId,
}: {
  limits: UsageLimits;
  /** Anchor for the countdown and the pace reading. Defaults to mount time. */
  now?: number;
  testId?: string;
}) {
  // One reading per snapshot, taken before anything draws. Keyed on `limits`
  // by identity: the holder hands back the same object when nothing changed,
  // so a confirming inspection does not move the anchor either.
  const at = React.useMemo(() => now ?? Date.now(), [limits, now]);

  if (limits.unavailable !== undefined) {
    return (
      <p data-testid={testId} className="mb-3 -mt-2 text-ui text-muted-foreground last:mb-0">
        {limits.unavailable.reason === "unsupported"
          ? "No subscription usage windows on this account."
          : "Usage limits couldn't be read."}
      </p>
    );
  }
  if (limits.windows.length === 0) return null;
  return (
    // Tucked under its PrefRow's bottom padding, and the last account's block
    // ends the section flush the way a lone PrefRow's `last:pb-0` would have.
    <div data-testid={testId} className="mb-3 -mt-2 flex flex-col gap-3 last:mb-0">
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
  const pace = paceOf(window, now);
  const resetsIn = formatResetsIn(window, now);

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
      <div className="flex items-center gap-2">
        {/* The bar is the picture of one division, so it is `role="img"` with
            the same facts the line above already carries in words — the repo's
            own UsageBar precedent, which keeps four bar rows out of the tab
            order for the price of one focusable nothing.

            The box is taller than the track so the hairline can stand proud of
            it above and below: a tick that only spans the fill's height reads
            as a seam in the fill where they overlap, and disappears altogether
            at the track's far edge. */}
        <span
          role="img"
          aria-label={usageWindowSummary(window.label, remaining, evenAt, resetsIn)}
          className="relative h-4 w-full"
        >
          <span aria-hidden className="absolute inset-x-0 inset-y-1 rounded-full bg-muted" />
          {remaining > 0 ? (
            <span
              aria-hidden
              className="absolute inset-y-1 left-0 rounded-full bg-primary"
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
        {/* The glyph's slot is reserved whether or not there is a reading, so a
            window with no reset draws its bar to the same right edge as the
            rows above and below it. */}
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {pace === null ? null : <PaceGlyph pace={pace} />}
        </span>
      </div>
    </div>
  );
}

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

/**
 * The pace reading, as a glyph alone. The words live in its label, not on the
 * surface: pace is already drawn by the hairline's distance from the bar's
 * edge, so a sentence beside it would say the same thing twice.
 */
function PaceGlyph({ pace }: { pace: UsagePace }) {
  const words = PACE_WORDS[pace];
  const Icon = PACE_ICON[pace];
  return (
    // `role="img"` so the label is announced: an `aria-label` on a bare span
    // has no role to hang from and most readers skip it. The words are what a
    // pointer or a screen reader gets, the trend arrow is what an eye gets,
    // and neither repeats the other.
    <span role="img" title={words} aria-label={words} className={cn("flex", PACE_COLOR[pace])}>
      <Icon aria-hidden className="size-3.5" />
    </span>
  );
}

const PACE_WORDS: Record<UsagePace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

const PACE_ICON = {
  ahead: TrendUpIcon,
  on: EqualsIcon,
  under: TrendDownIcon,
};

const PACE_COLOR: Record<UsagePace, string> = {
  ahead: "text-attention",
  on: "text-muted-foreground",
  under: "text-positive",
};
