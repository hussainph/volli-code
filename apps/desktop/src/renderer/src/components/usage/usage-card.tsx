/**
 * The rail's usage surface — one framed card wearing the repository card's own
 * frame, with a hero figure and rows that reveal the rest on demand (VC-203).
 *
 * WHY THIS FILE EXISTS. The two usage blocks were drawn as `rounded-row border-
 * border bg-card` panels under a section heading, which is the treatment
 * `VenueCard` uses for a single fact — while the repository card one block up
 * the same rail is a `rounded-xl` framed surface of seamed rows on the sidebar's
 * own border and background. Two containers, two radii, two border tokens and
 * two background tokens for two blocks that sit ten pixels apart, and the usage
 * one blended into the rail while the repository one read as an object. The
 * frame here is the repository card's, spelled from the same constants, so the
 * rail has two surfaces that are plainly the same kind of thing.
 *
 * WHY EVERY ROW IS A POPOVER TRIGGER. The blocks used to print everything they
 * knew: a hero figure, a basis sentence, a bar, a caption, three ranked model
 * names, a "+N more", and a session tally — eight lines before the reader has
 * asked anything, of which one is the number they came for. That is the bulk
 * complaint, and a collapse would only have hidden the good line along with the
 * rest. So the card keeps the three things that are worth unprompted pixels —
 * the figure, the picture, and the one caption that reads the picture — and
 * every other fact moves behind the row it belongs to. Model names, operation
 * counts, cost basis and per-session rankings are all answers to a question,
 * and a question needs somewhere to be asked rather than a line to sit on.
 *
 * The caret is the affordance, and it is the repository branch row's caret at
 * the same size in the same ink: a reader who has opened that row already knows
 * what this one does.
 *
 * NOTHING HERE READS A STORE. Same reason the blocks beside it do not — see
 * `usage-rail.tsx`. These are props-in drawings so the UI lab can mount the
 * real card against fixture operations.
 */
import type * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";

import type { SessionUsageSummary } from "@volli/shared";

import {
  RAIL_CARD_FRAME,
  RAIL_CARD_ROW,
  RAIL_CARD_SEAM,
  RAIL_PANEL_MARGIN,
} from "@renderer/components/ticket/rail-panel-parts";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { UsageBar, UsageClassRows } from "@renderer/components/usage/usage-bar";
import { formatTokens } from "@volli/session-presentation";
import { cn } from "@renderer/lib/utils";
import {
  formatCachedShare,
  formatUsageCost,
  totalUsageTokens,
  usageBasisLine,
  type UsageGroupRow,
} from "@renderer/usage/usage-format";

/**
 * The hover and focus treatment every pressable part of the card wears.
 *
 * `RAIL_CARD_ROW` carries it for the one-line rows; the hero is a column rather
 * than a row, so it cannot take that constant and takes this half of it.
 */
const USAGE_CARD_PRESSABLE =
  "outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/45";

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
 * The card's face: the figure, the picture, and the one line that reads it.
 *
 * THREE THINGS, and the order is the reading order — what it cost, how the
 * tokens divided, what that division was made of. The basis sentence that used
 * to sit between the first two is gone from the face and lives in this row's own
 * popover: it qualifies the figure rather than adding to it, the tilde on the
 * figure already carries the consequence, and at rail width it wrapped to two
 * lines more often than not.
 *
 * The bar and the caption both drop when nothing carried tokens — a provider can
 * price a call without breaking it down, and an empty track is a picture of
 * nothing.
 *
 * THE CARET RIDES THE CAPTION, not the figure's line. Parked opposite the money
 * it sat at the far end of an otherwise empty row, reading as a stray glyph
 * rather than as this block's affordance; and a caret set immediately beside a
 * price reads as a value you can change, which this one is not. On the caption
 * line it is the same size and the same ink as the words it ends, which is what
 * a quiet "there is more behind this" should look like. It stays when the
 * caption does not, so the affordance never depends on a provider having broken
 * its tokens down.
 */
export function UsageCardHero({
  name,
  cost,
  summary,
  testId,
  children,
}: {
  /** What the figure is about, for the accessible name — never drawn. */
  name: string;
  cost: string;
  summary: SessionUsageSummary;
  testId?: string;
  /** The popover body: what this figure is, in words. */
  children: React.ReactNode;
}) {
  const tokens = totalUsageTokens(summary);
  const cached = formatCachedShare(summary);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={`${name} ${cost} — open breakdown`}
          className={cn(
            "flex w-full flex-col gap-2 px-4 pt-4 pb-2 text-left",
            USAGE_CARD_PRESSABLE,
          )}
        >
          {/* text-heading, not text-title: the rail's widest content box is
              268px and the ticket title is the only 24px text in the app. */}
          <span className="text-heading tabular-nums text-foreground">{cost}</span>
          {tokens > 0 ? <UsageBar summary={summary} /> : null}
          <span className="flex w-full items-center justify-between gap-2">
            {/* Tokens and cache, never cost — the bar divides tokens, and a
                dollar figure on this line would invite reading the cached share
                as a share of spend. It is close to the opposite. */}
            <span className="min-w-0 truncate text-ui text-muted-foreground tabular-nums">
              {tokens > 0
                ? `${formatTokens(tokens)} tokens${cached === null ? "" : ` · ${cached} cached`}`
                : ""}
            </span>
            <CaretDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </span>
        </button>
      </PopoverTrigger>
      {/* Radix gives its content `role="dialog"`, and a dialog with no
          accessible name is announced as an unnamed one — the heading inside is
          not associated with it. The trigger's own subject names it. */}
      <PopoverContent aria-label={name} align="start" side="left" className={USAGE_POPOVER}>
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
  icon: PhosphorIcon;
  label: string;
  /** A figure parked before the caret — a cost, a count. */
  trailing?: string | null;
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
          className={cn(RAIL_CARD_ROW, RAIL_CARD_SEAM, "min-h-8 py-2 hover:bg-accent/50")}
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-ui text-sidebar-foreground">{label}</span>
          {trailing === null || trailing === undefined ? null : (
            <span className="shrink-0 text-ui tabular-nums text-muted-foreground">{trailing}</span>
          )}
          <CaretDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={label} align="start" side="left" className={USAGE_POPOVER}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * What a figure IS, in words — the popover body behind a hero or a scoped row.
 *
 * The basis sentence, the bar's legend at full precision, the total those
 * classes add up to, and the cached share named rather than abbreviated. This is
 * where the notation stops being one glyph of hedge and becomes a claim someone
 * can check (`usage/usage-format.ts` carries the reasoning for the glyph).
 *
 * THE TOTAL IS A ROW, not a sum the reader is left to do. The face carries it in
 * the caption, but a row's popover has no face above it — and the Session block
 * this replaced reported `Tokens 610k` as one of its three lines, so dropping it
 * here would have retired a fact rather than progressively revealing it. Under
 * the legend rather than over it: it is what those four rows come to.
 */
export function UsageBreakdown({
  title,
  summary,
  children,
}: {
  title: string;
  summary: SessionUsageSummary;
  /** Anything this scope adds under the legend — a ranking, a tally. */
  children?: React.ReactNode;
}) {
  const cost = formatUsageCost(summary);
  const cached = formatCachedShare(summary);
  const basis = usageBasisLine(summary);
  const tokens = totalUsageTokens(summary);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ui font-medium">{title}</span>
          {cost === null ? null : (
            <span className="text-ui tabular-nums text-foreground">{cost}</span>
          )}
        </div>
        {basis === null ? null : <p className="text-ui text-muted-foreground">{basis}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <UsageClassRows summary={summary} />
        {tokens > 0 ? (
          <UsageBreakdownFact label="Total tokens" value={formatTokens(tokens)} />
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
    <div className="flex flex-col gap-2">
      <SectionHeading as="p">{heading}</SectionHeading>
      <dl className="flex flex-col gap-2">
        {rows.map((row) => (
          <UsageRankRow key={row.key} row={row} />
        ))}
      </dl>
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

/**
 * One plain fact under a breakdown's legend — a tally, a top model.
 *
 * Not a {@link UsageRankRow}: those are a ranking and their trailing column is
 * always money, so a "38 sessions · 24 metered" line drawn as one would put a
 * count where every neighbour has a price.
 */
export function UsageBreakdownFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
      <span className="shrink-0 text-ui text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-ui tabular-nums text-foreground">{value}</span>
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
      <p className="text-ui text-muted-foreground">No metered model calls yet</p>
      {detail === null || detail === undefined ? null : (
        <p className="text-ui text-muted-foreground tabular-nums">{detail}</p>
      )}
    </div>
  );
}
