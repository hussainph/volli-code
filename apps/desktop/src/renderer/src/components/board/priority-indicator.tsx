import { TICKET_PRIORITY_LABELS, type TicketPriority } from "@volli/shared";

/**
 * All three fills are tokens, so the ladder survives a mode flip: the raw slate
 * and tan hexes this used to carry were picked against a near-black card and
 * both drop under 2:1 on a light one — a priority signal that quietly stops
 * being a signal.
 *
 * The ladder still reads as one: muted grey → the accent at body-copy lightness
 * → the hue-locked red. Each is solved against the surface it is drawn on, in
 * whichever mode is running.
 */
const FILLED_COLOR: Record<TicketPriority, string> = {
  low: "var(--muted-foreground)",
  medium: "var(--primary-text)",
  high: "var(--destructive)",
};
const UNFILLED_COLOR = "var(--border-strong)";

const FILLED_COUNT: Record<TicketPriority, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const BAR_HEIGHTS = [4, 7, 10];

/** Linear-style 3-bar priority signal: stair-step bars, bottom-aligned. */
export function PriorityIndicator({ priority }: { priority: TicketPriority }) {
  const filled = FILLED_COUNT[priority];
  const label = TICKET_PRIORITY_LABELS[priority];

  return (
    <div
      className="flex items-end gap-[1px]"
      role="img"
      aria-label={`Priority: ${label}`}
      title={label}
    >
      {BAR_HEIGHTS.map((height, index) => (
        <div
          key={height}
          className="w-[2px] rounded-[1px]"
          style={{
            height,
            backgroundColor: index < filled ? FILLED_COLOR[priority] : UNFILLED_COLOR,
          }}
        />
      ))}
    </div>
  );
}
