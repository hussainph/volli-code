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

/**
 * Null-prototype accumulator (the `stores/workspace.ts` pattern): these records
 * are keyed by arbitrary repository paths, and a file literally named
 * `constructor` (or `__proto__`, `toString`, …) must not resolve through
 * `Object.prototype` and read as an inspected path that was never opened.
 * Object-literal spreads (`{ ...record }`) reintroduce `Object.prototype`, so
 * every copy has to go through these helpers.
 */
export function emptyPathRecord<T>(): Readonly<Record<string, T>> {
  return Object.create(null) as Record<string, T>;
}

/** Copy `record` onto a null prototype with `path` set to `value`. */
export function withPathEntry<T>(
  record: Readonly<Record<string, T>>,
  path: string,
  value: T,
): Readonly<Record<string, T>> {
  const next = Object.assign(Object.create(null) as Record<string, T>, record);
  next[path] = value;
  return next;
}

/** Copy `record` onto a null prototype without `path` (identity when absent). */
export function withoutPathEntry<T>(
  record: Readonly<Record<string, T>>,
  path: string,
): Readonly<Record<string, T>> {
  if (!(path in record)) return record;
  const next = Object.assign(Object.create(null) as Record<string, T>, record);
  delete next[path];
  return next;
}

/** Empty state for a newly opened Changes navigator. */
export const EMPTY_CHANGE_RECENCY_STATE: ChangeRecencyState = {
  paths: Object.freeze(emptyPathRecord<ChangeRecencyRecord>()),
};

/** Whether a deliberately inspected path has a later external revision. */
export function isChangeUpdated(state: ChangeRecencyState, path: string): boolean {
  const record = state.paths[path];
  return record !== undefined && record.updatedRevision !== null;
}

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
  const existing = state.paths[event.path];
  if (event.type === "external-revision") {
    if (
      existing === undefined ||
      existing.seenRevision === event.revision ||
      existing.updatedRevision === event.revision
    ) {
      return state;
    }
    return {
      paths: withPathEntry(state.paths, event.path, {
        ...existing,
        updatedRevision: event.revision,
      }),
    };
  }

  if (event.type === "local-save-echo") {
    // A recognized save event belongs to the person already looking at this
    // path. It advances their seen revision without creating review state.
    if (
      existing === undefined ||
      (existing.seenRevision === event.revision && existing.updatedRevision === null)
    ) {
      return state;
    }
    return {
      paths: withPathEntry(state.paths, event.path, {
        seenRevision: event.revision,
        updatedRevision: null,
      }),
    };
  }
  if (existing?.seenRevision === event.revision && existing.updatedRevision === null) return state;

  return {
    paths: withPathEntry(state.paths, event.path, {
      seenRevision: event.revision,
      updatedRevision: null,
    }),
  };
}
