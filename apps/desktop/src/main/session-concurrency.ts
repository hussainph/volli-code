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

import { chatSessionRecord, terminalSessionRecord } from "./session-control";

/** What counting the fleet needs: the projections, and whose start this is. */
export interface WorkingSessionsInput {
  /**
   * The Sessions that could be working, as `volli session list` reads them.
   *
   * ALL projects, because load is a fact about the machine: a build in another
   * project's Session competes for exactly the same cores. Not all SESSIONS,
   * though (VC-403): `sessionEngine.listAttachedSessions()` hands over only
   * the Sessions holding an open attachment, because a Session with none
   * cannot satisfy either half of the precedence below. Passing the whole
   * fleet here is still correct and the count is the same — the narrowing
   * removes a provably-zero set, never a working Session.
   */
  projections: readonly SessionProjection[];
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
 * `volli session list` shows a person.
 *
 * A live terminal Session counts as working whether or not a command is
 * running in it this second. That is deliberate and it is the conservative
 * direction: a shell sitting at a prompt is one keystroke from a build, and a
 * budget that only reacted after the load arrived would hand out the whole
 * machine to everyone in the quiet moment before three test runs start.
 * Structured Sessions have a real activity state and are counted on it.
 */
export function workingSessionCount(input: WorkingSessionsInput): number {
  let working = 0;
  for (const projection of input.projections) {
    if (projection.session.id === input.excludeSessionId) continue;
    const terminal = terminalSessionRecord(projection);
    if (terminal !== null) {
      if (terminal.endedAt === null) working += 1;
      continue;
    }
    if (chatSessionRecord(projection).activity === "working") working += 1;
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

/** The one read a Session start makes to count who is working. */
export interface SessionConcurrencyPorts {
  /**
   * Every Session holding an open attachment, across every project, folded.
   *
   * ONE read, not a walk of the fleet (VC-403). The budget needs a count in
   * the terminal/chat precedence the listing uses, and both halves of that
   * precedence require an open attachment — so the Session Engine narrows to
   * the Sessions that could possibly be working and folds only those. See
   * `SessionLedgerTransaction.listAttachedSessions` for why the ones it drops
   * provably cannot be working.
   *
   * ALL projects, because load is a fact about the machine: a build in another
   * project's Session competes for exactly the same cores.
   */
  listAttachedSessions(): Promise<readonly SessionProjection[]>;
}

/** A Session start's per-call input to a reader — everything but the fleet itself. */
export type SessionConcurrencyEnvReaderInput = Omit<SessionConcurrencyEnvInput, "projections">;

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
   * The cache is now a burst collapser rather than the fix: the read beneath
   * it is bounded by how many Sessions are attached, so a cold call is cheap
   * on its own and a Session that starts after a quiet minute no longer waits
   * on the fleet.
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

  let cached: { projections: readonly SessionProjection[]; expiresAt: number } | null = null;
  let inFlight: Promise<readonly SessionProjection[]> | null = null;

  const read = (): Promise<readonly SessionProjection[]> => {
    if (cached !== null && cached.expiresAt > now()) {
      return Promise.resolve(cached.projections);
    }
    if (inFlight !== null) return inFlight;
    const started = ports.listAttachedSessions().then((projections) => {
      cached = { projections, expiresAt: now() + ttlMs };
      return projections;
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
      const projections = await read();
      return sessionConcurrencyEnv({ ...input, projections });
    } catch {
      return {};
    }
  };
}
