/**
 * The Home rail's usage card — what this project has cost, where it went, and
 * what the Session in front is contributing to it.
 *
 * ONE CARD, TWO SCOPES, and that is the change VC-203 made. The Session's own
 * cost used to be three key/value rows (Cost / Tokens / Cached input) mounted
 * inside the Session block's `<dl>`, a whole section above the Project card that
 * reported the same kind of number in a completely different drawing. The
 * argument for that placement was real — cost is a property of the Session, not
 * a subject of its own — but the result was two usage readouts on one page that
 * shared no shape, no container and no notation, with the smaller one sitting
 * above the larger. Whatever it was in principle, on screen it read as a stray
 * fragment.
 *
 * So the Session is a ROW of this card now. The principle survives intact: the
 * row is a fact about the Session, not a section headed with its name, and it
 * still renders nothing at all for a Session that has metered nothing (a
 * terminal companion, a chat before its first reply — see the notes on absence
 * in `usage/usage-format.ts`). What changes is that both scopes are drawn by one
 * component in one frame, so the page has a single answer to "what is this
 * costing" with the narrower scope nested inside the broader one.
 *
 * WHY THE PROJECT IS THE HERO AND THE SESSION IS THE ROW. The card sits in the
 * Now page's Project slot, so the project is its subject; and the structure has
 * to hold still. A card whose hero swapped scopes as Sessions came and went
 * would restructure itself under the reader several times an hour. The Session
 * arriving and leaving as one row is a change the eye can follow.
 *
 * THE WINDOW CONTROL STAYS ON THE HEADING, not in the card. That is the
 * placement `ui/segmented.tsx` names for its `sm` rung, and a control inside the
 * card would compete with the hero figure for the first line — the exact
 * crowding this redesign exists to undo. It also has to stay visible: the window
 * is what the figure MEANS, and a total whose period is one popover away is a
 * number a reader can misread without noticing.
 */
import { ChartDonutIcon } from "@phosphor-icons/react/dist/csr/ChartDonut";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";

import type { SessionUsageSummary } from "@volli/shared";

import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Segmented } from "@renderer/components/ui/segmented";
import {
  UsageBreakdown,
  UsageBreakdownFact,
  UsageCard,
  UsageCardEmptyFace,
  UsageCardHero,
  UsageCardRow,
  UsageRankList,
} from "@renderer/components/usage/usage-card";
import { cn } from "@renderer/lib/utils";
import {
  formatUsageCost,
  USAGE_WINDOWS,
  type UsageGroupRow,
  type UsageWindow,
} from "@renderer/usage/usage-format";

export function HomeUsageBlock({
  summary,
  models,
  sessionCount,
  meteredSessionCount,
  session,
  window,
  onWindowChange,
  className,
}: {
  summary: SessionUsageSummary;
  /** Already ordered by known cost, descending — `reportSessionUsage` does this. */
  models: readonly UsageGroupRow[];
  /** Every durable Session in the project, metered or not. */
  sessionCount: number;
  meteredSessionCount: number;
  /**
   * The Session in front, when it has metered something. `null` for a terminal
   * companion, for a chat before its first reply, and for the Board tab — all
   * three are unmeasured rather than free, and the row is absent rather than
   * dashed.
   */
  session: SessionUsageSummary | null;
  window: UsageWindow;
  onWindowChange(next: UsageWindow): void;
  className?: string;
}) {
  return (
    // `pt-4` here rather than on the rail's wrapper: this block renders nothing
    // when the reader has turned cost off, and a wrapper that pays the padding
    // would leave sixteen pixels of dead rail behind an absent card.
    <div className={cn("flex flex-col gap-2 pt-4", className)}>
      <div className={cn("flex items-center justify-between gap-2", RAIL_PANEL_INSET)}>
        <SectionHeading as="h3">Project</SectionHeading>
        <Segmented
          ariaLabel="Usage window"
          value={window}
          options={USAGE_WINDOWS}
          size="sm"
          onChange={onWindowChange}
        />
      </div>
      <HomeUsageCard
        summary={summary}
        models={models}
        sessionCount={sessionCount}
        meteredSessionCount={meteredSessionCount}
        session={session}
      />
    </div>
  );
}

function HomeUsageCard({
  summary,
  models,
  sessionCount,
  meteredSessionCount,
  session,
}: {
  summary: SessionUsageSummary;
  models: readonly UsageGroupRow[];
  sessionCount: number;
  meteredSessionCount: number;
  session: SessionUsageSummary | null;
}) {
  const cost = formatUsageCost(summary);
  const sessionCost = session === null ? null : formatUsageCost(session);
  // Both counts, always. Reporting only the metered ones would make an honest
  // gap — a manual terminal companion Volli never mediated — look like a Session
  // that happened to be free.
  const tally = `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"} · ${meteredSessionCount} metered`;

  return (
    <UsageCard testId="home-usage-card">
      {cost === null ? (
        <UsageCardEmptyFace detail={sessionCount > 0 ? tally : null} />
      ) : (
        <UsageCardHero name="Project usage" cost={cost} summary={summary}>
          <UsageBreakdown title="Project usage" summary={summary}>
            <UsageBreakdownFact label="Sessions" value={tally} />
          </UsageBreakdown>
        </UsageCardHero>
      )}

      {/* The narrower scope, under the broader one it is part of. Never above
          it: this row is a contribution to the figure on the face, and a reader
          who meets it first has to work out which of two totals they are
          holding. */}
      {session !== null && sessionCost !== null ? (
        <UsageCardRow
          icon={ChatCircleIcon}
          label="This session"
          trailing={sessionCost}
          ariaLabel={`This session ${sessionCost} — open breakdown`}
          testId="home-usage-session"
        >
          <UsageBreakdown title="This session" summary={session} />
        </UsageCardRow>
      ) : null}

      {models.length > 0 ? (
        <UsageCardRow
          icon={ChartDonutIcon}
          label={`${models.length} ${models.length === 1 ? "model" : "models"}`}
          ariaLabel={`${models.length} ${models.length === 1 ? "model" : "models"} — open the per-model breakdown`}
          testId="home-usage-models"
        >
          <UsageRankList heading="By model" rows={models} />
        </UsageCardRow>
      ) : null}
    </UsageCard>
  );
}
