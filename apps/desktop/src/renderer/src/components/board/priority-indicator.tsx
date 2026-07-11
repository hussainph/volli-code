import { TICKET_PRIORITY_LABELS, type TicketPriority } from "@volli/shared";

// Design pass pending: these three hexes (low/medium/high fill + unfilled
// gray) are a first pass, not final tokens — see docs note tracking this.
const FILLED_COLOR: Record<TicketPriority, string> = {
  low: "#7d8ca3",
  medium: "#b8935f",
  high: "var(--destructive)",
};
const UNFILLED_COLOR = "#3a3a3a";

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
