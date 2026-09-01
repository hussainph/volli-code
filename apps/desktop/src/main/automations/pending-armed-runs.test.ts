import type { Automation, ColumnArming, PendingArmedRun, TicketStatus } from "@volli/shared";
import { ARMED_RUN_DELAY_MS } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { createPendingArmedRunCoordinator } from "./pending-armed-runs";
import type { RunAutomationOutcome } from "./run";

const AUTOMATION: Automation = {
  id: "a1",
  projectId: "p1",
  name: "Review sweep",
  instructions: "/review",
  trigger: { kind: "columns", columns: ["doing"] },
  runtime: null,
  createdAt: 0,
  updatedAt: 0,
};

const ARMING: ColumnArming = {
  projectId: "p1",
  status: "doing",
  automationId: AUTOMATION.id,
  armedAt: 0,
};

const RUN_OK: RunAutomationOutcome = {
  ok: true,
  projectId: "p1",
  run: {
    id: "run-1",
    automationId: "a1",
    automationName: "Review sweep",
    ticketId: "t1",
    sessionId: "session-1",
    model: { providerId: "anthropic", modelId: "claude", reasoningLevel: "medium" },
    attendance: "attended",
    createdAt: 4_500,
  },
  receipt: {
    id: "receipt-1",
    commandId: "command-1",
    status: "completed",
    recordedAt: 4_500,
  },
};

interface ManualTimer {
  delay: number;
  fire: () => void;
  cleared: boolean;
}

function harness(options: { windowCount?: number; rows?: Map<string, PendingArmedRun> } = {}) {
  let now = 1_000;
  let next = 0;
  const rows = options.rows ?? new Map<string, PendingArmedRun>();
  const timers: ManualTimer[] = [];
  const windows = Array.from({ length: options.windowCount ?? 0 }, () => [] as PendingArmedRun[][]);
  const run = vi.fn(async () => RUN_OK);
  let status: TicketStatus | null = "doing";
  let armings: readonly ColumnArming[] = [ARMING];
  let enabledIds: readonly string[] = [AUTOMATION.id];

  const coordinator = createPendingArmedRunCoordinator({
    now: () => now,
    nextId: () => (next++ === 0 ? "arrival-1" : `command-${next - 1}`),
    listPending: () => [...rows.values()].toSorted((a, b) => a.startAt - b.startAt),
    getPending: (id) => [...rows.values()].find((row) => row.id === id),
    putPending: (pending) => rows.set(pending.ticketId, pending),
    deletePending: (id) => {
      const row = [...rows.values()].find((candidate) => candidate.id === id);
      return row === undefined ? false : rows.delete(row.ticketId);
    },
    deletePendingForTicket: (ticketId) => rows.delete(ticketId),
    readTicket: () =>
      status === null ? undefined : { projectId: "p1", status, displayId: "VC-12" },
    readPlanning: () => ({
      automations: [AUTOMATION],
      armings,
      enabledAutomationIds: enabledIds,
    }),
    run,
    setTimer: (delay, fire) => {
      const timer = { delay, fire, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as ManualTimer).cleared = true;
    },
    onPendingChanged: (pending) => {
      for (const window of windows) window.push([...pending]);
    },
  });

  async function elapse(delay = ARMED_RUN_DELAY_MS): Promise<void> {
    now += delay;
    const timer = timers.find((candidate) => !candidate.cleared);
    if (timer === undefined) throw new Error("No timer is armed");
    timer.cleared = true;
    timer.fire();
    await coordinator.settled();
  }

  return {
    coordinator,
    rows,
    timers,
    windows,
    run,
    elapse,
    setStatus: (nextStatus: TicketStatus | null) => {
      status = nextStatus;
    },
    setArmings: (nextArmings: readonly ColumnArming[]) => {
      armings = nextArmings;
    },
    setEnabledIds: (ids: readonly string[]) => {
      enabledIds = ids;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

function noteArrival(h: ReturnType<typeof harness>): void {
  h.coordinator.noteDeliberateMove({
    projectId: "p1",
    ticketId: "t1",
    from: "todo",
    to: "doing",
  });
}

describe("main-owned pending armed Runs", () => {
  it("fires a CLI arrival after 3500ms with zero renderer windows", async () => {
    const h = harness({ windowCount: 0 });
    h.coordinator.start();

    noteArrival(h);
    expect(h.rows.get("t1")?.id).toBe("arrival-1");
    expect(h.run).not.toHaveBeenCalled();

    await h.elapse();

    expect(h.run).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenCalledWith({
      commandId: "command-1",
      automationId: "a1",
      ticketId: "t1",
    });
    expect(h.rows.size).toBe(0);
  });

  it("publishes one shared countdown to two windows and Cancel from either clears both", async () => {
    const h = harness({ windowCount: 2 });
    h.coordinator.start();

    noteArrival(h);

    const firstWindow = h.windows[0]?.at(-1)?.[0];
    const secondWindow = h.windows[1]?.at(-1)?.[0];
    expect(firstWindow?.id).toBe("arrival-1");
    expect(secondWindow).toEqual(firstWindow);
    expect(h.timers).toHaveLength(1);

    // The second renderer sends the same exact id it rendered.
    expect(h.coordinator.cancel(secondWindow!.id)).toBe(true);
    expect(h.windows[0]?.at(-1)).toEqual([]);
    expect(h.windows[1]?.at(-1)).toEqual([]);

    // Even if the cleared callback were delivered, its durable row is gone.
    h.timers[0]?.fire();
    await h.coordinator.settled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it("recovers a durable countdown after the coordinator restarts", async () => {
    const rows = new Map<string, PendingArmedRun>();
    const first = harness({ rows });
    first.coordinator.start();
    noteArrival(first);
    first.coordinator.stop();

    const recovered = harness({ rows });
    recovered.setNow(5_000);
    recovered.coordinator.start();
    expect(recovered.timers.at(-1)?.delay).toBe(0);

    await recovered.elapse(0);
    expect(recovered.run).toHaveBeenCalledOnce();
    expect(rows.size).toBe(0);
  });

  it("replaces a Ticket's earlier arrival and rejects its stale Cancel", () => {
    const h = harness({ windowCount: 2 });
    h.coordinator.start();
    noteArrival(h);
    const first = h.rows.get("t1")!;

    noteArrival(h);
    const second = h.rows.get("t1")!;

    expect(second.id).not.toBe(first.id);
    expect(h.coordinator.cancel(first.id)).toBe(false);
    expect(h.rows.get("t1")).toBe(second);
  });

  it("re-checks the ticket, arming and enablement when the deadline expires", async () => {
    const left = harness();
    left.coordinator.start();
    noteArrival(left);
    left.setStatus("todo");
    await left.elapse();
    expect(left.run).not.toHaveBeenCalled();

    const disarmed = harness();
    disarmed.coordinator.start();
    noteArrival(disarmed);
    disarmed.setArmings([]);
    await disarmed.elapse();
    expect(disarmed.run).not.toHaveBeenCalled();

    const switchedOff = harness();
    switchedOff.coordinator.start();
    noteArrival(switchedOff);
    switchedOff.setEnabledIds([]);
    await switchedOff.elapse();
    expect(switchedOff.run).not.toHaveBeenCalled();
  });
});
