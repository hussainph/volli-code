/**
 * The 3.5 seconds between a Deliberate move into an armed column and the Run
 * that move starts (VC-128).
 *
 * Three things decide the shape of this surface, and all three come from
 * VC-112's ruling rather than from taste.
 *
 *  - **Exactly one control: Cancel.** It keeps the move and starts nothing.
 *    Sending the ticket back is the board's ordinary undo and is deliberately
 *    absent — two buttons inside 3.5 seconds is a choice nobody can make in
 *    time, so offering both would make the wrong one likelier, not the right
 *    one easier.
 *  - **Visible progress toward the moment.** A delay with no bar is a delay a
 *    person cannot budget against; they either stare at it or miss it. The bar
 *    and the seconds say the same thing twice on purpose — one is glanceable,
 *    the other is exact.
 *  - **Bottom centre.** The mid-drag affordance VC-112 describes lives here
 *    too, and the pointer has just finished a drag somewhere above. It is also
 *    the one edge sonner's toasts (bottom right) never occupy.
 *
 * It is NOT a sonner toast. A toast dismisses itself on a timer it owns, and
 * this window's timer is the product: the two would have to be kept in step for
 * no gain, and a swipe-dismissed toast would leave a Run about to start with
 * nothing on screen to stop it.
 *
 * Motion: the bar is information rather than decoration, so reduced motion
 * keeps it and drops only the entrance. A countdown a person is meant to act
 * inside is exactly the case where hiding the passage of time is the accessible
 * failure, not the accessible choice.
 */
import * as React from "react";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";

import { armedRunProgress, armedRunSecondsLeft, type PendingArmedRun } from "./armed-move-model";
import { cancelArmedRun, useArmedRunStore } from "./armed-run";
import { Button } from "@renderer/components/ui/button";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";

/**
 * A frame clock, running only while something is counting down.
 *
 * `requestAnimationFrame` rather than an interval because the bar and the
 * seconds must agree on one instant: two timers would drift apart within the
 * window they exist to describe. It stops the moment the last window closes, so
 * an idle board schedules nothing.
 */
function useFrameClock(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    let frame = 0;
    const tick = () => {
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return now;
}

/**
 * Every open window, newest last. Mounted once at the window level beside the
 * Toaster — a board that is not on screen can still have a countdown running
 * (a move made from a ticket's own status pill), and this must outlive the
 * board's mount either way.
 */
export function ArmedRunWindows() {
  const pending = useArmedRunStore((state) => state.pending);
  const windows = Object.values(pending).toSorted((a, b) => a.openedAt - b.openedAt);
  const now = useFrameClock(windows.length > 0);
  if (windows.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2"
      // A live region: the countdown is the only notice that a Run is about to
      // start, so a screen reader must hear it open. `polite` because it does
      // not interrupt — the Cancel button is reachable for the whole window.
      role="status"
      aria-live="polite"
    >
      {windows.map((window) => (
        <ArmedRunCard key={window.id} window={window} now={now} />
      ))}
    </div>
  );
}

function ArmedRunCard({ window, now }: { window: PendingArmedRun; now: number }) {
  const reducedMotion = useReducedMotion();
  const progress = armedRunProgress(window, now);
  const secondsLeft = armedRunSecondsLeft(window, now);
  return (
    <div
      data-armed-run-window={window.ticketId}
      className={cn(
        // `shadow-overlay` and not `shadow-card`: this floats over the whole
        // window rather than sitting on a surface (docs/DESIGN.md, Elevation),
        // which is the same tier menus, dialogs and the palette wear.
        "pointer-events-auto relative w-80 overflow-hidden rounded-container border border-border",
        "bg-popover shadow-overlay",
        // Entrance only — the bar below is information and never opts out.
        !reducedMotion && "transition-[opacity,translate] duration-200 ease-swift",
        !reducedMotion && "starting:translate-y-2 starting:opacity-0",
      )}
    >
      <div className="flex items-center gap-2 px-4 py-2">
        <LightningIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-ui text-foreground">
          {window.automationName}
          <span className="text-muted-foreground">
            {" "}
            on {window.ticketDisplayId} · {secondsLeft}s
          </span>
        </span>
        <Button
          variant="ghost"
          // Height and type come from the primitive's default size, which IS
          // the chip height (docs/DESIGN.md, Controls) — restating them here
          // would be one more place for the scale to drift out of step.
          // The one control in the window. Named for what it does to the RUN,
          // not to the move: the move is already kept.
          onClick={() => void cancelArmedRun(window.id)}
        >
          Cancel
        </Button>
      </div>
      {/* The bar rides the card's own bottom edge rather than sitting in the
          layout: it must read as the window draining, not as a third control. */}
      <div
        className="absolute inset-x-0 bottom-0 h-[2px] bg-foreground/10"
        role="progressbar"
        aria-label={`${window.automationName} starts in ${secondsLeft} seconds`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        {/* `/50` — half-present, the documented rung for a fill that must read
            clearly against the `/10` wash behind it without becoming ink. */}
        <div
          data-armed-run-progress
          className="h-full bg-foreground/50"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}
