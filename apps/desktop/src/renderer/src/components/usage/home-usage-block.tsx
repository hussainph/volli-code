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
import { UsageBar } from "@renderer/components/usage/usage-bar";
import {
  UsageBreakdown,
  UsageBreakdownFact,
  UsageCard,
  UsageCardEmptyFace,
  UsageCardHero,
  UsageCardRow,
  UsageCostFigure,
  UsageRankList,
} from "@renderer/components/usage/usage-card";
import { cn } from "@renderer/lib/utils";
import { formatTokens } from "@volli/session-presentation";
import {
  formatCachedShare,
  formatUsageCost,
  totalUsageTokens,
  usageBasisLine,
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
  const basis = usageBasisLine(summary);
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
              <SectionHeading as="p">Project usage</SectionHeading>
              <Segmented
                ariaLabel="Usage window"
                value={usageWindow}
                options={USAGE_WINDOWS}
                size="sm"
                onChange={onWindowChange}
              />
            </div>
            {tokens > 0 ? <UsageBar summary={summary} /> : null}
            {basis === null ? null : <p className="text-ui text-muted-foreground">{basis}</p>}
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
            aria-label={`Project usage ${cost ?? "unmetered"} over ${windowLabel} — ${
              open ? "hide" : "show"
            } breakdown`}
            className={RAIL_FOOTER_ROW}
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
                <UsageCostFigure
                  summary={summary}
                  className="shrink-0 text-ui font-medium text-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-right text-ui text-muted-foreground tabular-nums">
                  {tokens > 0 ? `${formatTokens(tokens)} tokens` : ""}
                </span>
              </>
            )}
            <span className="shrink-0 text-label text-muted-foreground">{windowLabel}</span>
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
