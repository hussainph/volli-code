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
   * Every Session of every project, as `volli session list` reads them —
   * `sessionEngine.listSessions({ projectId, scope: "all" })` per project.
   * ALL projects, because load is a fact about the machine: a build in another
   * project's Session competes for exactly the same cores.
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

/** The two reads a Session start makes to count the fleet. */
export interface SessionConcurrencyPorts {
  /** The projects whose Sessions share this machine. */
  listProjectIds(): readonly string[];
  /** The Session Engine's own listing, per project. */
  listSessions(projectId: string): Promise<readonly SessionProjection[]>;
}

/**
 * The budget for a Session start, having asked the Session Engine who is
 * working — the call site's one entry point.
 *
 * Never throws and never blocks a Session from starting: a fleet that cannot
 * be counted yields an empty record, which leaves every toolchain on its own
 * default. A Session that runs unbudgeted is a machine under load; a Session
 * that fails to start because a listing query threw is a person unable to
 * work.
 */
export async function readSessionConcurrencyEnv(
  ports: SessionConcurrencyPorts,
  input: Omit<SessionConcurrencyEnvInput, "projections">,
): Promise<Record<string, string>> {
  try {
    const projections = (
      await Promise.all(ports.listProjectIds().map((projectId) => ports.listSessions(projectId)))
    ).flat();
    return sessionConcurrencyEnv({ ...input, projections });
  } catch {
    return {};
  }
}
