import { ARMED_RUN_DELAY_MS, NO_AUTOMATION_TRIGGER } from "./automation";
import type { Automation, ColumnArming } from "./automation";
import { describe, expect, it } from "vite-plus/test";

import {
  armedMoveDecision,
  armedRunProgress,
  armedRunSecondsLeft,
  armedRunVerdict,
  openArmedRun,
  type PendingArmedRun,
} from "./automation";

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

/** The armed Automation, switched ON on this machine — the ordinary case. */
const ENABLED: readonly string[] = ["a1"];

function pending(overrides: Partial<PendingArmedRun> = {}): PendingArmedRun {
  return {
    ...openArmedRun({
      id: "arrival-1",
      ticketId: "t1",
      ticketDisplayId: "VC-12",
      projectId: "p1",
      automation: automation(),
      status: "doing",
      origin: "armed",
      now: 1_000,
    }),
    ...overrides,
  };
}

describe("armedMoveDecision", () => {
  it("opens a window for an arrival in an armed column", () => {
    const armed = automation();
    expect(
      armedMoveDecision({
        automations: [armed],
        armings: [ARMED],
        enabledAutomationIds: ENABLED,
        from: "todo",
        to: "doing",
      }),
    ).toEqual({ kind: "open-window", automation: armed, origin: "armed" });
  });

  it("does nothing for an arrival in an unarmed column — today's behaviour, unchanged", () => {
    expect(
      armedMoveDecision({
        automations: [automation()],
        armings: [],
        enabledAutomationIds: ENABLED,
        from: "todo",
        to: "doing",
      }),
    ).toEqual({ kind: "nothing" });
  });

  it("does nothing for a reorder inside the armed column — a slip that never left it", () => {
    expect(
      armedMoveDecision({
        automations: [automation()],
        armings: [ARMED],
        enabledAutomationIds: ENABLED,
        from: "doing",
        to: "doing",
      }),
    ).toEqual({ kind: "nothing" });
  });

  it("does nothing when the armed Automation is switched off on this machine", () => {
    // VC-112: a machine fires nothing until someone turns something on there.
    // The column keeps its arming — this is the other switch, not a disarm.
    expect(
      armedMoveDecision({
        automations: [automation()],
        armings: [ARMED],
        enabledAutomationIds: [],
        from: "todo",
        to: "doing",
      }),
    ).toEqual({ kind: "nothing" });
    // And a set that names some OTHER Automation is not this one being on.
    expect(
      armedMoveDecision({
        automations: [automation()],
        armings: [ARMED],
        enabledAutomationIds: ["a2"],
        from: "todo",
        to: "doing",
      }),
    ).toEqual({ kind: "nothing" });
  });

  it("does nothing when the arming names an Automation that no longer offers the column", () => {
    expect(
      armedMoveDecision({
        automations: [automation({ trigger: NO_AUTOMATION_TRIGGER })],
        armings: [ARMED],
        enabledAutomationIds: ENABLED,
        from: "todo",
        to: "doing",
      }),
    ).toEqual({ kind: "nothing" });
  });
});

describe("armedMoveDecision — what the ⌥ picker named (VC-132)", () => {
  const picked = automation({ id: "a2", name: "Two-opinion review" });

  it("opens the SAME window for a named Automation, marked as chosen", () => {
    expect(
      armedMoveDecision({
        automations: [automation(), picked],
        armings: [ARMED],
        enabledAutomationIds: ENABLED,
        from: "todo",
        to: "doing",
        choice: { kind: "automation", automationId: "a2" },
      }),
    ).toEqual({ kind: "open-window", automation: picked, origin: "chosen" });
  });

  it("opens it in an UNARMED column, and for an Automation switched off here", () => {
    // An ⌥-pick is a person, and both switches govern what starts an
    // Automation *besides* a person (VC-112).
    expect(
      armedMoveDecision({
        automations: [picked],
        armings: [],
        enabledAutomationIds: [],
        from: "todo",
        to: "doing",
        choice: { kind: "automation", automationId: "a2" },
      }),
    ).toEqual({ kind: "open-window", automation: picked, origin: "chosen" });
  });

  it("lands Move only as a pure move, whatever the column arms", () => {
    expect(
      armedMoveDecision({
        automations: [automation()],
        armings: [ARMED],
        enabledAutomationIds: ENABLED,
        from: "todo",
        to: "doing",
        choice: { kind: "move-only" },
      }),
    ).toEqual({ kind: "nothing" });
  });

  it("starts nothing when the picked Automation was deleted mid-flight", () => {
    // Never the column's armed one instead: running something nobody named is
    // the one substitution this whole gesture exists to prevent.
    expect(
      armedMoveDecision({
        automations: [automation()],
        armings: [ARMED],
        enabledAutomationIds: ENABLED,
        from: "todo",
        to: "doing",
        choice: { kind: "automation", automationId: "gone" },
      }),
    ).toEqual({ kind: "nothing" });
  });

  it("still refuses a release that is not an arrival", () => {
    // "`1` reproduces a plain drop" is only true in every column if a pick
    // obeys the arrival rule the plain drop obeys — a card released back into
    // the column it came from starts nothing, picked or not.
    expect(
      armedMoveDecision({
        automations: [automation(), picked],
        armings: [ARMED],
        enabledAutomationIds: ENABLED,
        from: "doing",
        to: "doing",
        choice: { kind: "automation", automationId: "a2" },
      }),
    ).toEqual({ kind: "nothing" });
  });
});

describe("openArmedRun", () => {
  it("puts the deadline exactly 3500 ms out and snapshots what it will start", () => {
    const window = openArmedRun({
      id: "arrival-1",
      ticketId: "t1",
      ticketDisplayId: "VC-12",
      projectId: "p1",
      automation: automation(),
      status: "doing",
      origin: "armed",
      now: 1_000,
    });
    expect(window.startAt).toBe(1_000 + ARMED_RUN_DELAY_MS);
    expect(window.openedAt).toBe(1_000);
    expect(window.automationName).toBe("Review sweep");
    expect(window.status).toBe("doing");
    expect(window.origin).toBe("armed");
  });

  it("gives a picked window the same delay and the same one control", () => {
    // The whole ruling in one assertion: a named target does not bypass the
    // window, it opens it.
    const window = openArmedRun({
      id: "arrival-1",
      ticketId: "t1",
      ticketDisplayId: "VC-12",
      projectId: "p1",
      automation: automation({ id: "a2" }),
      status: "doing",
      origin: "chosen",
      now: 1_000,
    });
    expect(window.startAt - window.openedAt).toBe(ARMED_RUN_DELAY_MS);
    expect(window.origin).toBe("chosen");
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
        enabledAutomationIds: ENABLED,
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
        enabledAutomationIds: ENABLED,
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
        enabledAutomationIds: ENABLED,
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
        enabledAutomationIds: ENABLED,
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
        enabledAutomationIds: ENABLED,
      }),
    ).toEqual({ kind: "abandon", reason: "disarmed" });
    expect(
      armedRunVerdict({
        pending: open,
        now: open.startAt,
        currentStatus: "doing",
        armedNow: automation({ id: "a2" }),
        enabledAutomationIds: ENABLED,
      }),
    ).toEqual({ kind: "abandon", reason: "disarmed" });
  });

  it("abandons an Automation switched off inside the window, and says which switch", () => {
    expect(
      armedRunVerdict({
        pending: open,
        now: open.startAt,
        currentStatus: "doing",
        armedNow: automation(),
        enabledAutomationIds: [],
      }),
      // Named apart from "disarmed": the column still arms it, so sending the
      // person to the column bolt to undo this would be the wrong control.
    ).toEqual({ kind: "abandon", reason: "switched-off" });
  });

  it("keeps a CHOSEN window through a disarm and through the machine-local switch", () => {
    const chosen = pending({ origin: "chosen" });
    expect(
      armedRunVerdict({
        pending: chosen,
        now: chosen.startAt,
        currentStatus: "doing",
        armedNow: null,
        enabledAutomationIds: [],
      }),
    ).toEqual({ kind: "start" });
  });

  it("still abandons a CHOSEN window when the arrival itself stopped being true", () => {
    const chosen = pending({ origin: "chosen" });
    expect(
      armedRunVerdict({
        pending: chosen,
        now: chosen.startAt,
        currentStatus: "todo",
        armedNow: null,
        enabledAutomationIds: [],
      }),
    ).toEqual({ kind: "abandon", reason: "left-column" });
    expect(
      armedRunVerdict({
        pending: chosen,
        now: chosen.startAt,
        currentStatus: null,
        armedNow: null,
        enabledAutomationIds: [],
      }),
    ).toEqual({ kind: "abandon", reason: "gone" });
  });

  it("checks the clock BEFORE the board — an early wake is never an abandonment", () => {
    expect(
      armedRunVerdict({
        pending: open,
        now: open.openedAt,
        currentStatus: null,
        armedNow: null,
        enabledAutomationIds: ENABLED,
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
