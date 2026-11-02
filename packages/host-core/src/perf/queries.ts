/**
 * The three questions `volli perf` asks of the store (VC-1092), as JSON-safe
 * answers: the top offenders in a window, the stalls themselves, and two
 * builds side by side. Also the one-line summary the support report carries.
 *
 * No internal id crosses: a Session is printed as its short handle, as on
 * every other verb.
 */
import { shortSessionId, type PerfGrouping, type PerfProcess } from "@volli/shared";

import {
  DurationGroups,
  observedMs,
  perfStats,
  perfVersionKey,
  perfVersionMatches,
  perHour,
  type PerfGroupStats,
  type PerfStallRecord,
} from "./report";
import type { PerfStallFilter, PerfStore } from "./store";

type PerfReader = Pick<PerfStore, "scanStalls" | "runs">;

/** Folds every stall in `filter` up to `until` into `fold`, a chunk at a time. */
async function fold(
  store: PerfReader,
  filter: PerfStallFilter,
  until: number,
  add: (stall: PerfStallRecord) => void,
): Promise<void> {
  await store.scanStalls(filter, (stalls) => {
    for (const stall of stalls) if (stall.at <= until) add(stall);
  });
}

/** A group as an answer names it: a Session by its short handle, nothing else changed. */
function displayKey(key: string | null, by: PerfGrouping): string | null {
  return key !== null && by === "session" ? shortSessionId(key) : key;
}

export interface PerfTopGroup extends PerfGroupStats {
  readonly key: string | null;
  /** This group's share of the window's stalled milliseconds, 0–1. */
  readonly share: number;
  /** Stalled ms per hour observed: the version's own hours when grouped by version. */
  readonly stallMsPerHour: number | null;
}

export interface PerfTopAnswer {
  readonly since: number;
  readonly until: number;
  readonly process: PerfProcess | null;
  readonly by: PerfGrouping;
  /** How long a monitored app ran inside the window. */
  readonly observedMs: number;
  readonly stalls: number;
  readonly stallMs: number;
  readonly stallsPerHour: number | null;
  readonly stallMsPerHour: number | null;
  /** How many groups there were before the limit. */
  readonly groupCount: number;
  readonly groups: readonly PerfTopGroup[];
}

export interface PerfTopInput {
  readonly since: number;
  readonly until: number;
  readonly process: PerfProcess | null;
  readonly by: PerfGrouping;
  readonly limit: number;
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000;
}

/** The top offenders in a window, by total stalled time. */
export async function perfTop(store: PerfReader, input: PerfTopInput): Promise<PerfTopAnswer> {
  const grouped = new DurationGroups(input.by);
  await fold(
    store,
    { since: input.since, ...(input.process === null ? {} : { process: input.process }) },
    input.until,
    (stall) => grouped.add(stall),
  );
  const runs = store.runs();
  const observed = observedMs(runs, input.since, input.until);
  const stallMs = grouped.totalMs;
  const groups = [...grouped.groups].map(([key, durations]) => {
    const stats = perfStats(durations);
    const hours =
      input.by === "version" && key !== null
        ? observedMs(
            runs.filter((run) => perfVersionKey(run.version, run.build) === key),
            input.since,
            input.until,
          )
        : observed;
    const group: PerfTopGroup = Object.assign({ key: displayKey(key, input.by) }, stats, {
      share: share(stats.totalMs, stallMs),
      stallMsPerHour: perHour(stats.totalMs, hours),
    });
    return group;
  });
  groups.sort((a, b) => b.totalMs - a.totalMs || b.count - a.count);
  return {
    since: input.since,
    until: input.until,
    process: input.process,
    by: input.by,
    observedMs: observed,
    stalls: grouped.count,
    stallMs,
    stallsPerHour: perHour(grouped.count, observed),
    stallMsPerHour: perHour(stallMs, observed),
    groupCount: groups.length,
    groups: groups.slice(0, input.limit),
  };
}

/** One stall as `volli perf stalls` lists it. */
export interface PerfStallLine {
  readonly at: number;
  readonly process: PerfProcess;
  readonly kind: string;
  readonly door: string;
  readonly operation: string;
  readonly label: string | null;
  readonly session: string | null;
  readonly window: number | null;
  readonly durationMs: number;
  readonly hint: string | null;
  readonly version: string;
}

export function perfStallLine(stall: PerfStallRecord): PerfStallLine {
  return {
    at: stall.at,
    process: stall.process,
    kind: stall.kind,
    door: stall.door,
    operation: stall.operation,
    label: stall.label,
    session: stall.sessionId === null ? null : shortSessionId(stall.sessionId),
    window: stall.windowId,
    durationMs: stall.durationMs,
    hint: stall.hint,
    version: perfVersionKey(stall.version, stall.build),
  };
}

export interface PerfCompareSide {
  /** The selector as the caller wrote it. */
  readonly version: string;
  /** The builds it matched (`version+build` keys), so a caller sees what was pooled. */
  readonly matched: readonly string[];
  readonly runs: number;
  readonly observedMs: number;
  readonly stalls: number;
  readonly stallMs: number;
  readonly stallsPerHour: number | null;
  readonly stallMsPerHour: number | null;
}

export interface PerfCompareCell extends PerfGroupStats {
  readonly stallMsPerHour: number | null;
}

export interface PerfCompareGroup {
  readonly key: string | null;
  readonly a: PerfCompareCell | null;
  readonly b: PerfCompareCell | null;
  /** `b − a` in stalled ms per hour observed; null when either side observed nothing. */
  readonly deltaStallMsPerHour: number | null;
  /** `b − a` in total stalled ms: the raw difference, unweighted by how long each ran. */
  readonly deltaTotalMs: number;
}

export interface PerfCompareAnswer {
  readonly since: number | null;
  readonly until: number;
  readonly process: PerfProcess | null;
  readonly by: PerfGrouping;
  readonly a: PerfCompareSide;
  readonly b: PerfCompareSide;
  readonly groupCount: number;
  readonly groups: readonly PerfCompareGroup[];
}

export interface PerfCompareInput {
  readonly versions: readonly [string, string];
  readonly since: number | null;
  readonly until: number;
  readonly process: PerfProcess | null;
  readonly by: PerfGrouping;
  readonly limit: number;
}

function compareCell(durations: number[] | undefined, observed: number): PerfCompareCell | null {
  if (durations === undefined) return null;
  const stats = perfStats(durations);
  return { ...stats, stallMsPerHour: perHour(stats.totalMs, observed) };
}

/** A side's rate for a group: a group the side never stalled in is zero per hour observed. */
function rate(value: PerfCompareCell | null, observed: number): number | null {
  return value === null ? perHour(0, observed) : value.stallMsPerHour;
}

/** How far a group moved: per hour when both sides were observed, else the raw total. */
function compareWeight(group: PerfCompareGroup): number {
  return Math.abs(group.deltaStallMsPerHour ?? group.deltaTotalMs);
}

/** Two builds side by side, per group, weighted by how long each was observed. */
export async function perfCompare(
  store: PerfReader,
  input: PerfCompareInput,
): Promise<PerfCompareAnswer> {
  const since = input.since ?? Number.NEGATIVE_INFINITY;
  const runs = store.runs();
  const [selectorA, selectorB] = input.versions;
  const groupedA = new DurationGroups(input.by);
  const groupedB = new DurationGroups(input.by);
  await fold(
    store,
    {
      ...(input.since === null ? {} : { since: input.since }),
      ...(input.process === null ? {} : { process: input.process }),
    },
    input.until,
    (stall) => {
      // A stall can fall on both sides when the selectors overlap.
      if (perfVersionMatches(selectorA, stall)) groupedA.add(stall);
      if (perfVersionMatches(selectorB, stall)) groupedB.add(stall);
    },
  );
  const side = (selector: string, grouped: DurationGroups) => {
    const sideRuns = runs.filter((run) => perfVersionMatches(selector, run));
    const observed = observedMs(sideRuns, since, input.until);
    const summary: PerfCompareSide = {
      version: selector,
      matched: [
        ...new Set(sideRuns.map((run) => perfVersionKey(run.version, run.build))),
      ].toSorted(),
      runs: sideRuns.length,
      observedMs: observed,
      stalls: grouped.count,
      stallMs: grouped.totalMs,
      stallsPerHour: perHour(grouped.count, observed),
      stallMsPerHour: perHour(grouped.totalMs, observed),
    };
    return { summary, groups: grouped.groups, observed };
  };
  const a = side(selectorA, groupedA);
  const b = side(selectorB, groupedB);
  const keys = new Set([...a.groups.keys(), ...b.groups.keys()]);
  const groups: PerfCompareGroup[] = [...keys].map((key) => {
    const left = compareCell(a.groups.get(key), a.observed);
    const right = compareCell(b.groups.get(key), b.observed);
    const leftRate = rate(left, a.observed);
    const rightRate = rate(right, b.observed);
    return {
      key: displayKey(key, input.by),
      a: left,
      b: right,
      deltaStallMsPerHour:
        leftRate === null || rightRate === null
          ? null
          : Math.round((rightRate - leftRate) * 100) / 100,
      deltaTotalMs: (right?.totalMs ?? 0) - (left?.totalMs ?? 0),
    };
  });
  groups.sort((x, y) => compareWeight(y) - compareWeight(x));
  return {
    since: input.since,
    until: input.until,
    process: input.process,
    by: input.by,
    a: a.summary,
    b: b.summary,
    groupCount: groups.length,
    groups: groups.slice(0, input.limit),
  };
}

/** One process's stalls in the support report's window. */
export interface PerfProcessSummary {
  readonly process: PerfProcess;
  readonly stalls: number;
  readonly stallMs: number;
  readonly p95Ms: number;
  /** Its top operations by total stalled time, `door/operation`. */
  readonly top: readonly {
    readonly key: string;
    readonly count: number;
    readonly totalMs: number;
  }[];
}

export interface PerfSummary {
  readonly since: number;
  readonly observedMs: number;
  readonly processes: readonly PerfProcessSummary[];
}

/** Operations each process names in the support report. */
const SUMMARY_TOP = 3;

/** The support report's stall summary: per process, how many, how long, and the worst operations. */
export async function perfSummary(
  store: PerfReader,
  since: number,
  until: number,
): Promise<PerfSummary> {
  const byProcess = {
    main: new DurationGroups("operation"),
    renderer: new DurationGroups("operation"),
  };
  await fold(store, { since }, until, (stall) => byProcess[stall.process].add(stall));
  const processes: PerfProcessSummary[] = (["main", "renderer"] as const).map((process) => {
    const grouped = byProcess[process];
    const top = [...grouped.groups]
      .map(([key, durations]) => ({
        key: key ?? "unknown",
        count: durations.length,
        totalMs: durations.reduce((sum, ms) => sum + ms, 0),
      }))
      .toSorted((a, b) => b.totalMs - a.totalMs)
      .slice(0, SUMMARY_TOP);
    const stats = perfStats([...grouped.groups.values()].flat());
    return { process, stalls: stats.count, stallMs: stats.totalMs, p95Ms: stats.p95Ms, top };
  });
  return { since, observedMs: observedMs(store.runs(), since, until), processes };
}
