import { PanelEmptyState } from "@renderer/components/ui/empty-state";
/** Cost leads the glance; exact tokens and attribution stay available on demand. */
import type * as React from "react";
import { type IconComponent, ChevronDownIcon } from "@renderer/components/ui/icon";

import type { SessionUsageSummary } from "@volli/shared";

import { ModelMark } from "@renderer/components/models/model-identity";
import {
  RAIL_CARD_FRAME,
  RAIL_CARD_ROW,
  RAIL_CARD_SEAM,
  RAIL_PANEL_MARGIN,
} from "@renderer/components/ticket/rail-panel-parts";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { ValueReveal } from "@renderer/components/ui/value-reveal";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { UsageBar, UsageClassRows } from "@renderer/components/usage/usage-bar";
import { UsageTokenCount, tokenCountLabel } from "./usage-token-count";
import { cn } from "@renderer/lib/utils";
import {
  formatCachedShare,
  formatUsageCost,
  totalUsageTokens,
  usageCostParts,
  type UsageGroupRow,
} from "@renderer/usage/usage-format";

/**
 * The hover and focus treatment every pressable part of the card wears.
 *
 * `RAIL_CARD_ROW` carries it for the one-line rows; the hero is a column rather
 * than a row, so it cannot take that constant and takes this half of it.
 */
const USAGE_CARD_PRESSABLE =
  "outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

/** The width every one of the card's popovers opens at, matching the rail's others. */
const USAGE_POPOVER = "w-72 p-4";

export function UsageCard({
  children,
  testId,
  className,
}: {
  children: React.ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section data-testid={testId} className={cn(RAIL_CARD_FRAME, RAIL_PANEL_MARGIN, className)}>
      {children}
    </section>
  );
}

/**
 * A cost, drawn: the money in the caller's ink, and the hedge after it — a
 * step smaller, muted, on the same baseline.
 *
 * ONE DRAWING FOR EVERY FIGURE the usage surfaces print, hero and row and
 * ranked line alike, because the hedge is notation and notation that is set
 * three ways is three notations. The mark is `text-label` rather than a
 * superscript or a smaller `em`: it is the one rung below `text-ui`, and it is
 * the size the rail already uses for a qualifier beside a value (a row's
 * status phrase, a History stamp). Lowercase, since the label rung's caps are
 * applied per use and a shouted ESTIMATE is the opposite of a hedge.
 *
 * Draws nothing for an unmetered summary, which is the same silence
 * `formatUsageCost` keeps: a caller that wants to know whether there IS a
 * figure asks the notation, not the drawing.
 */
export function UsageCostFigure({
  summary,
  className,
}: {
  summary: SessionUsageSummary;
  className?: string;
}) {
  const parts = usageCostParts(summary);
  if (parts === null) return null;
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-1 tabular-nums", className)}>
      <span>{parts.figure}</span>
      {parts.hedge === null ? null : (
        <span className="shrink-0 text-label text-muted-foreground">{parts.hedge}</span>
      )}
    </span>
  );
}

/** Spend answers the decision; tokens are the quiet measure of workload. */
export function UsageSummaryFigure({ summary }: { summary: SessionUsageSummary }) {
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
      <UsageCostFigure summary={summary} className="text-ui font-semibold text-foreground" />
      <UsageTokenCount
        tokens={totalUsageTokens(summary)}
        unit
        className="whitespace-nowrap text-label text-muted-foreground"
      />
    </span>
  );
}

/** One cost-led inspection target, without a meter that implies an allowance. */
export function UsageCardHero({
  name,
  cost,
  summary,
  testId,
  children,
}: {
  /** What the figure is about, for the accessible name — never drawn. */
  name: string;
  /** The figure as spoken (`formatUsageCost`) — the accessible name's half; the drawing reads `summary`. */
  cost: string;
  summary: SessionUsageSummary;
  testId?: string;
  /** The popover body: what this figure is, in words. */
  children: React.ReactNode;
}) {
  const tokens = totalUsageTokens(summary);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={`${name} ${tokenCountLabel(tokens)}, ${cost} — open breakdown`}
          className={cn(
            "flex w-full flex-col gap-2 px-4 pt-4 pb-2 text-left",
            USAGE_CARD_PRESSABLE,
          )}
        >
          <span className="flex w-full flex-wrap items-baseline gap-2">
            <UsageCostFigure
              summary={summary}
              className="text-heading font-semibold text-foreground"
            />
            <UsageTokenCount
              tokens={tokens}
              unit
              className="flex-1 text-label text-muted-foreground"
            />
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </span>
        </button>
      </PopoverTrigger>
      {/* Radix gives its content `role="dialog"`, and a dialog with no
          accessible name is announced as an unnamed one — the heading inside is
          not associated with it. The trigger's own subject names it. */}
      <PopoverContent
        aria-label={name}
        align="start"
        side="left"
        className={cn(USAGE_POPOVER, "max-h-96 overflow-y-auto overscroll-contain")}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * One seamed row under the face: a subject, optionally what it cost, and the
 * caret that opens the rest of it.
 *
 * The label truncates and the trailing figure never does — the same rule
 * {@link UsageRankRow} follows, and for the same reason: a name losing its
 * version suffix is a smaller loss than a price losing a digit.
 */
export function UsageCardRow({
  icon: Icon,
  label,
  trailing,
  ariaLabel,
  testId,
  children,
}: {
  icon: IconComponent;
  label: string;
  /** A figure parked before the caret — a cost (drawn, so its hedge is set right), a count. */
  trailing?: React.ReactNode;
  ariaLabel: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={ariaLabel}
          className={cn(RAIL_CARD_ROW, RAIL_CARD_SEAM, "min-h-8 py-2 hover:bg-accent")}
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-ui text-sidebar-foreground">{label}</span>
          {trailing === null || trailing === undefined ? null : (
            <span className="shrink-0 text-right text-ui tabular-nums text-muted-foreground">
              {trailing}
            </span>
          )}
          <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={label}
        align="start"
        side="left"
        className={cn(USAGE_POPOVER, "max-h-96 overflow-y-auto overscroll-contain")}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** Class counts, their total, cached share and any scope-specific attribution.
 * Cost retains its coverage qualifier; exact token counts remain on each value. */
export function UsageBreakdown({
  title,
  summary,
  picture = false,
  children,
}: {
  title: string;
  summary: SessionUsageSummary;
  /** Draw the class bar only when the containing face does not already show it. */
  picture?: boolean;
  /** Anything this scope adds under the legend — a ranking, a tally. */
  children?: React.ReactNode;
}) {
  const cost = formatUsageCost(summary);
  const cached = formatCachedShare(summary);
  const tokens = totalUsageTokens(summary);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ui font-medium">{title}</span>
          {cost === null ? null : (
            <UsageCostFigure summary={summary} className="text-ui text-foreground" />
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {picture ? <UsageBar summary={summary} /> : null}
        <UsageClassRows summary={summary} />
        {tokens > 0 ? (
          <UsageBreakdownFact label="Total tokens" value={<UsageTokenCount tokens={tokens} />} />
        ) : null}
        {cached === null ? null : <UsageBreakdownFact label="Cached input share" value={cached} />}
      </div>

      {children}
    </div>
  );
}

/**
 * A ranked breakdown, whole — every row, not a top three and a count of the
 * rest.
 *
 * The "+2 more" line existed because the ranking was on the card's face, where
 * three rows was already more than the surface could spend. Behind a popover
 * there is no such budget, and a truncated ranking that cannot be expanded is
 * the one shape that answers the question worse than either alternative.
 */
export function UsageRankList({
  heading,
  rows,
}: {
  heading: string;
  rows: readonly UsageGroupRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <section className="usage-rank-list shrink-0" aria-label={heading}>
      <SectionHeading as="h3" className="sr-only">
        {heading}
      </SectionHeading>
      <dl>
        {rows.map((row, index) => (
          <UsageRankRow key={row.key} row={row} heading={index === 0 ? heading : undefined} />
        ))}
      </dl>
    </section>
  );
}

/**
 * One ranked row: what it is, and what it cost.
 *
 * The label truncates and the figure never does — a model name losing its
 * version suffix is a smaller loss than a price losing a digit, and the figure
 * is the column the eye is scanning down.
 */
export function UsageRankRow({ row, heading }: { row: UsageGroupRow; heading?: string }) {
  const cost = formatUsageCost(row.usage);
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <dt className="flex min-w-0 items-center gap-2 text-ui text-foreground">
        {/* Attribution shares its first row: a bounded scroller can never leave
            a standalone heading cut off against the pinned total. */}
        {heading ? (
          <span className="shrink-0 text-label text-muted-foreground">{heading}</span>
        ) : null}
        <UsageRowSubject row={row} />
      </dt>
      <dd className="shrink-0 text-right text-ui tabular-nums text-muted-foreground">
        {cost === null ? "—" : <UsageCostFigure summary={row.usage} />}
      </dd>
    </div>
  );
}

/**
 * What a row is ABOUT: a model drawn the way the composer pill, the picker and
 * Settings draw one, or a plain truncating label for everything else.
 *
 * THE MARK IS THE MODEL'S ALONE. A Session row's glyph would be its kind, which
 * every row in that ranking shares and which therefore marks nothing; on a
 * model row the vendor is exactly the fact the eye is scanning for, so it leads
 * (`ModelMark`, the app's one drawing of it).
 *
 * THE ACCOUNT IS NOT SPELLED ON THE ROW. A rail cannot afford the "· Anthropic"
 * the roomier surfaces append — it is what pushes the NAME into an ellipsis —
 * and the mark already tells two accounts apart. `ValueReveal` hands the whole
 * identity back where it clips, on hover and on the keyboard's focus alike,
 * which is how every other rail row answers for what it truncated (VC-288).
 */
export function UsageRowSubject({ row }: { row: UsageGroupRow }) {
  const model = row.model ?? null;
  if (model === null)
    return (
      <ValueReveal
        term="Session"
        full={row.label}
        side="left"
        className="min-h-6 min-w-0 truncate rounded-sm text-left"
      >
        {row.label}
      </ValueReveal>
    );
  return (
    <>
      <ModelMark model={model.model} providerLabel={model.providerLabel} />
      <ValueReveal
        term="Model"
        full={row.label}
        side="left"
        className="min-h-6 min-w-0 truncate rounded-sm text-left"
      >
        {row.label}
      </ValueReveal>
    </>
  );
}

/**
 * One plain fact under a breakdown's legend — a tally, a top model.
 *
 * Not a {@link UsageRankRow}: those are a ranking and their trailing column is
 * always money, so a "38 sessions · 24 metered" line drawn as one would put a
 * count where every neighbour has a price.
 */
export function UsageBreakdownFact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-h-7 shrink-0 items-center justify-between gap-2 border-t border-border">
      <span className="shrink-0 text-ui text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-2 text-ui tabular-nums text-foreground">
        {/* A drawn value brings its own parts — a model's mark and its name; a
            spoken one keeps the truncating box it has always had. */}
        {typeof value === "string" ? <span className="min-w-0 truncate">{value}</span> : value}
      </span>
    </div>
  );
}

/**
 * The card's face when nothing has been metered.
 *
 * Nothing metered is not a free project — it is an unmeasured one, and the card
 * says which. `$0.00` here would be the single most misleading string this
 * feature could print. Not a trigger: there is no breakdown behind a figure
 * that does not exist.
 */
export function UsageCardEmptyFace({ detail }: { detail?: string | null }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-4">
      <PanelEmptyState illustration="board" title="No metered calls yet" />
      {detail === null || detail === undefined ? null : (
        <p className="text-ui text-muted-foreground tabular-nums">{detail}</p>
      )}
    </div>
  );
}
