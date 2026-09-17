/**
 * The Ticket rail's usage card — what this Ticket cost, and which of its
 * Sessions spent it — at one row (VC-406).
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
  UsageCard,
  UsageCardFace,
  UsageRankList,
} from "@renderer/components/usage/usage-card";
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
  // to report, and a card saying so would be furniture on every fresh Ticket in
  // the project — the same silence the repository card keeps at a clean tree.
  // The Now page stacks with `gap`, so an absent card leaves no gap behind it.
  if (cost === null) return null;

  return (
    <UsageCard testId="ticket-usage-card" className={className}>
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
    </UsageCard>
  );
}
