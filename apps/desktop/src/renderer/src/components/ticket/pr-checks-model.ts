/**
 * Pure resolver for the repository card's CI row (VC-182): given a ticket's
 * transient retention state, it decides whether there is anything to say about
 * CI at all, what the one line says, and in what order the rollup is listed.
 * Kept side-effect-free and separate from `pr-checks-row.tsx` so the rules are
 * unit-testable without mounting React — the same split
 * `worktree-done-flow-model.ts` and `worktree-retention-model.ts` use.
 *
 * THE ROW IS SELF-DETECTING, and that is the whole of the ticket's "optionally".
 * A project with no GitHub Actions pipeline has no checks on its PRs, GitHub
 * returns an empty rollup, and {@link resolvePrChecks} answers `null` — the row
 * is absent because there is nothing to report, not because a setting is off.
 * That is also why there is no setting: a switch defaulting to on would be
 * invisible to everyone it affects, and one defaulting to off would hide a
 * surface most people would want, in exchange for a preference nobody asked to
 * make. The same reasoning retires the "N checks failing" retention notice this
 * row supersedes (`worktree-retention-model.ts`) — one subject, one place.
 *
 * SURFACING, NEVER GATING (decision #44). Nothing here disables the wrap-up
 * action or the done-flow primary. A red row explains why a PR should not be
 * merged yet; the decision stays the person's, exactly as it does for the merge
 * conflict notice beside it.
 */
import type { PrCheck, PrCheckState, TicketRetentionState } from "../../../../ipc/contract";

/**
 * The rollup's one verdict. The same four values as a single check's state,
 * because the question is the same one asked of the whole suite, and a fifth
 * "mixed" value would only be a verdict a reader still had to resolve.
 */
export type PrChecksVerdict = PrCheckState;

/** How many checks sit in each state (they sum to `total`). */
export interface PrChecksCounts {
  passing: number;
  failing: number;
  pending: number;
  skipped: number;
  total: number;
}

/** The CI row, resolved. `null` from {@link resolvePrChecks} means "draw nothing". */
export interface PrChecksView {
  verdict: PrChecksVerdict;
  /** The row's one line — "2 checks failing", "All checks passed". */
  label: string;
  /**
   * The full breakdown for the popover's header ("1 failing · 3 passed"), or
   * `null` when a single state accounts for every check and the line above
   * already said so.
   */
  summary: string | null;
  /** The rollup ordered for reading: failing, running, passed, skipped. */
  checks: readonly PrCheck[];
  counts: PrChecksCounts;
  /**
   * The PR's own Checks tab — the way out to everything this row summarizes,
   * and the only honest destination when a check published no `detailsUrl` of
   * its own. Composed here rather than in the view so the string is covered by
   * the same tests as the counts.
   */
  checksUrl: string;
}

/** Failing first — the reason someone opened the row — then what is still moving. */
const READING_ORDER: readonly PrCheckState[] = ["failing", "pending", "passing", "skipped"];

/** "1 check" / "2 checks". */
function plural(count: number): string {
  return count === 1 ? "1 check" : `${count} checks`;
}

function countBy(checks: readonly PrCheck[]): PrChecksCounts {
  const counts: PrChecksCounts = {
    passing: 0,
    failing: 0,
    pending: 0,
    skipped: 0,
    total: checks.length,
  };
  for (const check of checks) counts[check.state] += 1;
  return counts;
}

/**
 * The suite's verdict, in the order a reader cares: one failure outranks every
 * pass, and anything still running outranks a clean partial result — a suite
 * that is three-quarters green is not green yet.
 *
 * All-skipped resolves to `skipped` rather than `passing`: a workflow whose
 * every job was filtered out (a paths-ignore, a manual gate) passed nothing,
 * and a green check beside "nothing ran" is the one reading here that could
 * actually mislead someone into merging.
 */
function resolveVerdict(counts: PrChecksCounts): PrChecksVerdict {
  if (counts.failing > 0) return "failing";
  if (counts.pending > 0) return "pending";
  if (counts.passing > 0) return "passing";
  return "skipped";
}

/** The row's line: the verdict's own count, because that is the number being reported. */
function resolveLabel(verdict: PrChecksVerdict, counts: PrChecksCounts): string {
  if (verdict === "failing") return `${plural(counts.failing)} failing`;
  if (verdict === "pending") return `${plural(counts.pending)} running`;
  if (verdict === "passing") return "All checks passed";
  return "All checks skipped";
}

/** Each non-empty state as "N failing · N running · N passed · N skipped". */
function resolveSummary(counts: PrChecksCounts): string | null {
  const parts = [
    counts.failing > 0 ? `${counts.failing} failing` : null,
    counts.pending > 0 ? `${counts.pending} running` : null,
    counts.passing > 0 ? `${counts.passing} passed` : null,
    counts.skipped > 0 ? `${counts.skipped} skipped` : null,
  ].filter((part): part is string => part !== null);
  // One part means the row's own label already carries the whole story; a
  // header repeating it in different words is the duplication this file's
  // header is about.
  return parts.length > 1 ? parts.join(" · ") : null;
}

/**
 * Resolves the CI row from a ticket's retention state, or `null` when there is
 * nothing honest to draw: the state has not loaded, the ticket has no PR to
 * have checks on, or the PR's rollup is empty (no pipeline, or none has
 * reported yet).
 */
export function resolvePrChecks(state: TicketRetentionState | null): PrChecksView | null {
  if (state === null || state.prUrl === null || state.checks.length === 0) return null;
  const counts = countBy(state.checks);
  const verdict = resolveVerdict(counts);
  return {
    verdict,
    label: resolveLabel(verdict, counts),
    summary: resolveSummary(counts),
    // `<pr>/checks` is GitHub's own tab for this, and it is built by suffix
    // rather than parsed because the stored url is whatever `gh` printed — a
    // trailing slash is the one shape that would double up, so it is trimmed.
    checksUrl: `${state.prUrl.replace(/\/+$/, "")}/checks`,
    // A stable sort by bucket: within a bucket the rollup keeps GitHub's own
    // order, which is the order the PR page shows and the one a reader already
    // recognizes.
    checks: READING_ORDER.flatMap((bucket) => state.checks.filter((c) => c.state === bucket)),
    counts,
  };
}
