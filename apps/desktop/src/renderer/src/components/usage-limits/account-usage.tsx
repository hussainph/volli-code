import { PanelEmptyState } from "@renderer/components/ui/empty-state";
/** Subscription allowances as Instrument rings. Each ring measures quota left;
 * the notch measures time left against the same anchored snapshot. Tone carries
 * pace as well as amount. Pins remain explicit host-owned controls. */
import { PinIcon } from "@renderer/components/ui/icon";

import * as React from "react";
import {
  elapsedShare,
  formatResetsIn,
  remainingPercent,
  usageTone,
  type UsageLimits,
  type UsageWindow,
} from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import "../usage/usage-instrument.css";

/** What a host that can pin a window hands each row. */
export interface UsageWindowPin {
  isPinned(windowId: string): boolean;
  toggle(windowId: string): void;
}

export function AccountUsage({
  limits,
  now,
  testId,
  pin,
}: {
  limits: UsageLimits;
  /** Anchor for the countdown, the hairline and the age. Defaults to the snapshot's arrival. */
  now?: number;
  testId?: string;
  /** Omitted, the rows carry no pin. */
  pin?: UsageWindowPin;
}) {
  if (limits.unavailable !== undefined) {
    if (limits.unavailable.reason === "unsupported")
      return (
        <div data-testid={testId}>
          <PanelEmptyState illustration="board" status="unavailable" title="No usage windows" />
        </div>
      );
    return (
      <p data-testid={testId} className="mb-4 text-ui text-muted-foreground last:mb-0">
        Couldn't read usage limits
      </p>
    );
  }
  if (limits.windows.length === 0) return null;
  // One anchor per snapshot: the windows remount when a snapshot with a new
  // `checkedAt` arrives, and only then. The holder hands back the very same
  // object when nothing changed, so a confirming inspection keeps the key and
  // the anchor with it.
  return (
    <UsageWindows key={limits.checkedAt} limits={limits} now={now} testId={testId} pin={pin} />
  );
}

function UsageWindows({
  limits,
  now,
  testId,
  pin,
}: {
  limits: UsageLimits;
  now: number | undefined;
  testId: string | undefined;
  pin: UsageWindowPin | undefined;
}) {
  // Taken once, before anything draws, and held for this snapshot's life.
  const [at] = React.useState(() => now ?? Date.now());
  return (
    // Every step is on the spacing ladder (docs/DESIGN.md). No negative top
    // margin: it would render above the accordion content's top edge, which
    // clips for the open/close animation, and slice the first line's
    // ascenders (VC-352). The trigger's own `py-2` is the pocket that binds
    // this block to the row that named the account.
    <div data-testid={testId} className="mb-4 flex flex-col gap-2 last:mb-0">
      {limits.windows.map((window) => (
        <UsageWindowRow key={window.id} window={window} now={at} pin={pin} />
      ))}
    </div>
  );
}

function UsageWindowRow({
  window,
  now,
  pin,
}: {
  window: UsageWindow;
  now: number;
  pin: UsageWindowPin | undefined;
}) {
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

  const ink =
    tone === "critical"
      ? "var(--destructive)"
      : tone === "attention"
        ? "var(--attention)"
        : "var(--primary)";
  return (
    <div className="usage-instrument flex items-center gap-2 rounded-control border border-border/50 p-2">
      <span role="img" aria-label={summary} title={summary} className="relative size-12 shrink-0">
        <svg viewBox="0 0 100 100" aria-hidden className="size-full">
          <circle
            cx="50"
            cy="50"
            r="42"
            fill="none"
            stroke="var(--muted-foreground)"
            strokeOpacity=".3"
            strokeWidth="7"
          />
          <circle
            data-tone={tone}
            cx="50"
            cy="50"
            r="42"
            fill="none"
            stroke={ink}
            strokeWidth="7"
            strokeLinecap={remaining > 0 ? "round" : "butt"}
            strokeDasharray={`${(remaining / 100) * 264} 264`}
            transform="rotate(-90 50 50)"
          />
          {evenAt === null ? null : (
            <path
              d="M50 2v12"
              stroke="var(--foreground)"
              strokeWidth="2"
              data-time-left={evenAt}
              transform={`rotate(${evenAt * 3.6} 50 50)`}
            />
          )}
        </svg>
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center text-ui tabular-nums"
        >
          {remaining}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          <span className="text-ui font-medium break-words">{window.label}</span>
          <span className="text-ui tabular-nums" style={{ color: ink }}>
            {window.usedPercent > 100
              ? `${Math.round(window.usedPercent - 100)}% over`
              : `${remaining}% left`}
          </span>
        </span>
        {resetsIn === null ? null : (
          <span className="text-ui tabular-nums text-muted-foreground">{resetsIn}</span>
        )}
      </span>
      {pin === undefined ? null : (
        <PinButton
          label={window.label}
          pinned={pin.isPinned(window.id)}
          onPress={() => pin.toggle(window.id)}
        />
      )}
    </div>
  );
}

/**
 * The pin at the end of a window's first line.
 *
 * Always drawn rather than revealed on hover: the ticket that added it was
 * filed because nobody could find a way to pin, and a control that appears
 * only under the pointer is one a person has to already know is there. It
 * stays quiet instead — muted outline at rest, the foreground's filled pin
 * once pressed — so a list of six accounts is not a column of loud buttons.
 *
 * Sized to the 20px `icon-xs` rung and pulled into the line's own height, so
 * a row with a pin is the same height as one without: the bar below it must
 * not move when a host starts offering pins.
 */
function PinButton({
  label,
  pinned,
  onPress,
}: {
  label: string;
  pinned: boolean;
  onPress(): void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={pinned ? `Unpin ${label} from the window bar` : `Pin ${label} to the window bar`}
      aria-pressed={pinned}
      title={pinned ? "Unpin from the window bar" : "Pin to the window bar"}
      onClick={onPress}
      className="-my-1 self-center"
    >
      <PinIcon
        strokeWidth={2.25}
        className={pinned ? "text-foreground" : "text-muted-foreground"}
      />
    </Button>
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
