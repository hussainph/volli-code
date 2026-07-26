/**
 * Pure stale-awareness state for the Changes navigator (CONCEPT #52).
 *
 * This module intentionally knows nothing about React, tabs, IPC, watches, or
 * persistence. The future identity-complete watch integration supplies exact
 * opaque revisions through the small event API below; this reducer only
 * projects whether a deliberately inspected path has since changed.
 */

/** Exact revision pair retained for a path the user deliberately inspected. */
export interface ChangeRecencyRecord {
  /** Revision last deliberately seen by opening its file or diff. */
  seenRevision: string;
  /** A later external revision, or null when the prior glance remains current. */
  updatedRevision: string | null;
}

/** State is intentionally transient until a product persistence need exists. */
export interface ChangeRecencyState {
  paths: Readonly<Record<string, ChangeRecencyRecord>>;
}

/** Empty state for a newly opened Changes navigator. */
export const EMPTY_CHANGE_RECENCY_STATE: ChangeRecencyState = {
  paths: Object.freeze({}) as Readonly<Record<string, ChangeRecencyRecord>>,
};

/**
 * Identity-complete events consumed by the recency reducer.
 *
 * `inspect` must only be dispatched from a deliberate file or diff open.
 * `external-revision` and `local-save-echo` are the later watch integration
 * seam, where every event supplies the exact opaque revision it observed.
 */
export type ChangeRecencyEvent =
  | { type: "inspect"; path: string; revision: string }
  | { type: "external-revision"; path: string; revision: string }
  | { type: "local-save-echo"; path: string; revision: string };

/**
 * Record a deliberate inspection. Reopening clears stale awareness and records
 * the exact revision just seen; it never represents a review or approval.
 */
export function reduceChangeRecency(
  state: ChangeRecencyState,
  event: ChangeRecencyEvent,
): ChangeRecencyState {
  if (event.type !== "inspect") return state;
  const existing = state.paths[event.path];
  if (existing?.seenRevision === event.revision && existing.updatedRevision === null) return state;

  return {
    paths: {
      ...state.paths,
      [event.path]: { seenRevision: event.revision, updatedRevision: null },
    },
  };
}
