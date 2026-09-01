/**
 * The Ticket rail's usage card — what this Ticket cost, and which of its
 * Sessions spent it.
 *
 * WHY THE PER-SESSION BREAKDOWN LIVES BEHIND A ROW. The Ticket rail has no
 * "session in front" block — it is Repository, then Properties, then a roster —
 * so a ticket Session's own cost has nowhere obvious to go. The two alternatives
 * were both worse: adding a facts block would duplicate Home's Session block one
 * rail over, and hanging a figure off each roster row would put a second
 * trailing number on rows that were deliberately reduced to one line, where
 * status and age already outrank cost as navigation facts.
 *
 * A breakdown OF this total belongs behind this total, and since VC-203 it is
 * behind its own row rather than behind the whole card: "N sessions" is the
 * question the popover answers, so the row that opens it is the one that asks
 * it. That also frees the face to be a figure rather than a trigger with four
 * lines of cargo.
 *
 * THERE IS STILL NO BY-MODEL LIST HERE. The Home rail's Project card carries the
 * full ranking, and a second copy would be a second opinion about the same
 * money — the failure `session-usage-report.ts` refuses at the arithmetic level
 * and this file refuses at the surface level. What the card knows is its TOP
 * model, which is one fact rather than a ranking, and it says it in the face's
 * popover where it qualifies the figure instead of costing a line on the card.
 */
import { ChartDonutIcon } from "@phosphor-icons/react/dist/csr/ChartDonut";

import type { SessionUsageSummary } from "@volli/shared";

import {
  UsageBreakdown,
  UsageBreakdownFact,
  UsageCard,
  UsageCardHero,
  UsageCardRow,
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
  // to report, and a card saying so would be furniture on every fresh Ticket in
  // the project — the same silence the repository card keeps at a clean tree.
  if (cost === null) return null;

  return (
    // `pt-4` on the card's own wrapper rather than on the rail's: this block is
    // absent for a Ticket that never metered a call, and a wrapper in the rail
    // that paid the padding would leave the gap behind whether or not anything
    // arrived to fill it.
    <div className={cn("pt-4", className)}>
      <UsageCard testId="ticket-usage-card">
        <UsageCardHero name="Ticket usage" cost={cost} summary={summary}>
          <UsageBreakdown title="Ticket usage" summary={summary}>
            {topModelLabel === null ? null : (
              <UsageBreakdownFact label="Top model" value={topModelLabel} />
            )}
          </UsageBreakdown>
        </UsageCardHero>

        {sessions.length > 0 ? (
          <UsageCardRow
            icon={ChartDonutIcon}
            label={`${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}
            ariaLabel={`${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} — open the per-session breakdown`}
            testId="ticket-usage-sessions"
          >
            {/* A Session that recorded nothing still appears, at `—`. Dropping it
                would make these rows fail to add up to the total above them, and
                the reader would have no way to see that a manual companion is
                where the missing work went. */}
            <UsageRankList heading="By session" rows={sessions} />
          </UsageCardRow>
        ) : null}
      </UsageCard>
    </div>
  );
}
