/**
 * The host half of a scheduled resume: a clock that notices a schedule is due
 * and performs what `@volli/shared`'s `scheduledResumeVerdict` says it owes.
 *
 * ── IT DECIDES NOTHING ────────────────────────────────────────────────────
 * Which schedule is pending, whether it is due, and whether the Session is
 * still the one to continue are pure rules beside the verdict, tested as a
 * table. This module owns only what they cannot: a timer, the memory of which
 * Sessions to look at, and the two doors it acts through — the runtime's
 * `executor.retry`, the SAME door a person's Retry uses, and `resume.settle`.
 *
 * ── LATE, NEVER EARLY, NEVER TWICE ────────────────────────────────────────
 * The timer sleeps until the earliest due schedule, and never longer than
 * {@link SCHEDULED_RESUME_TICK_MS}: a suspended laptop, a clock that jumped,
 * or a relaunch all end with the next look happening within a tick — and a
 * wake (`pass`, wired to the OS resume event) looks at once. A schedule whose
 * time passed while the app was closed fires on the first pass after launch;
 * the skip rules, not a grace window, are what keep a stale Session from
 * running, because the person asked for exactly this resume.
 *
 * The retry is issued under the schedule's frozen retry command id, so a
 * second fire — two passes racing, a pass after a crash between the retry and
 * its settle — is the engine replaying one command rather than a second turn.
 * A retry in flight is also held in memory so this process never asks twice.
 *
 * ── WHY THE SETTLE WAITS FOR THE RETRY ────────────────────────────────────
 * The runtime's retry answers when the resumed run does, and only then is it
 * known whether the retry was refused. So the settle is written after it: a
 * refusal is recorded (and told) as one, and a resumed run as resumed. A crash
 * in between leaves the retry command on the ledger, which the next launch's
 * verdict settles from its receipt — or, with no receipt to read, issues again
 * under the same id. A retry the engine could only answer `unreconciled` is left
 * unsettled for that same next look, never recorded as resumed.
 *
 * Failures are reported through `onError` and never propagated: a pass that
 * throws must not take the host down, and the next tick looks again.
 */
import {
  scheduledResumeFireAt,
  scheduledResumeSettleCommandId,
  scheduledResumeVerdict,
  sessionNotificationItem,
  shortSessionId,
  pendingScheduledResume,
  type ScheduledResumeOutcome,
  type SessionProjection,
} from "@volli/shared";
import type {
  SessionRuntimeCommandRequest,
  SessionRuntimeCommandResult,
} from "@volli/session-engine";

import type { NotificationRequest } from "@volli/shared";
import { hostLogger } from "../log/root";

const log = hostLogger("scheduled-resume");

/**
 * How long the timer sleeps at most. A minute, like the Automation schedule
 * timer and the watchdog: a long `setTimeout` is not a promise across a sleep,
 * so the host re-asks often and sleeps the exact remainder when it is shorter.
 */
export const SCHEDULED_RESUME_TICK_MS = 60_000;

export interface ScheduledResumeHostPorts {
  /** The Sessions that may hold a pending schedule, read once at start. */
  candidates(): Promise<readonly string[]>;
  projection(sessionId: string): Promise<SessionProjection>;
  /** Every Session on one Ticket, folded — the superseded rule's input. */
  ticketSessions(input: {
    projectId: string;
    ticketId: string;
  }): Promise<readonly SessionProjection[]>;
  /** The runtime's command door: the retry, and the settle. */
  command(request: SessionRuntimeCommandRequest): Promise<SessionRuntimeCommandResult>;
  /** The one notification path; a skip is told, a resume is not. */
  notify?(request: NotificationRequest): void;
  now?(): number;
  setTimer?(delayMs: number, fire: () => void): ReturnType<typeof setTimeout>;
  clearTimer?(handle: ReturnType<typeof setTimeout>): void;
  /** Diagnostics seam. Defaults to the host log. */
  onError?(error: unknown): void;
}

export interface ScheduledResumeHost {
  /** Seeds the candidates and runs the first pass (which arms the timer). */
  start(): Promise<void>;
  /**
   * A Session the activity watch just folded. A pending schedule makes it a
   * candidate and re-arms the timer to its time; none drops it.
   */
  observe(projection: SessionProjection): void;
  /** One pass now — the timer's, and the wake's. */
  pass(): Promise<void>;
  /** Disarms the timer. A retry already in flight still settles on its own. */
  stop(): void;
  /** Every pass and retry still in flight, so a test (or shutdown) can await it. */
  settled(): Promise<void>;
}

/**
 * What a skip tells the person. `continued` is absent on purpose: the person
 * took the Session back themselves, and a notification hours later about
 * their own act says nothing they do not know.
 */
const SKIP_REASON_TEXT: Record<
  Exclude<Extract<ScheduledResumeOutcome, { kind: "skipped" }>["reason"], "continued">,
  string
> = {
  superseded: "was passed over for a newer Session on its ticket",
  ended: "was stopped before its resume",
  refused: "could not be resumed",
};

export function createScheduledResumeHost(ports: ScheduledResumeHostPorts): ScheduledResumeHost {
  const now = ports.now ?? (() => Date.now());
  const setTimer = ports.setTimer ?? ((delayMs, fire) => setTimeout(fire, delayMs));
  const clearTimer = ports.clearTimer ?? ((handle) => clearTimeout(handle));
  const onError =
    ports.onError ?? ((error: unknown) => log.error("scheduled resume failed", { error }));
  /** Session id → the schedule id last seen pending there (null: not yet read). */
  const candidates = new Map<string, string | null>();
  /** Schedule ids whose retry this process has issued and not yet settled. */
  const inFlight = new Set<string>();
  const work = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  function track(promise: Promise<void>): void {
    work.add(promise);
    void promise.finally(() => work.delete(promise));
  }

  function arm(nextAt: number | null): void {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    const delay =
      nextAt === null
        ? SCHEDULED_RESUME_TICK_MS
        : Math.min(Math.max(nextAt - now(), 0), SCHEDULED_RESUME_TICK_MS);
    timer = setTimer(delay, () => {
      timer = null;
      void pass();
    });
  }

  async function settle(
    projection: SessionProjection,
    scheduleId: string,
    outcome: ScheduledResumeOutcome,
  ): Promise<void> {
    const sessionId = projection.session.id;
    const result = await ports.command({
      origin: { kind: "volli", reason: "scheduled-resume" },
      commandId: scheduledResumeSettleCommandId(scheduleId),
      sessionId,
      command: { kind: "resume.settle", scheduleId, outcome },
    });
    // A settle the engine refused lost a race — the person cancelled in the
    // same moment — and there is nothing to tell them about their own act.
    if (
      outcome.kind !== "skipped" ||
      outcome.reason === "continued" ||
      result.receipt?.status !== "completed"
    ) {
      return;
    }
    const name = projection.session.title ?? `Session ${shortSessionId(sessionId)}`;
    ports.notify?.({
      producer: "scheduled-resume-skipped",
      title: "Resume skipped",
      body: `${name} ${SKIP_REASON_TEXT[outcome.reason]}.`,
      target: {
        kind: "session",
        projectId: projection.session.projectId,
        ticketId: projection.session.ticketId,
        sessionId,
        ...sessionNotificationItem(projection),
      },
    });
  }

  function resume(
    scheduleId: string,
    retry: { sessionId: string; attachmentId: string; retryCommandId: string },
  ): void {
    inFlight.add(scheduleId);
    const run = (async () => {
      let outcome: ScheduledResumeOutcome;
      try {
        const result = await ports.command({
          origin: { kind: "volli", reason: "scheduled-resume" },
          commandId: retry.retryCommandId,
          sessionId: retry.sessionId,
          command: { kind: "executor.retry", attachmentId: retry.attachmentId },
        });
        const receipt = result.receipt;
        if (receipt?.status === "rejected") {
          // The engine re-judges a scheduled retry as it records it; a person
          // who took the Session back in the meantime is told that, not a
          // refusal.
          outcome = {
            kind: "skipped",
            reason: receipt.code === "resume_continued" ? "continued" : "refused",
            detail: receipt.detail,
          };
        } else if (receipt?.status === "accepted" || receipt?.status === "completed") {
          outcome = { kind: "resumed", retryCommandId: retry.retryCommandId };
        } else {
          return;
        }
      } catch (error) {
        // A host shutting down ends the run it was waiting on; the retry
        // command is on the ledger, and the next launch settles it.
        if (stopped) return;
        outcome = {
          kind: "skipped",
          reason: "refused",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      await settle(await ports.projection(retry.sessionId), scheduleId, outcome);
    })()
      .catch(onError)
      .finally(() => inFlight.delete(scheduleId));
    track(run);
  }

  async function inspect(sessionId: string): Promise<number | null> {
    const projection = await ports.projection(sessionId);
    const pending = pendingScheduledResume(projection);
    if (pending === null) {
      candidates.delete(sessionId);
      return null;
    }
    candidates.set(sessionId, pending.id);
    if (inFlight.has(pending.id)) return null;
    // Not due, and nothing to settle: the verdict would say wait, and asking
    // it would cost a fold of every Session on the Ticket for nothing.
    const fireAt = scheduledResumeFireAt(pending.resumeAt);
    if (!pending.fired && now() < fireAt) return fireAt;
    const { ticketId, projectId } = projection.session;
    const ticketSessions =
      ticketId === null ? [] : await ports.ticketSessions({ projectId, ticketId });
    const verdict = scheduledResumeVerdict({ projection, ticketSessions, now: now() });
    /* v8 ignore next -- the pending read above and the verdict fold the same projection. */
    if (verdict === null) return null;
    switch (verdict.kind) {
      case "wait":
        return verdict.at;
      case "settle":
        await settle(projection, pending.id, verdict.outcome);
        return null;
      case "resume":
        resume(pending.id, verdict);
        return null;
    }
  }

  async function runPass(): Promise<void> {
    let nextAt: number | null = null;
    for (const sessionId of Array.from(candidates.keys())) {
      try {
        const due = await inspect(sessionId);
        if (due !== null) nextAt = nextAt === null ? due : Math.min(nextAt, due);
      } catch (error) {
        onError(error);
      }
    }
    arm(nextAt);
  }

  function pass(): Promise<void> {
    if (stopped) return Promise.resolve();
    // One pass at a time: a wake arriving mid-pass joins it rather than
    // starting a second walk over the same schedules.
    running ??= runPass().finally(() => {
      running = null;
    });
    track(running);
    return running;
  }

  return {
    async start() {
      stopped = false;
      try {
        for (const sessionId of await ports.candidates()) candidates.set(sessionId, null);
      } catch (error) {
        onError(error);
      }
      await pass();
    },
    observe(projection) {
      const sessionId = projection.session.id;
      const pending = pendingScheduledResume(projection);
      if (pending === null) {
        candidates.delete(sessionId);
        return;
      }
      const known = candidates.get(sessionId) === pending.id;
      candidates.set(sessionId, pending.id);
      // A schedule no pass has seen yet: look now, which re-arms the timer at
      // its time (or fires it, if it was made for a moment already past).
      if (!known) void pass();
    },
    pass,
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    async settled() {
      while (work.size > 0) await Promise.allSettled(Array.from(work));
    },
  };
}
