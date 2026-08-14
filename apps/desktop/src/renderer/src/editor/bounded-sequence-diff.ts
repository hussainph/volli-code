/** Limits for one exact sequence-diff search. */
export interface SequenceDiffBudget {
  readonly maxDistance: number;
  readonly maxComparisons: number;
}

/** Shared production bound for character and logical-line reconciliation. */
export const STANDARD_SEQUENCE_DIFF_BUDGET: SequenceDiffBudget = Object.freeze({
  maxDistance: 1024,
  maxComparisons: 3_000_000,
});

export type SequenceEditStep<Item> =
  | { kind: "delete"; index: number }
  | { kind: "insert"; index: number; value: Item };

/**
 * Return one deterministic shortest edit script, or `null` when exact search
 * exceeds either supplied bound.
 *
 * Inputs are `ArrayLike` rather than iterables deliberately: indexing a string
 * observes UTF-16 code units, preserving the offset space used by Monaco.
 */
export function findBoundedSequenceDiff<Item>(
  baseline: ArrayLike<Item>,
  changed: ArrayLike<Item>,
  budget: SequenceDiffBudget = STANDARD_SEQUENCE_DIFF_BUDGET,
): SequenceEditStep<Item>[] | null {
  if (!isValidBudgetBound(budget.maxDistance) || !isValidBudgetBound(budget.maxComparisons)) {
    return null;
  }

  const maximumDistance = Math.min(budget.maxDistance, baseline.length + changed.length);
  const offset = maximumDistance + 1;
  const frontier = new Int32Array(2 * maximumDistance + 3);
  frontier.fill(-1);
  frontier[offset + 1] = 0;
  const traces: Int32Array[] = [];
  let comparisons = 0;

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      comparisons += 1;
      if (comparisons > budget.maxComparisons) return null;

      const index = offset + diagonal;
      const takesInsertion =
        diagonal === -distance ||
        (diagonal !== distance && frontier[index - 1] < frontier[index + 1]);
      let baselineIndex = takesInsertion ? frontier[index + 1] : frontier[index - 1] + 1;
      let changedIndex = baselineIndex - diagonal;

      while (baselineIndex < baseline.length && changedIndex < changed.length) {
        comparisons += 1;
        if (comparisons > budget.maxComparisons) return null;
        if (baseline[baselineIndex] !== changed[changedIndex]) break;
        baselineIndex += 1;
        changedIndex += 1;
      }
      frontier[index] = baselineIndex;

      if (baselineIndex === baseline.length && changedIndex === changed.length) {
        traces.push(frontier.slice());
        return reconstructSteps(changed, traces, offset, baselineIndex, changedIndex);
      }
    }
    traces.push(frontier.slice());
  }
  return null;
}

function isValidBudgetBound(bound: number): boolean {
  return Number.isFinite(bound) && Number.isInteger(bound) && bound >= 0;
}

function reconstructSteps<Item>(
  changed: ArrayLike<Item>,
  traces: readonly Int32Array[],
  offset: number,
  finalBaselineIndex: number,
  finalChangedIndex: number,
): SequenceEditStep<Item>[] {
  let baselineIndex = finalBaselineIndex;
  let changedIndex = finalChangedIndex;
  const reverseSteps: SequenceEditStep<Item>[] = [];

  for (let distance = traces.length - 1; distance > 0; distance -= 1) {
    const previous = traces[distance - 1];
    const diagonal = baselineIndex - changedIndex;
    const takesInsertion =
      diagonal === -distance ||
      (diagonal !== distance && previous[offset + diagonal - 1] < previous[offset + diagonal + 1]);
    const previousDiagonal = takesInsertion ? diagonal + 1 : diagonal - 1;
    const previousBaselineIndex = previous[offset + previousDiagonal];
    const previousChangedIndex = previousBaselineIndex - previousDiagonal;
    reverseSteps.push(
      takesInsertion
        ? {
            kind: "insert",
            index: previousBaselineIndex,
            value: changed[previousChangedIndex],
          }
        : { kind: "delete", index: previousBaselineIndex },
    );
    baselineIndex = previousBaselineIndex;
    changedIndex = previousChangedIndex;
  }

  return reverseSteps.toReversed();
}
