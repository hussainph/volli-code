/**
 * One account's subscription windows, under its provider row (VC-263).
 *
 * The drawing is notation, and the notation is the reference implementation's:
 * a **remaining** bar (the part a long Session can still spend), a hairline at
 * the elapsed share of the window — where even spending would have left the
 * bar's edge — and a pace glyph that says which side of that line the edge is
 * on. When pace is `on`, the hairline and the edge coincide; when spending runs
 * ahead, the gap between them is the overrun, drawn rather than stated.
 *
 * Time is anchored once per mount and never ticks: these numbers are a
 * snapshot the account stated, `resets in 2h 13m` is that snapshot read once,
 * and a countdown that moved would promise a liveness the source does not have.
 * A newer reading arrives with the next snapshot.
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
  // One reading per mount, taken before anything draws.
  const [at] = React.useState(() => now ?? Date.now());

  if (limits.unavailable !== undefined) {
    return (
      <p data-testid={testId} className="mb-3 -mt-2 text-ui text-muted-foreground">
        {limits.unavailable.reason === "unsupported"
          ? "No subscription usage windows on this account."
          : "Usage limits couldn't be read."}
      </p>
    );
  }
  if (limits.windows.length === 0) return null;
  return (
    <div data-testid={testId} className="mb-3 -mt-2 flex flex-col gap-3">
      {limits.windows.map((window) => (
        <UsageWindowRow key={window.id} window={window} now={at} />
      ))}
    </div>
  );
}

function UsageWindowRow({ window, now }: { window: UsageWindow; now: number }) {
  const remaining = remainingPercent(window);
  const elapsed = elapsedShare(window, now);
  const pace = paceOf(window, now);
  const resetsIn = formatResetsIn(window, now);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium">{window.label}</span>
        <span className="text-ui tabular-nums text-muted-foreground">{remaining}% left</span>
      </div>
      <div className="flex items-center gap-2">
        {/* The bar is the picture of one division, so it is `role="img"` with
            the same facts the line above already carries in words — the repo's
            own UsageBar precedent, which keeps four bar rows out of the tab
            order for the price of one focusable nothing. */}
        <span
          role="img"
          aria-label={`${window.label}: ${remaining}% left${resetsIn === null ? "" : `, ${resetsIn}`}`}
          className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            style={{ width: `${remaining}%` }}
          />
          {elapsed === null ? null : (
            <span
              aria-hidden
              className="absolute inset-y-0 w-px bg-foreground/70"
              style={{ left: `${elapsed * 100}%` }}
            />
          )}
        </span>
        {pace === null ? null : <PaceGlyph pace={pace} />}
      </div>
      {resetsIn === null ? null : (
        <span className="text-ui tabular-nums text-muted-foreground">{resetsIn}</span>
      )}
    </div>
  );
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
    // The label lives on the wrapper so the glyph itself stays a drawing: the
    // words are what a pointer or a screen reader gets, the trend arrow is what
    // an eye gets, and neither repeats the other.
    <span title={words} aria-label={words} className={cn("shrink-0", PACE_COLOR[pace])}>
      <Icon className="size-3.5" />
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
