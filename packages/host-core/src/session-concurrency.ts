/**
 * The Session environment's concurrency budget (VC-339): how many parallel
 * jobs the Session about to start may assume it has, written into the
 * variables every common toolchain already reads.
 *
 * Volli is the only party on the machine that knows how many Sessions are
 * working, and each toolchain is the only party that knows what to do with a
 * number — so Volli supplies the number and stays out of the command line.
 * `cargo`, `make`, `cmake`, `go`, `pytest -n auto`, `gradle` and vitest all
 * self-limit from their own environment variables, which is what makes this
 * work for a Rust or Python Session with no agent cooperation at all.
 *
 * The arithmetic and the no-clobber rule are pure and live in `@volli/shared`
 * (`concurrency-budget.ts`). What lives here is the part that has to ask this
 * process questions: how many cores the host has, and which Sessions are
 * working right now.
 *
 * Computed once, at Session start. A budget that tracked the fleet live would
 * be better and is deliberately not this: the number has to be in the
 * environment before the Session's first command, and an environment variable
 * cannot be changed under a process that is already running. A Session that
 * starts on a quiet machine keeps its generous budget until it ends.
 */
import { availableParallelism } from "node:os";

import { VOLLI_CONCURRENCY_HINT_ENV, concurrencyBudget, concurrencyBudgetEnv } from "@volli/shared";
import type { SessionProjection } from "@volli/shared";

import {
  chatSessionRecord,
  latestStructuredAttachment,
  terminalSessionRecord,
} from "./session-control";

/**
 * What this process is running right now, from its own process-local maps
 * (VC-1085) — never from the ledger's open attachments.
 *
 * Not the same thing as an open attachment, and deliberately so. A durable
 * structured attachment stays open across a quit as the RESUMABLE binding the
 * next command rehydrates (`#rehydrateBinding`, boot recovery's module doc,
 * `chatSessionRecord`'s `executorBound`). A profile that has used Volli for
 * months holds thousands of them with nothing running, so "open" alone would
 * count — and fold — every chat anyone ever had.
 */
export interface LiveExecutors {
  /**
   * The chats that may be working: a binding this process holds with a turn
   * open, or a turn start it has accepted and not yet seen open. A held
   * binding outlives its turn — nothing releases an idle one before quit — so
   * the set of bindings grows with how long the app has been open; this set
   * is bounded by what is actually running.
   */
  readonly turnSessionIds: ReadonlySet<string>;
  /**
   * Every structured attachment whose binding this process holds, matched
   * against a Session's latest structured attachment exactly as the listing
   * rows match it (`sessionListingRow`'s `executorBound`).
   */
  readonly boundAttachmentIds: ReadonlySet<string>;
  /** The Sessions whose PTY is running: terminals are live while their shell is. */
  readonly terminalSessionIds: ReadonlySet<string>;
}

/** What counting the fleet needs: the projections, who is live, and whose start this is. */
export interface WorkingSessionsInput {
  /**
   * The Sessions that could be working, folded as `volli session list` folds
   * them. Only the candidates {@link LiveExecutors} names are ever read, but
   * passing more is still correct: {@link live} decides who may count, and a
   * projection whose executor is not held here contributes zero.
   *
   * ALL projects, because load is a fact about the machine: a build in another
   * project's Session competes for exactly the same cores.
   */
  projections: readonly SessionProjection[];
  /** The executors this process holds, which a Session must have to count (VC-1085). */
  live: Pick<LiveExecutors, "boundAttachmentIds" | "terminalSessionIds">;
  /**
   * The Session being started, excluded from its own count. Its record may
   * already exist by the time its environment is assembled, and counting it
   * would make a Session alone on the machine divide its cores by one Session
   * that is not yet running anything.
   */
  excludeSessionId?: string | undefined;
}

/**
 * How many OTHER Sessions are working, in the same terms the Session listing
 * uses — the terminal/chat precedence included, so this cannot drift from what
 * `volli session list` shows a person — over the executors this process holds.
 *
 * A live terminal Session counts as working whether or not a command is
 * running in it this second. That is deliberate and it is the conservative
 * direction: a shell sitting at a prompt is one keystroke from a build, and a
 * budget that only reacted after the load arrived would hand out the whole
 * machine to everyone in the quiet moment before three test runs start.
 * Structured Sessions have a real activity state and are counted on it, with
 * the binding fact the listing rows use.
 */
export function workingSessionCount(input: WorkingSessionsInput): number {
  let working = 0;
  for (const projection of input.projections) {
    const sessionId = projection.session.id;
    if (sessionId === input.excludeSessionId) continue;
    const terminal = terminalSessionRecord(projection);
    if (terminal !== null) {
      if (input.live.terminalSessionIds.has(sessionId) && terminal.endedAt === null) working += 1;
      continue;
    }
    const structured = latestStructuredAttachment(projection.attachments);
    const bound = structured !== null && input.live.boundAttachmentIds.has(structured.id);
    if (chatSessionRecord(projection, bound).activity === "working") working += 1;
  }
  return working;
}

/** What building one Session's budget variables takes. */
export interface SessionConcurrencyEnvInput extends WorkingSessionsInput {
  /**
   * The environment the Session is about to be handed — consulted so a value
   * the user already set is never overwritten (`concurrencyBudgetEnv`).
   */
  environment: Readonly<Record<string, string | undefined>>;
  /** Test seam; defaults to this host's usable core count. */
  cores?: number;
}

/**
 * The budget variables for one Session start: `max(1, floor(cores /
 * max(1, workingSessions)))`, in every spelling a toolchain honours, for every
 * name the surrounding environment leaves free.
 *
 * Volli's own `VOLLI_CONCURRENCY_HINT` is removed from that surrounding
 * environment before it is consulted, because Volli's own previous answer is
 * not a user value: the app can be launched from a terminal inside another
 * Volli Session, and an inherited hint describes that machine at that moment.
 * The no-clobber rule protects what a PERSON set, and this is what keeps it
 * from also protecting a stale number Volli exported itself.
 */
export function sessionConcurrencyEnv(input: SessionConcurrencyEnvInput): Record<string, string> {
  const { [VOLLI_CONCURRENCY_HINT_ENV]: _staleHint, ...userEnvironment } = input.environment;
  const budget = concurrencyBudget(
    input.cores ?? availableParallelism(),
    workingSessionCount(input),
  );
  return concurrencyBudgetEnv(budget, userEnvironment);
}

/** What a Session start reads to count who is working. */
export interface SessionConcurrencyPorts {
  /**
   * What this process is running right now — the runtime's bindings and turn
   * starts and the terminal supervisor's PTYs. Cheap and synchronous: all of
   * it is process-local maps (VC-1085).
   *
   * Only its candidates — the chats with a turn open or accepted, and the
   * running terminals — are folded, and the fold still decides. An idle chat
   * is never folded, however many this process holds: the read is the size of
   * what is running, not of what has attached since launch.
   */
  liveExecutors(): LiveExecutors;
  /** One candidate Session, folded through the ordinary projection path; `null` when it is gone. */
  getSession(query: { sessionId: string }): Promise<SessionProjection | null>;
}

/** A Session start's per-call input to a reader — everything but the fleet itself. */
export type SessionConcurrencyEnvReaderInput = Omit<
  SessionConcurrencyEnvInput,
  "projections" | "live"
>;

/** What one call into a reader answers: this Session start's budget variables. */
export type SessionConcurrencyEnvReader = (
  input: SessionConcurrencyEnvReaderInput,
) => Promise<Record<string, string>>;

export interface SessionConcurrencyEnvReaderOptions {
  /**
   * How long a read stays valid before the next caller pays for a fresh one.
   * The module doc's "computed once, at Session start" already accepts a few
   * seconds of staleness, so this defaults there — long enough to collapse a
   * burst of Session starts into one read, short enough that a budget handed
   * out a few seconds ago is still describing the same machine.
   *
   * The cache is a burst collapser rather than the fix: the read beneath it
   * folds only the Sessions running something right now, so a cold call is cheap on
   * its own and a Session that starts after a quiet minute, or first after a
   * launch, never waits on the fleet (VC-1085).
   */
  ttlMs?: number;
  /** The clock, injectable so tests drive the TTL rather than sleeping. */
  now?: () => number;
}

/** {@link SessionConcurrencyEnvReaderOptions.ttlMs}'s default — see its doc. */
const DEFAULT_CONCURRENCY_ENV_TTL_MS = 5_000;

/**
 * Builds the process's ONE reader of who is working (VC-403).
 *
 * Never throws and never blocks a Session from starting: a fleet that cannot
 * be counted yields an empty record, which leaves every toolchain on its own
 * default. A Session that runs unbudgeted is a machine under load; a Session
 * that fails to start because a listing query threw is a person unable to
 * work.
 *
 * One reader for the process, not one per call site. Every structured
 * attachment, every background shell start and every terminal start asks the
 * same question about the same machine, and two readers with their own windows
 * would institutionalise two answers to it — so `index.ts` builds this once and
 * hands it to `PtyManager` rather than each door keeping its own.
 *
 * Two things make one read safe to share:
 *
 * - **The exclusion happens after the cache, not before it.** What this
 *   memoizes is the RAW projections, before `excludeSessionId` is applied —
 *   two Sessions starting in the same window ask to exclude two different ids,
 *   and a cache keyed on the excluded answer would serve one of them the
 *   other's number. `sessionConcurrencyEnv` (pure, unchanged) applies the
 *   exclusion per call, against the one shared read.
 * - **A burst shares one in-flight read.** A cache alone still lets every
 *   caller that arrives before the first read resolves start its own; this
 *   keeps ONE in-flight promise and hands it to every caller that arrives
 *   while it is still running.
 *
 * A read that throws is never cached: the next call retries rather than being
 * stuck answering `{}` for the rest of the TTL window.
 */
export function createSessionConcurrencyEnvReader(
  ports: SessionConcurrencyPorts,
  options: SessionConcurrencyEnvReaderOptions = {},
): SessionConcurrencyEnvReader {
  const ttlMs = options.ttlMs ?? DEFAULT_CONCURRENCY_ENV_TTL_MS;
  const now = options.now ?? Date.now;

  let cached: (LiveFleet & { expiresAt: number }) | null = null;
  let inFlight: Promise<LiveFleet> | null = null;

  const read = (): Promise<LiveFleet> => {
    if (cached !== null && cached.expiresAt > now()) {
      return Promise.resolve(cached);
    }
    if (inFlight !== null) return inFlight;
    const started = readLiveFleet(ports).then((fleet) => {
      cached = { ...fleet, expiresAt: now() + ttlMs };
      return fleet;
    });
    inFlight = started;
    // Cleared on both settlements: a throw must not leave a stale in-flight
    // promise wedged in place for the rest of the process, poisoning every
    // later call with the same rejection.
    started.then(
      () => (inFlight = null),
      () => (inFlight = null),
    );
    return started;
  };

  return async (input) => {
    try {
      const fleet = await read();
      return sessionConcurrencyEnv({ ...input, ...fleet });
    } catch {
      return {};
    }
  };
}

/** One read of who is live, and the candidates' folds. */
interface LiveFleet {
  readonly live: LiveExecutors;
  readonly projections: readonly SessionProjection[];
}

/**
 * The live executors, then each candidate folded — one at a time, because the
 * folds are synchronous work on the host's event loop and a handful of them
 * gains nothing from being interleaved. A candidate that is gone by the time
 * it is read (a binding released between the two) simply drops out.
 */
async function readLiveFleet(ports: SessionConcurrencyPorts): Promise<LiveFleet> {
  const live = ports.liveExecutors();
  const candidates = new Set([...live.turnSessionIds, ...live.terminalSessionIds]);
  const projections: SessionProjection[] = [];
  for (const sessionId of candidates) {
    const projection = await ports.getSession({ sessionId });
    if (projection !== null) projections.push(projection);
  }
  return { live, projections };
}
