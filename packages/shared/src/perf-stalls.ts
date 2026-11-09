/**
 * The perf store's query vocabulary (VC-1092): what `volli perf` can group
 * stalls by and which process it can narrow to.
 *
 * Two surfaces validate these words — the CLI's parser, before the socket,
 * and the host's verbs, after it — so they are named lists here rather than
 * a union each side spells for itself. Add a word, never rename one: a
 * script that pipes `volli perf top --by operation --json` keys on it.
 */

/** Which process a stall held: Electron main's event loop, or a window's renderer. */
export const PERF_PROCESSES = Object.freeze(["main", "renderer"] as const);

export type PerfProcess = (typeof PERF_PROCESSES)[number];

/**
 * One dimension a `volli perf top` or `compare` breaks stalls down along.
 *
 * - `operation`: the door and the operation inside it (`ipc/volli:x`,
 *   `renderer/keydown`), the unit a fix targets.
 * - `door`: the coarse source (`ipc`, `socket`, `runtime`, `renderer`, …).
 * - `label`: what a person was doing (a renderer interaction label).
 * - `version`: the build that recorded it, to compare builds.
 * - `session`: the Session it ran for, when one was named.
 */
export const PERF_GROUPINGS = Object.freeze([
  "operation",
  "door",
  "label",
  "version",
  "session",
] as const);

export type PerfGrouping = (typeof PERF_GROUPINGS)[number];

export function isPerfProcess(value: unknown): value is PerfProcess {
  return typeof value === "string" && (PERF_PROCESSES as readonly string[]).includes(value);
}

export function isPerfGrouping(value: unknown): value is PerfGrouping {
  return typeof value === "string" && (PERF_GROUPINGS as readonly string[]).includes(value);
}

/** How many rows `volli perf stalls` lists by default, and at most. */
export const PERF_STALLS_LIMITS = Object.freeze({ default: 20, max: 500 });

/** How many groups `volli perf top` and `compare` list by default, and at most. */
export const PERF_GROUP_LIMITS = Object.freeze({ default: 10, max: 100 });
