/**
 * The Home rail's PROJECT block — what this project has cost, and where it went.
 *
 * WHY THE HEADING SAYS "PROJECT" AND NOT "USAGE". The Now page already answers
 * two scopes above this one (Venue, Session), and the Session block carries its
 * own cost facts. A block headed "Usage" under a block that also reports usage
 * is two sections with one name, and a reader has to open both to learn which
 * is which. Naming the SCOPE instead makes the page read as three nested
 * answers to one question — where am I, what is in front, what is all of this
 * costing — with money as one fact each scope happens to carry.
 *
 * The window control trails the heading rather than sitting in the card,
 * because that is the placement `ui/segmented.tsx` names for its `sm` rung, and
 * because a control inside the card would compete with the hero figure for the
 * first line.
 *
 * A CARD, where the Session block above is a bare `<dl>`, because this block is
 * a heterogeneous cluster — a hero figure, a picture, a ranked list and a
 * footnote — and the card's edge is what says those four things are one answer.
 * It takes `VenueCard`'s treatment exactly so the rail has two cards that are
 * plainly the same kind of object.
 */
import type { SessionUsageSummary } from "@volli/shared";

import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Segmented } from "@renderer/components/ui/segmented";
import { UsageBar } from "@renderer/components/usage/usage-bar";
import { formatTokens } from "@volli/session-presentation";
import { cn } from "@renderer/lib/utils";
import {
  formatCachedShare,
  formatUsageCost,
  totalUsageTokens,
  usageBasisLine,
  USAGE_WINDOWS,
  type UsageGroupRow,
  type UsageWindow,
} from "@renderer/usage/usage-format";

/** How many models the card ranks before it stops and counts the rest. */
const RANKED_MODELS = 3;

export function ProjectUsageBlock({
  summary,
  models,
  sessionCount,
  meteredSessionCount,
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
  window: UsageWindow;
  onWindowChange(next: UsageWindow): void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <SectionHeading as="h3">Project</SectionHeading>
        <Segmented
          ariaLabel="Usage window"
          value={window}
          options={USAGE_WINDOWS}
          size="sm"
          onChange={onWindowChange}
        />
      </div>
      <ProjectUsageCard
        summary={summary}
        models={models}
        sessionCount={sessionCount}
        meteredSessionCount={meteredSessionCount}
      />
    </div>
  );
}

function ProjectUsageCard({
  summary,
  models,
  sessionCount,
  meteredSessionCount,
}: {
  summary: SessionUsageSummary;
  models: readonly UsageGroupRow[];
  sessionCount: number;
  meteredSessionCount: number;
}) {
  const cost = formatUsageCost(summary);

  // Nothing metered is not a free project — it is an unmeasured one, and the
  // card says which. `$0.00` here would be the single most misleading string
  // this feature could print.
  if (cost === null) {
    return (
      <div className="rounded-row border border-border bg-card p-4">
        <p className="text-ui text-muted-foreground">No metered model calls yet</p>
        {sessionCount > 0 ? (
          <p className="mt-2 text-ui text-muted-foreground tabular-nums">
            {sessionCount} {sessionCount === 1 ? "session" : "sessions"} · none metered
          </p>
        ) : null}
      </div>
    );
  }

  const tokens = totalUsageTokens(summary);
  const cached = formatCachedShare(summary);
  const ranked = models.slice(0, RANKED_MODELS);
  const remaining = models.length - ranked.length;

  return (
    <div className="flex flex-col gap-4 rounded-row border border-border bg-card p-4">
      <div className="flex flex-col gap-2">
        {/* text-heading, not text-title: the rail's widest content box is 268px
            and the ticket title is the only 24px text in the app. */}
        <p className="text-heading tabular-nums text-foreground">{cost}</p>
        <p className="text-ui text-muted-foreground">{usageBasisLine(summary)}</p>
      </div>

      {tokens > 0 ? (
        <div className="flex flex-col gap-2">
          <UsageBar summary={summary} />
          {/* Tokens and cache, never cost — the bar divides tokens, and a
              dollar figure on this line would invite reading the cached share
              as a share of spend. It is close to the opposite. */}
          <p className="text-ui text-muted-foreground tabular-nums">
            {formatTokens(tokens)} tokens{cached === null ? "" : ` · ${cached} cached`}
          </p>
        </div>
      ) : null}

      {ranked.length > 0 ? (
        <dl className="flex flex-col gap-2">
          {ranked.map((model) => (
            <UsageRankRow key={model.key} row={model} />
          ))}
          {remaining > 0 ? (
            <p className="text-ui text-muted-foreground tabular-nums">
              +{remaining} more {remaining === 1 ? "model" : "models"}
            </p>
          ) : null}
        </dl>
      ) : null}

      {/* Both counts, always. Reporting only the metered ones would make an
          honest gap — a manual terminal companion Volli never mediated — look
          like a Session that happened to be free. */}
      <p className="text-ui text-muted-foreground tabular-nums">
        {sessionCount} {sessionCount === 1 ? "session" : "sessions"} · {meteredSessionCount} metered
      </p>
    </div>
  );
}

/**
 * One ranked row: what it is, and what it cost.
 *
 * The label truncates and the figure never does — a model name losing its
 * version suffix is a smaller loss than a price losing a digit, and the figure
 * is the column the eye is scanning down.
 */
export function UsageRankRow({ row }: { row: UsageGroupRow }) {
  const cost = formatUsageCost(row.usage);
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="min-w-0 truncate text-ui text-foreground">{row.label}</dt>
      <dd className="shrink-0 text-ui tabular-nums text-muted-foreground">{cost ?? "—"}</dd>
    </div>
  );
}
