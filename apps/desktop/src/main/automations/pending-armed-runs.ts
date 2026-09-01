/**
 * Main's one armed-column countdown owner (VC-226).
 *
 * A committed Deliberate move is classified here, persisted here and timed
 * here. Renderer windows only project the full pending list and send Cancel
 * for an exact arrival id. Window count therefore cannot decide whether the
 * Run fires or how many timers exist.
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
  /** Work currently detached behind timer callbacks; tests use this instead of sleeping. */
  settled(): Promise<void>;
}

export function createPendingArmedRunCoordinator(
  deps: PendingArmedRunCoordinatorDeps,
): PendingArmedRunCoordinator {
  const timers = new Map<string, unknown>();
  const inFlight = new Set<Promise<void>>();
  let running = false;

  const list = (): PendingArmedRun[] => deps.listPending();

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

    // Claim settlement by deleting the exact row before any detached work.
    // There is one main timer, but this also makes an accidental duplicate
    // callback harmless and publishes the closed window before Run startup.
    if (!deps.deletePending(pending.id)) return;
    clearScheduled(pending.id);
    publish();

    if (verdict.kind === "abandon") {
      deps.onSettled?.({ kind: "abandoned", pending, reason: verdict.reason });
      return;
    }

    try {
      // Deliberately minted only at expiry and not retained with the pending
      // row. Durable command-id retry for this door is VC-228.
      const result = await deps.run({
        commandId: deps.nextId(),
        automationId: pending.automationId,
        ticketId: pending.ticketId,
      });
      deps.onSettled?.({ kind: "attempted", pending, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.(`[volli] armed automation run failed: ${message}`);
      deps.onSettled?.({ kind: "failed", pending, error: message });
    }
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

    async settled() {
      while (inFlight.size > 0) await Promise.all(inFlight);
    },
  };
}
