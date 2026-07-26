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
      kind: "unchanged" | "adopt" | "keep-local";
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
  return { kind: "conflict", local, disk, reason: "overlap" };
}
