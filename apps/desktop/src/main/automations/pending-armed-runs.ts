/**
 * Main's one armed-column countdown owner (VC-226).
 *
 * A committed Deliberate move is classified here, persisted here and timed
 * here. Renderer windows project the pending list and send Cancel or retained
 * Retry for an exact arrival id. Window count therefore cannot decide whether
 * the Run fires, how many timers exist, or which command a retry uses.
 */
import {
  armedAutomationFor,
  armedMoveDecision,
  armedRunVerdict,
  openArmedRun,
  type Automation,
  type ColumnArming,
  type DeliberateMoveChoice,
  type PendingArmedRun,
  type PendingArmedRunAttempt,
  type PendingArmedRunFailure,
  type TicketStatus,
} from "@volli/shared";

import type { RunAutomationOutcome } from "./run";

export interface DeliberateMoveArrival {
  projectId: string;
  ticketId: string;
  from: TicketStatus;
  to: TicketStatus;
  choice?: DeliberateMoveChoice;
}

export type PendingArmedRunSettlement =
  | { kind: "attempted"; pending: PendingArmedRun; result: RunAutomationOutcome }
  | { kind: "failed"; pending: PendingArmedRun; error: string }
  | {
      kind: "abandoned";
      pending: PendingArmedRun;
      reason: "gone" | "left-column" | "disarmed" | "switched-off";
    };

export interface PendingArmedRunCoordinatorDeps {
  now(): number;
  nextId(): string;
  listPending(): PendingArmedRun[];
  getPending(id: string): PendingArmedRun | undefined;
  putPending(pending: PendingArmedRun): void;
  deletePending(id: string): boolean;
  deletePendingForTicket(ticketId: string): boolean;
  /** Moves the exact countdown into a retained command intent in one durable transaction. */
  beginAttempt(
    id: string,
    commandId: string,
    fallbackError: string,
  ): PendingArmedRunAttempt | undefined;
  listAttempts(): PendingArmedRunAttempt[];
  getAttempt(id: string): PendingArmedRunAttempt | undefined;
  updateAttemptError(id: string, error: string): boolean;
  deleteAttempt(id: string): boolean;
  readTicket(ticketId: string):
    | {
        projectId: string;
        status: TicketStatus;
        displayId: string;
      }
    | undefined;
  readPlanning(projectId: string): {
    automations: readonly Automation[];
    armings: readonly ColumnArming[];
    enabledAutomationIds: readonly string[];
  };
  run(input: {
    commandId: string;
    automationId: string;
    ticketId: string;
  }): Promise<RunAutomationOutcome>;
  setTimer(delayMs: number, fire: () => void): unknown;
  clearTimer(handle: unknown): void;
  onPendingChanged?(pending: readonly PendingArmedRun[]): void;
  onSettled?(settlement: PendingArmedRunSettlement): void;
  log?(message: string): void;
}

export interface PendingArmedRunCoordinator {
  start(): void;
  stop(): void;
  noteDeliberateMove(move: DeliberateMoveArrival): void;
  cancel(id: string): boolean;
  list(): PendingArmedRun[];
  /** Expired attempts whose retained command id can be retried. */
  failures(): PendingArmedRunFailure[];
  /** Retries one exact arrival in detached work, reusing its retained command id. */
  retry(id: string): boolean;
  /** Work currently detached behind timer callbacks; tests use this instead of sleeping. */
  settled(): Promise<void>;
}

const INTERRUPTED_ATTEMPT_ERROR =
  "The armed automation Run stopped before confirming whether it started.";

export function createPendingArmedRunCoordinator(
  deps: PendingArmedRunCoordinatorDeps,
): PendingArmedRunCoordinator {
  const timers = new Map<string, unknown>();
  const inFlight = new Set<Promise<void>>();
  const attemptsInFlight = new Set<string>();
  let running = false;

  const list = (): PendingArmedRun[] => deps.listPending();
  const failures = (): PendingArmedRunFailure[] =>
    deps
      .listAttempts()
      .flatMap((attempt) =>
        attemptsInFlight.has(attempt.pending.id)
          ? []
          : [{ pending: attempt.pending, error: attempt.error }],
      );

  function publish(): void {
    deps.onPendingChanged?.(list());
  }

  function clearScheduled(id: string): void {
    const timer = timers.get(id);
    if (timer === undefined) return;
    deps.clearTimer(timer);
    timers.delete(id);
  }

  function track(work: Promise<void>): void {
    inFlight.add(work);
    void work.then(
      () => inFlight.delete(work),
      (error: unknown) => {
        inFlight.delete(work);
        const message = error instanceof Error ? error.message : String(error);
        deps.log?.(`[volli] armed countdown settlement failed: ${message}`);
      },
    );
  }

  function schedule(pending: PendingArmedRun): void {
    if (!running) return;
    clearScheduled(pending.id);
    const delay = Math.max(0, pending.startAt - deps.now());
    timers.set(
      pending.id,
      deps.setTimer(delay, () => {
        timers.delete(pending.id);
        track(settle(pending.id));
      }),
    );
  }

  async function runAttempt(attempt: PendingArmedRunAttempt): Promise<void> {
    const id = attempt.pending.id;
    if (attemptsInFlight.has(id)) return;
    attemptsInFlight.add(id);
    try {
      let result: RunAutomationOutcome;
      try {
        result = await deps.run({
          commandId: attempt.commandId,
          automationId: attempt.pending.automationId,
          ticketId: attempt.pending.ticketId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          deps.updateAttemptError(id, message);
        } catch (storageError) {
          const storageMessage =
            storageError instanceof Error ? storageError.message : String(storageError);
          deps.log?.(`[volli] armed automation failure could not be updated: ${storageMessage}`);
        }
        deps.log?.(`[volli] armed automation run failed: ${message}`);
        deps.onSettled?.({ kind: "failed", pending: attempt.pending, error: message });
        return;
      }

      try {
        if (!deps.deleteAttempt(id)) {
          throw new Error(`Retained armed Run ${id} disappeared before completion`);
        }
      } catch (error) {
        // The fallback failure was stored before Run. If cleanup cannot commit,
        // leave that row retryable rather than claiming this reply completed.
        const message = error instanceof Error ? error.message : String(error);
        deps.log?.(`[volli] armed automation completion could not be recorded: ${message}`);
        deps.onSettled?.({ kind: "failed", pending: attempt.pending, error: message });
        return;
      }
      deps.onSettled?.({ kind: "attempted", pending: attempt.pending, result });
    } finally {
      attemptsInFlight.delete(id);
    }
  }

  async function settle(id: string): Promise<void> {
    const pending = deps.getPending(id);
    // Replaced, cancelled, cascaded away, or already claimed by another
    // callback. Re-publish the durable truth so a window that still held this
    // id cannot leave a zero-second card behind.
    if (pending === undefined) {
      publish();
      return;
    }

    const planning = deps.readPlanning(pending.projectId);
    const ticket = deps.readTicket(pending.ticketId);
    const verdict = armedRunVerdict({
      pending,
      now: deps.now(),
      currentStatus:
        ticket === undefined || ticket.projectId !== pending.projectId ? null : ticket.status,
      armedNow: armedAutomationFor(planning.automations, planning.armings, pending.status),
      enabledAutomationIds: planning.enabledAutomationIds,
    });
    if (verdict.kind === "wait") {
      schedule(pending);
      return;
    }

    if (verdict.kind === "abandon") {
      // Claim settlement by deleting the exact row before announcing it. There
      // is one main timer, but this also makes a duplicate callback harmless.
      if (!deps.deletePending(pending.id)) return;
      clearScheduled(pending.id);
      publish();
      deps.onSettled?.({ kind: "abandoned", pending, reason: verdict.reason });
      return;
    }

    // Mint and retain the command BEFORE Run crosses a process/runtime
    // boundary. The atomic transition also closes the countdown, and a crash
    // anywhere after it leaves one exact arrival-shaped Retry intent.
    const attempt = deps.beginAttempt(pending.id, deps.nextId(), INTERRUPTED_ATTEMPT_ERROR);
    if (attempt === undefined) return;
    clearScheduled(pending.id);
    publish();
    await runAttempt(attempt);
  }

  return {
    start() {
      if (running) return;
      running = true;
      for (const pending of list()) schedule(pending);
    },

    stop() {
      running = false;
      for (const id of timers.keys()) clearScheduled(id);
    },

    noteDeliberateMove(move) {
      const prior = list().find((pending) => pending.ticketId === move.ticketId);
      if (prior !== undefined) clearScheduled(prior.id);
      const removed = deps.deletePendingForTicket(move.ticketId);

      const ticket = deps.readTicket(move.ticketId);
      if (
        ticket === undefined ||
        ticket.projectId !== move.projectId ||
        ticket.status !== move.to
      ) {
        if (removed) publish();
        return;
      }

      const planning = deps.readPlanning(move.projectId);
      const decision = armedMoveDecision({
        ...planning,
        from: move.from,
        to: move.to,
        ...(move.choice === undefined ? {} : { choice: move.choice }),
      });
      if (decision.kind === "nothing") {
        if (removed) publish();
        return;
      }

      const pending = openArmedRun({
        id: deps.nextId(),
        ticketId: move.ticketId,
        ticketDisplayId: ticket.displayId,
        projectId: move.projectId,
        automation: decision.automation,
        status: move.to,
        origin: decision.origin,
        now: deps.now(),
      });
      deps.putPending(pending);
      schedule(pending);
      publish();
    },

    cancel(id) {
      const pending = deps.getPending(id);
      if (pending === undefined || !deps.deletePending(id)) {
        publish();
        return false;
      }
      clearScheduled(id);
      publish();
      return true;
    },

    list,

    failures,

    retry(id) {
      const attempt = deps.getAttempt(id);
      if (attempt === undefined) return false;
      if (!attemptsInFlight.has(id)) track(runAttempt(attempt));
      return true;
    },

    async settled() {
      while (inFlight.size > 0) await Promise.all(inFlight);
    },
  };
}
