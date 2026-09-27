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
 * behind that one row, so nothing the surface used to say has been retired,
 * only demoted to an answer.
 *
 * WHY A FOOTER AND NOT A BLOCK. The other blocks on Now are things a person
 * works IN: they edit the properties, press the automations, open the
 * sessions. Cost is the one thing on the page that is only ever read, and a
 * read-only fact stacked among acts has the worst of both — it takes a turn in
 * the reading order it does not need, and it scrolls out of sight exactly when
 * the roster above it has grown long enough to make the question interesting.
 * Pinned under the scroller it costs one row of the resting view, always, and
 * is never somewhere you have to scroll to find. It wears a top rule instead
 * of the card frame for the same reason a footer is not a card: the boundary
 * it needs is with the page above it, not around itself.
 *
 * WHY A FOLD, NOT A POPOVER (VC-406, second pass). The row used to open its
 * breakdown in a popover. A popover is a window OVER the page: it closes the
 * moment the reader looks elsewhere, and it cannot be read beside the roster
 * it qualifies. A body that unfolds under its own row is part of the page and
 * stays open until it is closed. The body opens UPWARD, into the room the
 * scroller gives back, because the row is pinned at the bottom of the rail
 * and the thing the pointer is on must not move out from under it — the
 * rail's one fold (`rail-panel-parts.tsx`) carries the rule and the motion.
 *
 * THE BODY IS NOT THE POPOVER'S BODY. A popover has no height budget, so it
 * could afford to restate the figure, name the total tokens the row already
 * prints, and spell the bar's four classes out as a legend under it — about
 * 400px, which as an in-rail body pushed the Automations block out of the
 * scroller entirely (drawn and rejected in the comparison scratch). Every line
 * here costs the roster a line, so the body keeps what the ROW does not say:
 * the bar (its legend lives in its accessible name), the basis sentence, the
 * cached share, the top model, and the per-Session ranking.
 *
 * THERE IS STILL NO BY-MODEL LIST HERE. The Home rail's Project card carries the
 * full ranking, and a second copy would be a second opinion about the same
 * money — the failure `session-usage-report.ts` refuses at the arithmetic level
 * and this file refuses at the surface level. What the card knows is its TOP
 * model, which is one fact rather than a ranking, and it says it in the body
 * where it qualifies the figure instead of costing a line on the face.
 *
 * `open`/`onOpenChange` are PROPS, not a store read: this file stays pure over
 * its summary so the UI lab can mount it against fixtures; the connected
 * wrapper in `usage-rail.tsx` reads and writes `railFolds.usage`.
 */
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
  type UsageGroupRow,
} from "@renderer/usage/usage-format";

export function TicketUsageBlock({
  summary,
  sessions,
  topModelLabel,
  className,
  open = false,
  onOpenChange,
}: {
  summary: SessionUsageSummary;
  /** Every Session that ran on this Ticket, ordered by known cost, descending. */
  sessions: readonly UsageGroupRow[];
  /** The model with the most known spend, already resolved to a display label. */
  topModelLabel: string | null;
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
  const basis = usageBasisLine(summary);
  const cached = formatCachedShare(summary);

  return (
    <RailFold asChild open={open} onOpenChange={onOpenChange}>
      {/* `RAIL_FOOTER` is `shrink-0` for the reason the card frame is: this sits
          beside a `min-h-0 flex-1` scroller, and a footer that could shrink
          would be the member flexbox compresses first when the roster inside
          that scroller grows. */}
      <footer data-testid="ticket-usage-card" className={cn(RAIL_FOOTER, className)}>
        {/* The body comes BEFORE the row in the DOM: it opens upward. */}
        <RailFoldBody>
          <div
            className={cn(
              "flex flex-col gap-3 border-b border-sidebar-border/70 pt-3 pb-4",
              RAIL_PANEL_INSET,
            )}
          >
            {tokens > 0 ? <UsageBar summary={summary} /> : null}
            {basis === null ? null : <p className="text-ui text-muted-foreground">{basis}</p>}
            {cached !== null || topModelLabel !== null ? (
              <div className="flex flex-col gap-2">
                {cached === null ? null : (
                  <UsageBreakdownFact label="Cached input share" value={cached} />
                )}
                {topModelLabel === null ? null : (
                  <UsageBreakdownFact label="Top model" value={topModelLabel} />
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
            aria-label={`Ticket usage ${cost} — ${open ? "hide" : "show"} breakdown`}
            className={RAIL_FOOTER_ROW}
          >
            <ReceiptIcon className="size-4 shrink-0 text-muted-foreground" />
            <UsageCostFigure
              summary={summary}
              className="shrink-0 text-ui font-medium text-foreground"
            />
            <span className="min-w-0 flex-1 truncate text-right text-ui text-muted-foreground tabular-nums">
              {tokens > 0 ? `${formatTokens(tokens)} tokens` : ""}
            </span>
            <RailFoldCaret open={open} placement="footer" />
          </button>
        </RailFoldTrigger>
      </footer>
    </RailFold>
  );
}
