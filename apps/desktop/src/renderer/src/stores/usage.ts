/**
 * Shared usage-report cache for the project, Session and Ticket rails.
 * Concurrent callers share a read; a remount under the same lifecycle signal
 * reuses its report. This signal is deliberately broad: it moves on lifecycle
 * transitions, resident Session additions/removals and other Sessions' work,
 * not just usage appends. Refresh bursts coalesce for 250 ms, keeping the old
 * figure visible. An invalidation arriving during a read is drained afterward
 * rather than lost with the old snapshot. Nothing polls.
 *
 * Reads never move Session activity (enforced by the writer). Failures remain
 * on the entry as before, and are retried by the next explicit refresh.
 */
import { create } from "zustand";
import {
  errorMessage,
  type SessionUsageGrouping,
  type SessionUsageReport,
  type SessionUsageScope,
} from "@volli/shared";

/** What is known about one rollup right now. */
export type UsageEntry =
  | { status: "loading" }
  | { status: "ready"; report: SessionUsageReport; signal: string }
  | { status: "error"; error: string };

/**
 * How long a window the rollups cover, and what that means in milliseconds.
 *
 * `all` is an absent lower bound rather than a very old one: a project's whole
 * history is a real question, and picking an arbitrary epoch to stand for
 * "forever" would silently drop whatever happened before it.
 */
export const USAGE_WINDOW_MS: Record<"7d" | "30d" | "all", number | undefined> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: undefined,
};

/**
 * Cache key for one question.
 *
 * The window and grouping are part of the key, not just the scope: the same
 * Ticket over 7 days and over 30 days are two different answers, and a cache
 * that conflated them would show whichever landed last under whichever label
 * the surface happened to be displaying.
 */
export function usageKey(
  scope: SessionUsageScope,
  windowMs: number | undefined,
  groupBy: SessionUsageGrouping | undefined,
): string {
  const target =
    scope.kind === "all"
      ? ""
      : scope.kind === "project"
        ? scope.projectId
        : scope.kind === "ticket"
          ? scope.ticketId
          : scope.sessionId;
  return `${scope.kind}:${target}:${windowMs ?? "all"}:${groupBy ?? ""}`;
}

export interface UsageQuery {
  scope: SessionUsageScope;
  /** Look-back from now, or `undefined` for everything. */
  windowMs?: number;
  groupBy?: SessionUsageGrouping;
}

interface UsageState {
  byQuery: Readonly<Record<string, UsageEntry>>;
  /**
   * Reads the rollup again and replaces its entry. Concurrent reads of one
   * query share a single read — three rail blocks mounting on the same frame
   * is the shape that collision takes.
   *
   * `signal` is the app's settle signal the asker is reading under (see the
   * module doc). A ready entry already tagged with it IS the answer: nothing
   * has settled since it was read, so this resolves without a read.
   */
  refresh(query: UsageQuery, signal: string): Promise<void>;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createUsageStore() {
  /**
   * Reads in flight, per query. Module-scope-per-store rather than store state:
   * nothing renders from it, and putting it in state would re-render every
   * consumer twice per read for a fact none of them show.
   */
  const inFlight = new Map<string, { signal: string; promise: Promise<void> }>();

  return create<UsageState>()((set, get) => ({
    byQuery: {},

    refresh(query, signal) {
      const key = usageKey(query.scope, query.windowMs, query.groupBy);
      const existing = inFlight.get(key);
      if (existing !== undefined) {
        // A settle during the read is not covered by that read's snapshot.
        // Keep the latest signal and drain it before resolving shared callers.
        existing.signal = signal;
        return existing.promise;
      }
      const cached = get().byQuery[key];
      // No invalidation since this report: a rail flip reuses the figure.
      if (cached?.status === "ready" && cached.signal === signal) return Promise.resolve();
      // Only the FIRST read announces itself as loading; a later one keeps the
      // figure already on screen until it is replaced, so a cost never blinks
      // out to make room for the same cost.
      if (cached === undefined) {
        set((state) => ({ byQuery: { ...state.byQuery, [key]: { status: "loading" } } }));
      }
      const job = { signal, promise: Promise.resolve() };
      const run = async () => {
        // The global lifecycle signal also moves on attach/start/close and for
        // other Sessions. Coalesce a burst, without polling or postponing the
        // first figure. The previous report stays visible during the wait.
        if (cached?.status === "ready") await coalesce();
        for (;;) {
          const readingSignal = job.signal;
          const entry = await read(query);
          set((state) => ({
            byQuery: {
              ...state.byQuery,
              [key]: entry.status === "ready" ? { ...entry, signal: readingSignal } : entry,
            },
          }));
          if (job.signal === readingSignal) return;
          await coalesce();
        }
      };
      job.promise = run().finally(() => inFlight.delete(key));
      inFlight.set(key, job);
      return job.promise;
    },
  }));
}

/** A bounded refresh delay, not a poll: only an explicit invalidation schedules it. */
function coalesce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

/** One read, with both failure shapes folded onto the same entry. */
async function read(
  query: UsageQuery,
): Promise<{ status: "ready"; report: SessionUsageReport } | { status: "error"; error: string }> {
  try {
    // `sinceMs` is resolved at read time rather than stored on the query: a
    // rolling window's lower bound moves with the clock, and a bound captured
    // when a component mounted would quietly age as the app stayed open.
    const result = await window.api.sessions.usageReport({
      scope: query.scope,
      sinceMs: query.windowMs === undefined ? undefined : Date.now() - query.windowMs,
      groupBy: query.groupBy,
    });
    return result.ok
      ? { status: "ready", report: result.report }
      : { status: "error", error: result.error };
  } catch (error) {
    return { status: "error", error: errorMessage(error) };
  }
}

export const useUsageStore = createUsageStore();
