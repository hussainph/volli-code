/** The three values needed to reconcile an open text model with disk. */
export interface ReconcileTextInput {
  /** The last content value known to be synchronized with disk. */
  baseline: string;
  /** The current in-memory Monaco value. */
  local: string;
  /** The newly-read disk value. */
  disk: string;
}

export type ReconcileTextResult =
  | {
      kind: "unchanged" | "adopt" | "keep-local" | "merge";
      value: string;
      /** Content that should become the caller's next disk baseline. */
      nextBaseline: string;
    }
  | {
      kind: "conflict";
      local: string;
      disk: string;
      reason: "overlap" | "budget";
    };

/**
 * Reconcile a synchronized baseline, an in-memory value, and a new disk value.
 *
 * The result contains only the next model value or the two exact values that
 * need a conflict affordance. Diff coordinates remain an implementation detail.
 */
export function reconcileText(input: ReconcileTextInput): ReconcileTextResult {
  const { baseline, local, disk } = input;
  if (local === disk) {
    return { kind: "unchanged", value: local, nextBaseline: disk };
  }
  if (local === baseline) {
    return { kind: "adopt", value: disk, nextBaseline: disk };
  }
  if (disk === baseline) {
    return { kind: "keep-local", value: local, nextBaseline: disk };
  }

  const localEdits = findTextEdits(baseline, local);
  const diskEdits = findTextEdits(baseline, disk);
  if (localEdits === null || diskEdits === null) {
    return { kind: "conflict", local, disk, reason: "budget" };
  }
  if (editsOverlap(localEdits, diskEdits)) {
    return { kind: "conflict", local, disk, reason: "overlap" };
  }
  return {
    kind: "merge",
    value: applyEdits(baseline, [...localEdits, ...diskEdits]),
    nextBaseline: disk,
  };
}

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

type EditStep =
  | { kind: "delete"; index: number }
  | { kind: "insert"; index: number; value: string };

// A 1 MiB file may be almost entirely unrelated after a generated rewrite. The
// caps keep that case bounded, returning `null` so the public operation can
// conservatively preserve both values as a conflict instead of guessing.
const MAX_TEXT_LENGTH = 1024 * 1024;
const MAX_EDIT_DISTANCE = 1024;
const MAX_COMPARISONS = 3_000_000;

/**
 * Find a bounded shortest edit script with Myers' O((N + M)D) algorithm.
 *
 * The mutable frontier and reconstruction trace are deliberately private: a
 * reconciliation caller only needs a safe outcome, never diff coordinates.
 */
function findTextEdits(baseline: string, changed: string): TextEdit[] | null {
  if (baseline.length > MAX_TEXT_LENGTH || changed.length > MAX_TEXT_LENGTH) return null;

  const maximumDistance = Math.min(MAX_EDIT_DISTANCE, baseline.length + changed.length);
  const offset = maximumDistance + 1;
  const frontier = new Int32Array(2 * maximumDistance + 3);
  frontier.fill(-1);
  frontier[offset + 1] = 0;
  const traces: Int32Array[] = [];
  let comparisons = 0;

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      comparisons += 1;
      if (comparisons > MAX_COMPARISONS) return null;

      const index = offset + diagonal;
      const takesInsertion =
        diagonal === -distance ||
        (diagonal !== distance && frontier[index - 1] < frontier[index + 1]);
      let baselineIndex = takesInsertion ? frontier[index + 1] : frontier[index - 1] + 1;
      let changedIndex = baselineIndex - diagonal;

      while (baselineIndex < baseline.length && changedIndex < changed.length) {
        comparisons += 1;
        if (comparisons > MAX_COMPARISONS) return null;
        if (baseline[baselineIndex] !== changed[changedIndex]) break;
        baselineIndex += 1;
        changedIndex += 1;
      }
      frontier[index] = baselineIndex;

      if (baselineIndex === baseline.length && changedIndex === changed.length) {
        traces.push(frontier.slice());
        return operationsToEdits(baseline, changed, traces, offset);
      }
    }
    traces.push(frontier.slice());
  }
  return null;
}

function operationsToEdits(
  baseline: string,
  changed: string,
  traces: readonly Int32Array[],
  offset: number,
): TextEdit[] {
  let baselineIndex = baseline.length;
  let changedIndex = changed.length;
  const reverseSteps: EditStep[] = [];

  for (let distance = traces.length - 1; distance > 0; distance -= 1) {
    const previous = traces[distance - 1];
    const diagonal = baselineIndex - changedIndex;
    const takesInsertion =
      diagonal === -distance ||
      (diagonal !== distance && previous[offset + diagonal - 1] < previous[offset + diagonal + 1]);
    const previousDiagonal = takesInsertion ? diagonal + 1 : diagonal - 1;
    const previousBaselineIndex = previous[offset + previousDiagonal];
    const previousChangedIndex = previousBaselineIndex - previousDiagonal;
    const afterEditBaselineIndex = takesInsertion
      ? previousBaselineIndex
      : previousBaselineIndex + 1;
    const afterEditChangedIndex = takesInsertion ? previousChangedIndex + 1 : previousChangedIndex;

    while (baselineIndex > afterEditBaselineIndex && changedIndex > afterEditChangedIndex) {
      baselineIndex -= 1;
      changedIndex -= 1;
    }
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

  while (baselineIndex > 0 && changedIndex > 0) {
    baselineIndex -= 1;
    changedIndex -= 1;
  }

  return stepsToEdits(reverseSteps.toReversed());
}

function stepsToEdits(steps: readonly EditStep[]): TextEdit[] {
  const edits: TextEdit[] = [];
  let pending: TextEdit | null = null;

  const flush = () => {
    if (pending !== null) edits.push(pending);
    pending = null;
  };

  for (const step of steps) {
    if (pending !== null && (step.index < pending.start || step.index > pending.end)) {
      flush();
    }
    if (pending === null) {
      pending = { start: step.index, end: step.index, replacement: "" };
    }
    if (step.kind === "delete") {
      pending.end = Math.max(pending.end, step.index + 1);
    } else {
      pending.replacement += step.value;
    }
  }
  flush();
  return edits;
}

function editsOverlap(leftEdits: readonly TextEdit[], rightEdits: readonly TextEdit[]): boolean {
  return leftEdits.some((left) => rightEdits.some((right) => editRangesOverlap(left, right)));
}

function editRangesOverlap(left: TextEdit, right: TextEdit): boolean {
  const leftIsInsertion = left.start === left.end;
  const rightIsInsertion = right.start === right.end;
  if (leftIsInsertion && rightIsInsertion) return left.start === right.start;
  if (leftIsInsertion) return left.start >= right.start && left.start <= right.end;
  if (rightIsInsertion) return right.start >= left.start && right.start <= left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function applyEdits(baseline: string, edits: readonly TextEdit[]): string {
  const ordered = edits.toSorted((left, right) => left.start - right.start);
  let cursor = 0;
  let merged = "";
  for (const edit of ordered) {
    merged += baseline.slice(cursor, edit.start);
    merged += edit.replacement;
    cursor = edit.end;
  }
  return merged + baseline.slice(cursor);
}
