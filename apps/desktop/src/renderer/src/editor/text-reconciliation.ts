import {
  findBoundedSequenceDiff,
  type SequenceEditStep,
  STANDARD_SEQUENCE_DIFF_BUDGET,
} from "./bounded-sequence-diff";

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
  if (editsOverlap(baseline, localEdits, diskEdits)) {
    return { kind: "conflict", local, disk, reason: "overlap" };
  }
  return {
    kind: "merge",
    value: applyEdits(baseline, [...localEdits, ...diskEdits]),
    nextBaseline: disk,
  };
}

/** One replacement of `baseline[start, end)`. `start === end` is an insertion. */
export interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

// A 1 MiB file may be almost entirely unrelated after a generated rewrite. The
// length cap and shared search budget keep that case bounded, returning `null`
// so reconciliation preserves both values as a conflict instead of guessing.
const MAX_TEXT_LENGTH = 1024 * 1024;

/**
 * Find a bounded shortest edit script with Myers' O((N + M)D) algorithm, or
 * `null` when the change exceeds the length cap or shared search budget.
 *
 * The returned edits are non-overlapping, sorted by `start`, and expressed in
 * `baseline` coordinates — the contract `applyEdits` relies on here and Monaco's
 * `pushEditOperations` relies on when the same edits become one external write.
 * The mutable frontier and reconstruction trace stay private: a reconciliation
 * caller only ever needs the resulting script, never the search state.
 */
export function findTextEdits(baseline: string, changed: string): TextEdit[] | null {
  if (baseline.length > MAX_TEXT_LENGTH || changed.length > MAX_TEXT_LENGTH) return null;
  const steps = findBoundedSequenceDiff(baseline, changed, STANDARD_SEQUENCE_DIFF_BUDGET);
  return steps === null ? null : stepsToEdits(steps);
}

function stepsToEdits(steps: readonly SequenceEditStep<string>[]): TextEdit[] {
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

/** An inclusive range of BASE line indices one edit consumes or lands in. */
interface LineSpan {
  first: number;
  last: number;
}

/**
 * Conflicts are decided per LINE, not per character.
 *
 * Two character-disjoint edits on the same line are not independent in any sense
 * a person would recognize: `timeout = 100` becoming `1000` locally and `200` on
 * disk share the digit `0`, so a character merge silently produces `2000` — a
 * value neither side wrote. A line is the smallest unit whose merged result a
 * reviewer can still read, so touching the same base line is a conflict and both
 * versions are preserved. Edits on different lines still merge character-exactly.
 */
function editsOverlap(
  baseline: string,
  leftEdits: readonly TextEdit[],
  rightEdits: readonly TextEdit[],
): boolean {
  const lineStarts = lineStartOffsets(baseline);
  const rightSpans = rightEdits.map((right) => baseLineSpan(right, lineStarts));
  return leftEdits.some((left) => {
    const leftSpan = baseLineSpan(left, lineStarts);
    return rightSpans.some(
      (rightSpan) => leftSpan.first <= rightSpan.last && rightSpan.first <= leftSpan.last,
    );
  });
}

/**
 * Offsets at which each base line begins. `\n` terminates a line, so a CRLF
 * file's `\r` belongs to the line it closes and never starts a new one; a text
 * ending in a newline has a final empty line, which is where an EOF append lands.
 */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function baseLineSpan(edit: TextEdit, lineStarts: readonly number[]): LineSpan {
  const first = lineIndexAt(lineStarts, edit.start);
  // An insertion consumes nothing, so it only touches the line it lands in. A
  // replacement touches every line it consumes a character from — `end` is
  // exclusive, so the last of those characters is at `end - 1` (which is the
  // closing `\n` when the replacement swallows a whole line, keeping the
  // untouched line that follows free to merge).
  return { first, last: edit.end > edit.start ? lineIndexAt(lineStarts, edit.end - 1) : first };
}

function lineIndexAt(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
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
