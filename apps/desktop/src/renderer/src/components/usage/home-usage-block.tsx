/** One pinned spend reading for the project/session inspector. Accounting and
 * the time-window control unfold into a bounded scroller, never a dashboard. */
import { ChartDonutIcon } from "@phosphor-icons/react/dist/csr/ChartDonut";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
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
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { Segmented } from "@renderer/components/ui/segmented";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { UsageClassRows } from "@renderer/components/usage/usage-bar";
import {
  UsageBreakdown,
  UsageBreakdownFact,
  UsageCard,
  UsageCardEmptyFace,
  UsageCardHero,
  UsageCardRow,
  UsageCostFigure,
  UsageSummaryFigure,
  UsageRankList,
} from "@renderer/components/usage/usage-card";
import { cn } from "@renderer/lib/utils";
import { tokenCountLabel } from "./usage-token-count";
import {
  formatCachedShare,
  formatUsageCost,
  totalUsageTokens,
  USAGE_WINDOWS,
  type UsageGroupRow,
  type UsageWindow,
} from "@renderer/usage/usage-format";

/**
 * Home's usage FOOTER — what this project has cost, at one pinned row, with
 * everything behind it (VC-406).
 *
 * THE CARD BECAME A FOOTER for the reason the Ticket rail's did
 * (`ticket-usage-block.tsx` carries the argument in full): cost is the one
 * thing on Now that is only ever read, and a read-only fact stacked among acts
 * takes a turn in the reading order it does not need and scrolls out of sight
 * exactly when the roster above it has grown long enough to make the question
 * interesting. On Home the cost was ALSO the second of two cards under a page
 * whose approved content is one roster; pinning it is what leaves the roster
 * the page.
 *
 * WHAT THE FACE SAYS AND WHAT IT DOES NOT. The figure, the window it is read
 * through, and the caret. The window is on the face rather than only in the
 * body because it is what the figure MEANS — a total whose period is one press
 * away is a number a reader can misread without noticing — and the control
 * that changes it sits in the body, where pressing it cannot be confused with
 * opening the fold.
 *
 * THE BODY IS BOUNDED. A project can hold a dozen models and a hundred
 * Sessions, and a fold whose body is as tall as its data would push the page's
 * own scroller out of the rail. It scrolls inside a fixed budget instead, so
 * the fold's travel is the same every time and the trigger under the pointer
 * does not move by an amount that depends on the data.
 *
 * Pure over its summaries, like every drawing in this folder: the store reads
 * and the preference live in `usage-rail.tsx`, so the UI lab mounts THIS
 * component rather than a copy of it.
 */
export function HomeUsageFooter({
  summary,
  models,
  sessionCount,
  meteredSessionCount,
  session,
  window: usageWindow,
  onWindowChange,
  open = false,
  onOpenChange,
  className,
}: {
  summary: SessionUsageSummary;
  models: readonly UsageGroupRow[];
  sessionCount: number;
  meteredSessionCount: number;
  /** The Session in front, when it has metered something; `null` otherwise. */
  session: SessionUsageSummary | null;
  window: UsageWindow;
  onWindowChange(next: UsageWindow): void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const cost = formatUsageCost(summary);
  const tokens = totalUsageTokens(summary);
  const cached = formatCachedShare(summary);
  // The Session's own figure, resolved HERE rather than left to the row below:
  // `UsageCostFigure` draws nothing for a Session that metered nothing, so a
  // row guarded on `session !== null` alone printed the words "This session"
  // beside an empty space — the dashed row this surface says it refuses.
  const sessionCost = session === null ? null : formatUsageCost(session);
  const windowLabel = USAGE_WINDOWS.find((entry) => entry.key === usageWindow)?.label ?? "";
  const tally = `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"} · ${meteredSessionCount} metered`;

  return (
    <RailFold asChild open={open} onOpenChange={onOpenChange}>
      <footer data-testid="home-usage-footer" className={cn(RAIL_FOOTER, className)}>
        {/* The body comes BEFORE the row in the DOM: it opens upward. */}
        <RailFoldBody>
          <div
            data-testid="home-usage-body"
            className={cn(
              // `overscroll-contain` so reaching the end of the ranking does not
              // hand the wheel to the page scroller behind it.
              "flex max-h-40 flex-col gap-3 overflow-y-auto overscroll-contain border-b border-sidebar-border/70 pt-3 pb-4",
              RAIL_PANEL_INSET,
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <Select
                value={usageWindow}
                onValueChange={(value) => onWindowChange(value as UsageWindow)}
              >
                <SelectTrigger
                  variant="inspector"
                  size="sm"
                  aria-label="Usage window"
                  className="w-auto gap-2"
                >
                  <FunnelIcon weight="bold" className="size-3" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {USAGE_WINDOWS.map((entry) => (
                    <SelectItem key={entry.key} value={entry.key}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <UsageClassRows summary={summary} />
            <div className="flex flex-col gap-2">
              {cached === null ? null : (
                <UsageBreakdownFact label="Cached input share" value={cached} />
              )}
              {/* Both counts, always: reporting only the metered ones would make
                  an honest gap — a manual companion Volli never mediated — look
                  like a Session that happened to be free. */}
              <UsageBreakdownFact label="Sessions" value={tally} />
            </div>
            {/* The narrower scope, under the broader one it is part of — never
                above it: this is a contribution to the figure on the row, and a
                reader who meets it first has to work out which of two totals
                they are holding. Absent for a Session that metered nothing
                (a terminal companion, a chat before its first reply), which is
                unmeasured rather than free. */}
            {session === null || sessionCost === null ? null : (
              <div
                data-testid="home-usage-session"
                className="flex items-center justify-between gap-2 border-t border-border pt-2"
              >
                <span className="shrink-0 text-ui text-muted-foreground">This session</span>
                <UsageCostFigure summary={session} className="text-ui text-foreground" />
              </div>
            )}
            <UsageRankList heading="By model" rows={models} />
          </div>
        </RailFoldBody>
        <RailFoldTrigger asChild>
          <button
            type="button"
            data-testid="home-usage"
            aria-label={`Project usage ${tokenCountLabel(tokens)}, ${cost ?? "unmetered"} over ${windowLabel} — ${
              open ? "hide" : "show"
            } breakdown`}
            className={cn(RAIL_FOOTER_ROW, "py-2")}
          >
            <ReceiptIcon className="size-4 shrink-0 text-muted-foreground" />
            {cost === null ? (
              // Nothing metered is not a free project — it is an unmeasured one,
              // and `$0.00` here would be the most misleading string this
              // surface could print.
              <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
                No metered model calls yet
              </span>
            ) : (
              <>
                <UsageSummaryFigure summary={summary} />
              </>
            )}
            <span className="shrink-0 text-ui text-muted-foreground">{windowLabel}</span>
            <RailFoldCaret open={open} placement="footer" />
          </button>
        </RailFoldTrigger>
      </footer>
    </RailFold>
  );
}

/**
 * The pre-VC-406 card: the heading with its window control, and the hero under
 * it.
 *
 * NOT A PRODUCTION SURFACE ANY MORE — `usage-rail.tsx` mounts
 * {@link HomeUsageFooter}. It is kept because the UI lab still mounts it:
 * `lab/scratches/usage-surfaces.tsx` draws it beside the footer as the
 * before/after the redesign is argued from, and `lab/scratches/home-rail-now.tsx`
 * composes the pre-redesign Now page. The lab is type-checked with the app
 * (see `tsconfig.web.json`), so this export has real callers a signature change
 * would break; it is not dead code, and its behaviour is exercised where it is
 * used rather than pinned again here.
 */
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
          trailing={<UsageCostFigure summary={session} />}
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
