import { ARMED_RUN_DELAY_MS, NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type { Automation, ColumnArming } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  armedMoveDecision,
  armedRunProgress,
  armedRunSecondsLeft,
  armedRunVerdict,
  openArmedRun,
  type PendingArmedRun,
} from "./armed-move-model";

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "a1",
    projectId: "p1",
    name: "Review sweep",
    instructions: "/review",
    trigger: { kind: "columns", columns: ["doing"] },
    runtime: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const ARMED: ColumnArming = {
  projectId: "p1",
  status: "doing",
  automationId: "a1",
  armedAt: 10,
};

function pending(overrides: Partial<PendingArmedRun> = {}): PendingArmedRun {
  return {
    ...openArmedRun({
      ticketId: "t1",
      ticketDisplayId: "VC-12",
      projectId: "p1",
      automation: automation(),
      status: "doing",
      now: 1_000,
    }),
    ...overrides,
  };
}

describe("armedMoveDecision", () => {
  it("opens a window for an arrival in an armed column", () => {
    const armed = automation();
    expect(
      armedMoveDecision({ automations: [armed], armings: [ARMED], from: "todo", to: "doing" }),
    ).toEqual({ kind: "open-window", automation: armed });
  });

  it("does nothing for an arrival in an unarmed column — today's behaviour, unchanged", () => {
    expect(
      armedMoveDecision({ automations: [automation()], armings: [], from: "todo", to: "doing" }),
    ).toEqual({ kind: "nothing" });
  });

  it("does nothing for a reorder inside the armed column — a slip that never left it", () => {
    expect(
      armedMoveDecision({
        automations: [automation()],
        armings: [ARMED],
        from: "doing",
        to: "doing",
      }),
    ).toEqual({ kind: "nothing" });
  });

  it("does nothing when the arming names an Automation that no longer offers the column", () => {
    expect(
      armedMoveDecision({
        automations: [automation({ trigger: NO_AUTOMATION_TRIGGER })],
        armings: [ARMED],
        from: "todo",
        to: "doing",
      }),
    ).toEqual({ kind: "nothing" });
  });
});

describe("openArmedRun", () => {
  it("puts the deadline exactly 3500 ms out and snapshots what it will start", () => {
    const window = openArmedRun({
      ticketId: "t1",
      ticketDisplayId: "VC-12",
      projectId: "p1",
      automation: automation(),
      status: "doing",
      now: 1_000,
    });
    expect(window.startAt).toBe(1_000 + ARMED_RUN_DELAY_MS);
    expect(window.openedAt).toBe(1_000);
    expect(window.automationName).toBe("Review sweep");
    expect(window.status).toBe("doing");
  });
});

describe("armedRunVerdict", () => {
  const open = pending();

  it("starts once the delay has passed undisturbed", () => {
    expect(
      armedRunVerdict({
        pending: open,
        now: open.startAt,
        currentStatus: "doing",
        armedNow: automation(),
      }),
    ).toEqual({ kind: "start" });
  });

  it("refuses to start early, however the caller got here, and says what is really left", () => {
    expect(
      armedRunVerdict({
        pending: open,
        now: open.startAt - 400,
        currentStatus: "doing",
        armedNow: automation(),
      }),
    ).toEqual({ kind: "wait", remainingMs: 400 });
  });

  it("abandons a Ticket that left the column inside the window", () => {
    expect(
      armedRunVerdict({
        pending: open,
        now: open.startAt,
        currentStatus: "todo",
        armedNow: automation(),
      }),
    ).toEqual({ kind: "abandon", reason: "left-column" });
  });

  it("abandons a Ticket the board no longer holds", () => {
    expect(
      armedRunVerdict({
        pending: open,
        now: open.startAt,
        currentStatus: null,
        armedNow: automation(),
      }),
    ).toEqual({ kind: "abandon", reason: "gone" });
  });

  it("abandons when the column was disarmed, or now arms something else", () => {
    expect(
      armedRunVerdict({
        pending: open,
        now: open.startAt,
        currentStatus: "doing",
        armedNow: null,
      }),
    ).toEqual({ kind: "abandon", reason: "disarmed" });
    expect(
      armedRunVerdict({
        pending: open,
        now: open.startAt,
        currentStatus: "doing",
        armedNow: automation({ id: "a2" }),
      }),
    ).toEqual({ kind: "abandon", reason: "disarmed" });
  });

  it("checks the clock BEFORE the board — an early wake is never an abandonment", () => {
    expect(
      armedRunVerdict({
        pending: open,
        now: open.openedAt,
        currentStatus: null,
        armedNow: null,
      }),
    ).toEqual({ kind: "wait", remainingMs: ARMED_RUN_DELAY_MS });
  });
});

describe("armedRunProgress", () => {
  const open = pending();

  it("runs from 0 at the open to 1 at the deadline", () => {
    expect(armedRunProgress(open, open.openedAt)).toBe(0);
    expect(armedRunProgress(open, open.openedAt + ARMED_RUN_DELAY_MS / 2)).toBeCloseTo(0.5);
    expect(armedRunProgress(open, open.startAt)).toBe(1);
  });

  it("clamps a clock that jumped in either direction", () => {
    expect(armedRunProgress(open, open.openedAt - 10_000)).toBe(0);
    expect(armedRunProgress(open, open.startAt + 10_000)).toBe(1);
  });

  it("reads a zero-length window as finished rather than as NaN", () => {
    // Unreachable through `openArmedRun` while the delay is a positive
    // constant, and guarded anyway: the view divides by this span to size a
    // bar, and `width: NaN%` is a silently invisible countdown.
    expect(armedRunProgress(pending({ startAt: open.openedAt }), open.openedAt)).toBe(1);
  });
});

describe("armedRunSecondsLeft", () => {
  const open = pending();

  it("counts 4, 3, 2, 1 and floors at zero", () => {
    expect(armedRunSecondsLeft(open, open.openedAt)).toBe(4);
    expect(armedRunSecondsLeft(open, open.startAt - 2_400)).toBe(3);
    expect(armedRunSecondsLeft(open, open.startAt - 1)).toBe(1);
    expect(armedRunSecondsLeft(open, open.startAt)).toBe(0);
    expect(armedRunSecondsLeft(open, open.startAt + 5_000)).toBe(0);
  });
});
