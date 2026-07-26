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
      reason: "overlap";
    };

/**
 * Reconcile a synchronized baseline, an in-memory value, and a new disk value.
 *
 * The non-conflicting fast paths deliberately do not inspect text structure.
 * A local/disk pair that both differ from the baseline is kept losslessly until
 * a later reconciliation slice can prove a merge safe.
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

  const localEdit = singleTextEdit(baseline, local);
  const diskEdit = singleTextEdit(baseline, disk);
  if (!editsOverlap(localEdit, diskEdit)) {
    return {
      kind: "merge",
      value: applyEdits(baseline, [localEdit, diskEdit]),
      nextBaseline: disk,
    };
  }
  return { kind: "conflict", local, disk, reason: "overlap" };
}

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

/** The smallest prefix/suffix-bounded change from one string to another. */
function singleTextEdit(baseline: string, changed: string): TextEdit {
  let start = 0;
  while (start < baseline.length && start < changed.length && baseline[start] === changed[start]) {
    start += 1;
  }

  let baselineEnd = baseline.length;
  let changedEnd = changed.length;
  while (
    baselineEnd > start &&
    changedEnd > start &&
    baseline[baselineEnd - 1] === changed[changedEnd - 1]
  ) {
    baselineEnd -= 1;
    changedEnd -= 1;
  }

  return { start, end: baselineEnd, replacement: changed.slice(start, changedEnd) };
}

function editsOverlap(left: TextEdit, right: TextEdit): boolean {
  const leftIsInsertion = left.start === left.end;
  const rightIsInsertion = right.start === right.end;
  if (leftIsInsertion && rightIsInsertion) return left.start === right.start;
  if (leftIsInsertion) return left.start >= right.start && left.start <= right.end;
  if (rightIsInsertion) return right.start >= left.start && right.start <= left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function applyEdits(baseline: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  let cursor = 0;
  let merged = "";
  for (const edit of ordered) {
    merged += baseline.slice(cursor, edit.start);
    merged += edit.replacement;
    cursor = edit.end;
  }
  return merged + baseline.slice(cursor);
}
