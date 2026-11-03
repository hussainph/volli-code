/** Ticket usage stays pinned beneath Now. Tokens and cost share the header,
 * with a colour-owned token bar below. Attribution folds upward into a bounded
 * scroller, leaving the pressed trigger in place. Unmetered Tickets stay silent.
 * Summaries and fold state are props; usage-rail.tsx owns the live reads. */
import { ReceiptIcon } from "@phosphor-icons/react/dist/csr/Receipt";

import type { SessionUsageSummary } from "@volli/shared";

import {
  RAIL_FOOTER,
  RAIL_FOOTER_ROW,
  RAIL_PANEL_INSET,
  RailFold,
  RailFoldBody,
  RailFoldCaret,
  RailFoldTrigger,
} from "@renderer/components/ticket/rail-panel-parts";
import { UsageBar } from "@renderer/components/usage/usage-bar";
import {
  UsageBreakdownFact,
  UsageSummaryFigure,
  UsageRankList,
  UsageRowSubject,
} from "@renderer/components/usage/usage-card";
import { cn } from "@renderer/lib/utils";
import { tokenCountLabel } from "./usage-token-count";
import {
  formatCachedShare,
  formatUsageCost,
  totalUsageTokens,
  type UsageGroupRow,
} from "@renderer/usage/usage-format";

export function TicketUsageBlock({
  summary,
  sessions,
  topModel,
  className,
  open = false,
  onOpenChange,
}: {
  summary: SessionUsageSummary;
  /** Every Session that ran on this Ticket, ordered by known cost, descending. */
  sessions: readonly UsageGroupRow[];
  /**
   * The model with the most known spend, as its row — already named against the
   * catalogue and carrying the identity its mark is drawn from. Its NAME is
   * what the fact says and never its cost: this is one fact, not the ranking,
   * which stays Home's alone (see above).
   */
  topModel: UsageGroupRow | null;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const cost = formatUsageCost(summary);
  // Absent, not empty. A Ticket whose Sessions never called a model has nothing
  // to report, and a footer saying so would be furniture on every fresh Ticket
  // in the project. The page then simply ends at its scroller.
  if (cost === null) return null;
  const tokens = totalUsageTokens(summary);
  const cached = formatCachedShare(summary);

  return (
    <RailFold asChild open={open} onOpenChange={onOpenChange}>
      {/* `RAIL_FOOTER` is `shrink-0` for the reason the card frame is: this sits
          beside a `min-h-0 flex-1` scroller, and a footer that could shrink
          would be the member flexbox compresses first when the roster inside
          that scroller grows. */}
      <footer
        data-testid="ticket-usage-card"
        className={cn(RAIL_FOOTER, "usage-instrument", className)}
      >
        {/* The body comes BEFORE the row in the DOM: it opens upward. */}
        <RailFoldBody>
          <div
            data-testid="ticket-usage-body"
            className={cn(
              // `overscroll-contain` so reaching the end of this list does not
              // hand the wheel to the Now scroller behind it.
              "flex max-h-40 flex-col gap-3 overflow-y-auto overscroll-contain border-b border-sidebar-border/70 pt-3 pb-4",
              RAIL_PANEL_INSET,
            )}
          >
            {cached !== null || topModel !== null ? (
              <div className="flex flex-col gap-2">
                {cached === null ? null : (
                  <UsageBreakdownFact label="Cached input share" value={cached} />
                )}
                {topModel === null ? null : (
                  <UsageBreakdownFact
                    label="Top model"
                    value={<UsageRowSubject row={topModel} />}
                  />
                )}
              </div>
            ) : null}
            {/* A Session that recorded nothing still appears, at `—`. Dropping it
                would make these rows fail to add up to the total above them, and
                the reader would have no way to see that a manual companion is
                where the missing work went. */}
            {sessions.length > 0 ? <UsageRankList heading="By session" rows={sessions} /> : null}
          </div>
        </RailFoldBody>
        <RailFoldTrigger asChild>
          <button
            type="button"
            data-testid="ticket-usage"
            aria-label={`Ticket usage ${tokenCountLabel(tokens)}, ${cost} — ${open ? "hide" : "show"} breakdown`}
            className={cn(RAIL_FOOTER_ROW, "py-2")}
          >
            <ReceiptIcon className="size-4 shrink-0 text-muted-foreground" />
            <UsageSummaryFigure summary={summary} />
            <RailFoldCaret open={open} placement="footer" />
          </button>
        </RailFoldTrigger>
        {tokens > 0 ? (
          <div className={cn(RAIL_PANEL_INSET, "pb-4")}>
            <UsageBar summary={summary} />
          </div>
        ) : null}
      </footer>
    </RailFold>
  );
}
