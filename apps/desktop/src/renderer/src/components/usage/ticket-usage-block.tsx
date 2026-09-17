/**
 * The Ticket rail's usage footer — what this Ticket cost, and which of its
 * Sessions spent it — at one row, PINNED under the Now page (VC-406).
 *
 * WHY ONE ROW. The card used to open with the hero: an 18px figure, the token
 * bar, a caption, then a seamed "N sessions" row with its own popover — about
 * 120px for a fact the owner glances at. On a page whose most-read block is a
 * roster of Sessions, that made cost the tallest object in the rail and the
 * roster the thing under it. Cost is worth one row of unprompted pixels: the
 * figure, the token count, and the caret. Everything else the hero carried is
 * behind that one row, in one popover — the bar and its legend, the cached
 * share, the basis sentence, the top model and the per-Session ranking — so
 * nothing the surface used to say has been retired, only demoted to an answer.
 *
 * WHY A FOOTER AND NOT A BLOCK. The other four blocks on Now are things a
 * person works IN: they edit the properties, press the automations, open the
 * sessions. Cost is the one thing on the page that is only ever read, and a
 * read-only fact stacked among acts has the worst of both — it takes a turn in
 * the reading order it does not need, and it scrolls out of sight exactly when
 * the roster above it has grown long enough to make the question interesting.
 * Pinned under the scroller it costs one row of the resting view, always, and
 * is never somewhere you have to scroll to find. It wears a top rule instead
 * of the card frame for the same reason a footer is not a card: the boundary
 * it needs is with the page above it, not around itself.
 *
 * ONE POPOVER, NOT TWO. The Sessions row used to open a ranking of its own
 * beside the face's breakdown, and at rail width the two answered adjacent
 * questions from adjacent triggers. A breakdown OF this total belongs behind
 * this total, so the ranking now closes the same popover the figure opens.
 *
 * THERE IS STILL NO BY-MODEL LIST HERE. The Home rail's Project card carries the
 * full ranking, and a second copy would be a second opinion about the same
 * money — the failure `session-usage-report.ts` refuses at the arithmetic level
 * and this file refuses at the surface level. What the card knows is its TOP
 * model, which is one fact rather than a ranking, and it says it in the
 * popover where it qualifies the figure instead of costing a line on the card.
 */
import { ReceiptIcon } from "@phosphor-icons/react/dist/csr/Receipt";

import type { SessionUsageSummary } from "@volli/shared";

import {
  UsageBreakdown,
  UsageBreakdownFact,
  UsageCardFace,
  UsageRankList,
} from "@renderer/components/usage/usage-card";
import { cn } from "@renderer/lib/utils";
import { formatUsageCost, type UsageGroupRow } from "@renderer/usage/usage-format";

export function TicketUsageBlock({
  summary,
  sessions,
  topModelLabel,
  className,
}: {
  summary: SessionUsageSummary;
  /** Every Session that ran on this Ticket, ordered by known cost, descending. */
  sessions: readonly UsageGroupRow[];
  /** The model with the most known spend, already resolved to a display label. */
  topModelLabel: string | null;
  className?: string;
}) {
  const cost = formatUsageCost(summary);
  // Absent, not empty. A Ticket whose Sessions never called a model has nothing
  // to report, and a footer saying so would be furniture on every fresh Ticket
  // in the project — the same silence the repository card keeps at a clean
  // tree. The page then simply ends at its scroller.
  if (cost === null) return null;

  return (
    <footer
      data-testid="ticket-usage-card"
      // `shrink-0` for the reason the card frame carries it: this sits beside a
      // `min-h-0 flex-1` scroller, and a footer that could shrink would be the
      // member flexbox compresses first when the roster inside that scroller
      // grows. The rule is the page's boundary; the row inside keeps the card's
      // own geometry, so the figure sits where every other rail row's mark does.
      className={cn("shrink-0 border-t border-sidebar-border/70 bg-background/30", className)}
    >
      <UsageCardFace name="Ticket usage" summary={summary} icon={ReceiptIcon} testId="ticket-usage">
        <div className="flex flex-col gap-4">
          {/* `picture`: the bar the hero used to carry, now above the legend
              that reads it — the face no longer shows it. */}
          <UsageBreakdown title="Ticket usage" summary={summary} picture>
            {topModelLabel === null ? null : (
              <UsageBreakdownFact label="Top model" value={topModelLabel} />
            )}
          </UsageBreakdown>
          {/* A Session that recorded nothing still appears, at `—`. Dropping it
              would make these rows fail to add up to the total above them, and
              the reader would have no way to see that a manual companion is
              where the missing work went. */}
          {sessions.length > 0 ? <UsageRankList heading="By session" rows={sessions} /> : null}
        </div>
      </UsageCardFace>
    </footer>
  );
}
