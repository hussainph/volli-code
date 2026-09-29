/**
 * How a metered total is written down, and how its token classes divide a bar.
 *
 * Pure over a {@link SessionUsageSummary}, so the notation is testable without
 * a DOM and every surface that quotes money quotes it identically. The rules
 * are small but none of them is cosmetic: each one exists to stop a specific
 * false sentence reaching a reader.
 *
 * THE HEDGE IS ONE SMALL WORD, SET BESIDE THE FIGURE. A summary can be
 * estimated, mixed-basis, partially priced, wholly unpriced, or absent — five
 * states that a sentence apiece would turn into a paragraph on a 268px rail. So
 * the figure carries at most one muted qualifier and the popover carries the
 * words:
 *
 *     $8.42              provider-reported and complete — the only bare case
 *     $8.42 est.         a catalogue estimate, or a mix of bases
 *     $8.42 unverified   a basis Volli cannot vouch for
 *     $8.42+ est.        partial: at least this much was priced
 *     —                  nothing could be priced
 *     null               nothing was metered at all
 *
 * It used to be a tilde prefix (`~$8.42`), the glyph `chat/context-usage-ui.tsx`
 * puts on estimated token counts. On a token count the tilde is a small mark
 * beside a small number; on a cost it became the first and largest character
 * of the rail's hero figure, and read as the figure's own punctuation rather
 * than as a hedge on it (VC-406). The word goes AFTER the money and a step
 * down in size, which is where a qualifier reads as a qualifier — and the
 * split between {@link usageCostParts} and {@link formatUsageCost} is what
 * lets a surface set it muted while an accessible name still speaks it.
 *
 * THE MARK IS NOT THE CLAIM. `est.` is only ever said of a figure this build
 * priced against a catalogue (wholly, or as part of a `mixed` total, where the
 * weaker claim wins). An `unavailable` basis says `unverified` instead —
 * {@link usageBasisLine} makes the same distinction in full sentences, because
 * Volli knowing a number and Volli having computed it are different claims,
 * and a mark that called the first one an estimate would assert a provenance
 * `session-usage.ts` explicitly refused to assert.
 *
 * AND NOTHING HERE SPLITS COST BY TOKEN CLASS, because the ledger cannot: a
 * `costUsd` is recorded per metered operation, not per class, and reconstructing
 * a per-class split would mean re-pricing tokens against a local catalogue —
 * the one thing `session-usage.ts` refuses to do. So {@link usageBarSegments}
 * divides TOKENS and the surfaces above it never put the word cost on the
 * bar's line. A reader who sees "78% cached" beside "~$12.48" must not conclude
 * that 78% of the money was cache; it is roughly the reverse, cache reads
 * billing at about a tenth of an uncached input token.
 */

import type { ModelAccessModel, SessionUsageSummary } from "@volli/shared";

/**
 * The four non-overlapping token classes, in the order the bar draws them.
 *
 * Prompt classes first and cheapest-first within that — cache read, uncached
 * input, cache write — then output. That order makes the bar's usual shape
 * (a long cheap head) the thing the eye lands on, and it keeps the two classes
 * a prompt author can actually move next to each other.
 */
export const USAGE_CLASSES = ["cacheRead", "input", "cacheWrite", "output"] as const;

export type UsageClassId = (typeof USAGE_CLASSES)[number];

export interface UsageBarSegment {
  id: UsageClassId;
  label: string;
  tokens: number;
}

/**
 * One row of a ranked breakdown — a model, a Session, a Ticket.
 *
 * The shape a `reportSessionUsage` group takes on once a display label has been
 * resolved for its key. `label` is resolved at read time on purpose: the ledger
 * stores provider and model IDS, and a stored display name would be a second
 * copy of a catalogue that moves.
 */
export interface UsageGroupRow {
  key: string;
  label: string;
  usage: SessionUsageSummary;
  /**
   * The model this row is about, where it is about one — a Session row has no
   * model and therefore no mark. `null` for a model group nothing could
   * resolve, where {@link UsageGroupRow.label} is the wire id the ledger holds.
   */
  model?: UsageModelIdentity | null;
}

/**
 * A model row's identity, as the app's model mark takes one (`ModelMark`).
 *
 * Resolved against the catalogue at the connected boundary rather than by a
 * drawing, for the reason everything in `components/usage/` is props-in: what
 * arrives here is already the answer.
 */
export interface UsageModelIdentity {
  model: Pick<ModelAccessModel, "providerId" | "modelId" | "label">;
  /**
   * The account as the catalogue names it. NOT drawn on a rail row — the mark
   * is what says whose model this is — but it is the lettermark's initial for a
   * vendor with no glyph of its own, and the reveal's second term.
   */
  providerLabel: string;
}

/**
 * The windows a rollup offers.
 *
 * 30d is the default rather than lifetime: a project's all-time total only ever
 * grows, so it stops being a number anyone can act on, while the recent window
 * is the one an orchestrator can still change the shape of.
 */
export const USAGE_WINDOWS = [
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
] as const;

export type UsageWindow = (typeof USAGE_WINDOWS)[number]["key"];

/**
 * What each class is called wherever it is named — bar legend, popover rows,
 * hover titles.
 *
 * "Uncached input" rather than "input", because the summary's `inputTokens` is
 * specifically the part that was NOT served from cache, and a legend reading
 * "input 142k" beside "cache read 980k" invites the reader to assume the first
 * contains the second.
 */
export const USAGE_CLASS_LABEL: Record<UsageClassId, string> = {
  cacheRead: "Cache read",
  input: "Uncached input",
  cacheWrite: "Cache write",
  output: "Output",
};

/**
 * The bar's parts, zero-token classes dropped.
 *
 * Dropped rather than drawn at zero width: a legend entry for a class that
 * contributed nothing is a row of furniture, and on this bar an invisible
 * segment would still take its gutter. The parts that remain sum to
 * `promptTokens + output`, so a caller may size them with flex-grow and trust
 * that they fill the track exactly.
 */
export function usageBarSegments(summary: SessionUsageSummary): readonly UsageBarSegment[] {
  const byClass: Record<UsageClassId, number> = {
    cacheRead: summary.cacheReadTokens,
    input: summary.inputTokens,
    cacheWrite: summary.cacheWriteTokens,
    output: summary.outputTokens,
  };
  return USAGE_CLASSES.filter((id) => byClass[id] > 0).map((id) => ({
    id,
    label: USAGE_CLASS_LABEL[id],
    tokens: byClass[id],
  }));
}

/** Every token class added up — what the bar's track represents. */
export function totalUsageTokens(summary: SessionUsageSummary): number {
  return (
    summary.inputTokens + summary.outputTokens + summary.cacheReadTokens + summary.cacheWriteTokens
  );
}

/** The qualifier a hedged figure wears — see the module comment for which is said when. */
export type UsageCostHedge = "est." | "unverified";

/**
 * A cost in its two parts: the money, and the qualifier on it, if any.
 *
 * Two parts rather than one string because they are set differently — the
 * figure in the row's own ink, the hedge a step smaller and muted — and a
 * surface that had to split a string to do that would be re-parsing this
 * module's own notation.
 */
export interface UsageCostParts {
  /** The money, with `+` when only part of the report was priced; `—` when none of it could be. */
  figure: string;
  /** `null` for the one bare case: wholly provider-reported. */
  hedge: UsageCostHedge | null;
}

/**
 * The cost in parts, or `null` when there is nothing to say.
 *
 * `null` and a `"—"` figure are different answers and both are needed: null
 * means no model operation was metered, so the surface should render no row at
 * all, while `"—"` means operations happened and none could be priced.
 * Collapsing them would either invent a cost row for a terminal that never
 * called a model, or silently hide a Session whose spend Volli genuinely cannot
 * vouch for.
 */
export function usageCostParts(summary: SessionUsageSummary): UsageCostParts | null {
  if (summary.requestCount === 0) return null;
  if (summary.knownCostUsd === null) return { figure: "—", hedge: null };
  const suffix = summary.costCoverage === "partial" ? "+" : "";
  // Only a basis that is wholly provider-reported may print bare. `mixed` takes
  // the estimate's mark because part of it is a catalogue estimate, and the
  // honest reading of a mixed total is the weaker of its two claims.
  const hedge: UsageCostHedge | null =
    summary.costBasis === "provider-reported"
      ? null
      : summary.costBasis === "unavailable"
        ? "unverified"
        : "est.";
  return { figure: `${formatUsd(summary.knownCostUsd)}${suffix}`, hedge };
}

/**
 * The hedged cost as one string — for an accessible name, a `title`, a toast:
 * anywhere the figure is spoken rather than set. A drawn figure takes
 * {@link usageCostParts} so the hedge can be muted.
 */
export function formatUsageCost(summary: SessionUsageSummary): string | null {
  const parts = usageCostParts(summary);
  if (parts === null) return null;
  return parts.hedge === null ? parts.figure : `${parts.figure} ${parts.hedge}`;
}

/**
 * Money, at the precision a reader can act on.
 *
 * `<$0.01` rather than `$0.00` for a real but tiny amount: rounding a charge to
 * zero prints the one sentence this whole module exists to prevent. A true zero
 * is still `$0.00` — a provider that reported no charge said something, and it
 * is not the same as saying nothing.
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Cache reads as a share of all prompt tokens, as a percentage.
 *
 * Never called a hit rate — providers report token classes, not one
 * hit-or-miss bit per request, and CONTEXT.md is explicit that the wrong name
 * here invites the wrong diagnosis.
 */
export function formatCachedShare(summary: SessionUsageSummary): string | null {
  if (summary.cachedInputShare === null) return null;
  const percent = summary.cachedInputShare * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

/**
 * What kind of number the cost is, in words.
 *
 * THREE ANSWERS, NOT TWO, and the third is the one this function exists to get
 * right. `provider-reported` is the backend's own accounting. `catalog-estimate`
 * — and a `mixed` total containing one — was priced locally at list. But
 * `unavailable` is a cost from an executor whose pricing Volli cannot vouch
 * for: a custom `models.json` provider, or an adapter newer than this build.
 * The tokens beside it are real and the number is real; what is unknown is
 * where the number came from.
 *
 * Calling that "Estimated" would assert a provenance `session-usage.ts`
 * explicitly refused to assert — it would tell a reader the figure is this
 * build's price catalogue applied to those tokens, which is exactly what
 * `unavailable` denies. The figure still may not print bare (it wears
 * `unverified`, {@link usageCostParts}); only the claim about its origin
 * changes.
 */
function usageBasisWord(basis: SessionUsageSummary["costBasis"]): string {
  if (basis === "provider-reported") return "Provider-reported";
  if (basis === "unavailable") return "Unverified basis";
  return "Estimated";
}

/**
 * The sentence under a hero figure: what the number is, and how much of the
 * report it covers.
 *
 * The coverage half only appears when it changes the reading. A complete report
 * saying "12 of 12 operations priced" spends a line to say nothing, while a
 * partial one that omitted it would let a floor read as a total.
 */
export function usageBasisLine(summary: SessionUsageSummary): string | null {
  if (summary.requestCount === 0) return null;
  const operations = `${summary.requestCount} ${summary.requestCount === 1 ? "operation" : "operations"}`;
  if (summary.knownCostUsd === null) return `No cost reported · ${operations}`;
  const basis = usageBasisWord(summary.costBasis);
  if (summary.costCoverage === "partial") {
    return `${basis} · ${summary.pricedRequestCount} of ${summary.requestCount} operations priced`;
  }
  return `${basis} · ${operations}`;
}
