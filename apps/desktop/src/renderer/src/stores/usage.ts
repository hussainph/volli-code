/**
 * One shared cache of usage rollups — what a Session, Ticket or project has
 * cost (VC-87).
 *
 * THREE SURFACES ask this question and none owns the others: Home's Session
 * block asks about the Session in front, Home's Project block asks about the
 * project, and the Ticket rail's card asks about a Ticket. A fetch per surface
 * would mean several indexed reads of the same projection on one frame, and
 * answers that can disagree — the same argument `stores/venue.ts` already
 * settled for venue readings.
 *
 * PULLED, NOT PUSHED, and the push channel is deliberately absent rather than
 * missing. Usage only changes when a turn settles, which the renderer already
 * learns through the Session stream; the rails re-ask on that signal via
 * {@link UsageState.refresh}. A second push channel carrying the same news
 * would be a second clock to keep in step, and a poll loop would spend a
 * database read every few seconds to be told nothing happened. **Nothing in
 * this module polls.**
 *
 * A usage read must also never move a Session's `lastActivityAt`: telemetry
 * arriving is not new agent work, and a roster that re-sorted itself when a
 * cost landed would say otherwise. That is enforced where the fact is written,
 * not here — this module only reads.
 *
 * The error is kept rather than toasted, like the venue's. A rollup that
 * cannot be read is a block that does not appear; a toast about SQLite over
 * the rail someone is working in would be the loudest thing on screen for the
 * least useful reason.
 *
 * ONE VERB, `refresh`, and no read-through cache beside it. An `ensure` that
 * answered from cache would be right exactly once: the rails unmount whenever
 * a reader changes page or Session, work keeps settling while they are gone,
 * and nothing here could know to drop the stale answer — so a rail coming back
 * would show a figure from some earlier minute and look entirely settled about
 * it. `refresh` keeps the cached entry visible while it re-reads, which buys
 * the same absence of flicker without the lie.
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
  | { status: "ready"; report: SessionUsageReport }
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
   */
  refresh(query: UsageQuery): Promise<void>;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createUsageStore() {
  /**
   * Reads in flight, per query. Module-scope-per-store rather than store state:
   * nothing renders from it, and putting it in state would re-render every
   * consumer twice per read for a fact none of them show.
   */
  const inFlight = new Map<string, Promise<void>>();

  return create<UsageState>()((set, get) => ({
    byQuery: {},

    refresh(query) {
      const key = usageKey(query.scope, query.windowMs, query.groupBy);
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;
      // Only the FIRST read announces itself as loading; a later one keeps the
      // figure already on screen until it is replaced, so a cost never blinks
      // out to make room for the same cost.
      if (get().byQuery[key] === undefined) {
        set((state) => ({ byQuery: { ...state.byQuery, [key]: { status: "loading" } } }));
      }
      const pending = read(query)
        .then((entry) => {
          set((state) => ({ byQuery: { ...state.byQuery, [key]: entry } }));
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
  }));
}

/** One read, with both failure shapes folded onto the same entry. */
async function read(query: UsageQuery): Promise<UsageEntry> {
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
