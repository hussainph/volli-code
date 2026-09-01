/**
 * What one model operation consumed, and how a Session's operations add up.
 *
 * The vocabulary is deliberately negative-friendly. Every measured number is
 * `number | null`, and absent NEVER means zero: a provider that reported no
 * cost and a provider that charged nothing are different facts, and a report
 * that folded them together would tell an owner their pass was free. That one
 * distinction is the reason this module exists as domain code rather than as a
 * formatting helper — `knownCostUsd: null` with `costCoverage: "unavailable"`
 * is unrepresentable once a summary is a plain sum.
 *
 * Cost here is a MEASUREMENT, never a bill. {@link CostBasis} says which,
 * because most executors multiply provider token counts by a local price
 * catalogue: the number is right about what was consumed and only an estimate
 * of what will be invoiced. A read surface that prints a catalogue estimate as
 * provider account spend is the failure this field exists to prevent, and a
 * summary of mixed bases reports `mixed` rather than picking a winner.
 *
 * Provider account spend and a budget cap are different planes and are not
 * here: an account meter needs its own credential and carries an `asOf`, and a
 * cap a Session could write is decoration. Only what Volli itself observed a
 * Session consume belongs in this file.
 */

/**
 * Where a cost number came from.
 *
 * `catalog-estimate` is the common case and the reason nothing here may be
 * called a bill. `provider-reported` is reserved for a protocol that carries
 * the backend's own accounting. `unavailable` is the honest answer for an
 * executor whose pricing Volli cannot vouch for — never a guessed basis, and
 * never a zero.
 */
export const COST_BASES = ["provider-reported", "catalog-estimate", "unavailable"] as const;

export type CostBasis = (typeof COST_BASES)[number];

/**
 * Why a model was called. Not every model call is a reply the user asked for,
 * and a Session that spent a third of its budget on summarising itself should
 * be able to say so.
 *
 * `compaction` is Context Compaction. `utility` is product work with no
 * transcript of its own — auto-titling is the current one. Both are real spend
 * against the Session and both are counted in its total.
 */
export const SESSION_USAGE_CAUSES = ["assistant", "compaction", "utility"] as const;

export type SessionUsageCause = (typeof SESSION_USAGE_CAUSES)[number];

/**
 * One metered model operation, as the executor reported it.
 *
 * Token classes are separate and non-overlapping, because providers price them
 * apart: a cache read bills at roughly a tenth of an uncached input token and a
 * cache write at more than one. Folding `cacheReadTokens` into `inputTokens`
 * would make the one number that explains a surprising bill unrecoverable.
 *
 * There is no timestamp, Session id or attachment id on this shape. Those are
 * the Session Event envelope's, and duplicating them here would give a reader
 * two places to disagree about when a fact happened.
 */
export interface SessionUsage {
  cause: SessionUsageCause;
  /** Executor-native provider and model ids. Display labels resolve at read time. */
  providerId: string;
  modelId: string;
  /** Prompt tokens the provider billed at full write price. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Prompt tokens served from the provider's cache, at roughly 0.1x. */
  cacheReadTokens: number | null;
  /** Prompt tokens written into the provider's cache, at 1.25x to 2x. */
  cacheWriteTokens: number | null;
  /** What the operation cost, on {@link costBasis}. Null when unknown. */
  costUsd: number | null;
  costBasis: CostBasis;
}

/**
 * How confident a total is. `partial` is the value a mixed report must carry so
 * a surface can render `~$1.23+` instead of an exact-looking `$1.23`.
 */
export type SessionUsageCoverage = "complete" | "partial" | "unavailable";

/**
 * A basis for a whole report. `mixed` is the fourth value {@link CostBasis} has
 * no use for: one operation has one basis, a sum of many may not.
 */
export type SessionUsageSummaryBasis = CostBasis | "mixed";

/**
 * What a set of operations adds up to, with the counts that qualify the sum.
 *
 * The completeness counters are not diagnostics. `requestCount` against
 * `pricedRequestCount` is exactly the difference between "this pass cost
 * $8.42" and "at least $8.42 of this pass is priced", and a caller that cannot
 * see both will print the first sentence for the second fact.
 */
export interface SessionUsageSummary {
  /** Every metered model operation, priced or not. */
  requestCount: number;
  /** Operations that reported at least one token class. */
  tokenRequestCount: number;
  /** Operations that carried a cost. The denominator for {@link costCoverage}. */
  pricedRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The sum over priced operations only, or null when none was priced. */
  knownCostUsd: number | null;
  costCoverage: SessionUsageCoverage;
  costBasis: SessionUsageSummaryBasis;
  /**
   * Cache reads as a share of ALL prompt tokens — `cacheRead / (input +
   * cacheRead + cacheWrite)`. Deliberately not called a cache hit rate:
   * providers report token classes, not one hit-or-miss bit per request, and a
   * falling share is the operational signal a rising bill usually starts as.
   */
  cachedInputShare: number | null;
}

/** A Session that has run no metered model operation. Not a free Session — an unmeasured one. */
export const EMPTY_SESSION_USAGE_SUMMARY: SessionUsageSummary = Object.freeze({
  requestCount: 0,
  tokenRequestCount: 0,
  pricedRequestCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  knownCostUsd: null,
  costCoverage: "unavailable",
  costBasis: "unavailable",
  cachedInputShare: null,
});

/**
 * Micro-dollars. Money is summed in floating point, so `0.1 + 0.2` lands at
 * `0.30000000000000004` and every surface downstream inherits the noise. Six
 * places is below any price a provider quotes and above the drift.
 */
const COST_PRECISION = 1e6;

export function summarizeSessionUsage(usage: readonly SessionUsage[]): SessionUsageSummary {
  if (usage.length === 0) return EMPTY_SESSION_USAGE_SUMMARY;

  let tokenRequestCount = 0;
  let pricedRequestCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  // Held as a set rather than a running verdict so `mixed` falls out of the
  // data instead of out of the order the records happened to arrive in.
  const bases = new Set<CostBasis>();

  for (const record of usage) {
    if (
      record.inputTokens !== null ||
      record.outputTokens !== null ||
      record.cacheReadTokens !== null ||
      record.cacheWriteTokens !== null
    ) {
      tokenRequestCount += 1;
    }
    inputTokens += record.inputTokens ?? 0;
    outputTokens += record.outputTokens ?? 0;
    cacheReadTokens += record.cacheReadTokens ?? 0;
    cacheWriteTokens += record.cacheWriteTokens ?? 0;
    // An unpriced operation contributes no basis. Its `costBasis` describes a
    // number that does not exist, and letting it vote would turn every report
    // containing one silent request into `mixed`.
    if (record.costUsd === null) continue;
    pricedRequestCount += 1;
    costUsd += record.costUsd;
    bases.add(record.costBasis);
  }

  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  const soleBasis = bases.size === 1 ? [...bases][0] : undefined;
  return {
    requestCount: usage.length,
    tokenRequestCount,
    pricedRequestCount,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    knownCostUsd:
      pricedRequestCount === 0 ? null : Math.round(costUsd * COST_PRECISION) / COST_PRECISION,
    costCoverage: usageCoverage(usage.length, pricedRequestCount),
    costBasis: soleBasis ?? (bases.size === 0 ? "unavailable" : "mixed"),
    cachedInputShare: promptTokens === 0 ? null : cacheReadTokens / promptTokens,
  };
}

function usageCoverage(requestCount: number, pricedRequestCount: number): SessionUsageCoverage {
  if (pricedRequestCount === 0) return "unavailable";
  return pricedRequestCount === requestCount ? "complete" : "partial";
}
