/**
 * The Ticket rail's USAGE card — what this Ticket cost, and which of its
 * Sessions spent it.
 *
 * WHY THE PER-SESSION BREAKDOWN LIVES IN THIS CARD'S POPOVER. The Ticket rail
 * has no "session in front" block — it is Repository, then Properties, then a
 * roster — so a ticket Session's own cost has nowhere obvious to go. The two
 * alternatives were both worse: adding a facts block would duplicate Home's
 * Session block one rail over, and hanging a figure off each roster row would
 * put a second trailing number on rows that were deliberately reduced to one
 * line, where status and age already outrank cost as navigation facts.
 *
 * A popover on the aggregate is the placement that adds no block and touches no
 * row, and it happens to be the honest shape of the question: "which Session on
 * this Ticket cost the most" is a breakdown OF this total, so it belongs behind
 * this total.
 *
 * THERE IS NO BY-MODEL LIST HERE. The card already names the top model, and the
 * Home rail's Project block carries the full ranking. A second copy would be a
 * second opinion about the same money, which is the failure
 * `session-usage-report.ts` refuses at the arithmetic level and this file
 * refuses at the surface level.
 */
import type { SessionUsageSummary } from "@volli/shared";

import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { UsageBar, UsageClassRows } from "@renderer/components/usage/usage-bar";
import { UsageRankRow } from "@renderer/components/usage/project-usage-block";
import { formatTokens } from "@renderer/chat/context-usage";
import { cn } from "@renderer/lib/utils";
import {
  formatCachedShare,
  formatUsageCost,
  totalUsageTokens,
  usageBasisLine,
  type UsageGroupRow,
} from "@renderer/usage/usage-format";

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
  // the project — the same silence the Venue card keeps at zero loose files.
  if (cost === null) return null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <SectionHeading as="h3">Usage</SectionHeading>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Ticket usage ${cost} — open breakdown`}
            className="flex w-full cursor-pointer flex-col gap-2 rounded-row border border-border bg-card p-4 text-left transition-colors hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
          >
            <TicketUsageFace
              summary={summary}
              cost={cost}
              sessionCount={sessions.length}
              topModelLabel={topModelLabel}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="left" className="w-72 p-4">
          <TicketUsageBreakdown summary={summary} cost={cost} sessions={sessions} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** The card's own face: the figure, the picture, and the two lines that read it. */
function TicketUsageFace({
  summary,
  cost,
  sessionCount,
  topModelLabel,
}: {
  summary: SessionUsageSummary;
  cost: string;
  sessionCount: number;
  topModelLabel: string | null;
}) {
  const tokens = totalUsageTokens(summary);
  const cached = formatCachedShare(summary);
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-heading tabular-nums text-foreground">{cost}</span>
        <span className="shrink-0 text-ui text-muted-foreground tabular-nums">
          {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
        </span>
      </div>
      {tokens > 0 ? <UsageBar summary={summary} /> : null}
      {tokens > 0 ? (
        <span className="text-ui text-muted-foreground tabular-nums">
          {formatTokens(tokens)} tokens{cached === null ? "" : ` · ${cached} cached`}
        </span>
      ) : null}
      {/* Drops first at the narrow floor: the model is the least load-bearing
          line on the card, and the bar above it is the cheapest information per
          pixel the card has. */}
      {topModelLabel === null ? null : (
        <span className="w-full truncate text-ui text-muted-foreground group-data-[narrow=true]/rail:hidden">
          {topModelLabel}
        </span>
      )}
    </>
  );
}

function TicketUsageBreakdown({
  summary,
  cost,
  sessions,
}: {
  summary: SessionUsageSummary;
  cost: string;
  sessions: readonly UsageGroupRow[];
}) {
  const cached = formatCachedShare(summary);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ui font-medium">Ticket usage</span>
          <span className="text-ui tabular-nums text-foreground">{cost}</span>
        </div>
        <p className="text-ui text-muted-foreground">{usageBasisLine(summary)}</p>
      </div>

      <div className="flex flex-col gap-2">
        <UsageClassRows summary={summary} />
        {cached === null ? null : (
          <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
            <span className="text-ui text-muted-foreground">Cached input share</span>
            <span className="text-ui tabular-nums text-foreground">{cached}</span>
          </div>
        )}
      </div>

      {sessions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SectionHeading as="p">By session</SectionHeading>
          <dl className="flex flex-col gap-2">
            {sessions.map((session) => (
              // A Session that recorded nothing still appears, at `—`. Dropping
              // it would make these rows fail to add up to the total above them,
              // and the reader would have no way to see that a manual companion
              // is where the missing work went.
              <UsageRankRow key={session.key} row={session} />
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
