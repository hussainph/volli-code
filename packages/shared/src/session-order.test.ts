import { describe, expect, it } from "vite-plus/test";

import {
  applyHeldOrder,
  commitHeldOrder,
  frozenHeldOrder,
  heldOrderTarget,
  sameHeldOrder,
  type HeldSessionOrder,
  type SessionOrderMember,
  type SessionOrderPhase,
} from "./session-order";

/**
 * The lab's afternoon, as membership: a Session asking a question, two working,
 * two at rest — in the shipped order, which is where the held order starts.
 * `a1` is the question already open; every case below moves one row and asserts
 * what the rest of the band did about it.
 */
const START: readonly SessionOrderMember[] = [
  { id: "a1", phase: "waiting" },
  { id: "a2", phase: "working" },
  { id: "a3", phase: "working" },
  { id: "a4", phase: "resting" },
  { id: "a5", phase: "resting" },
];

const ids = (members: readonly SessionOrderMember[]): readonly string[] =>
  members.map((member) => member.id);

/** The same band with one row's phase changed — a question asked, a turn started. */
function withPhase(
  members: readonly SessionOrderMember[],
  id: string,
  phase: SessionOrderPhase,
): readonly SessionOrderMember[] {
  return members.map((member) => (member.id === id ? { id, phase } : member));
}

const HELD: HeldSessionOrder = commitHeldOrder(ids(START), START);

describe("heldOrderTarget", () => {
  it("starts where the shipped band would, with nothing committed", () => {
    expect(heldOrderTarget(null, START)).toEqual(ids(START));
  });

  it("holds every row through tool calls, a finished turn and a read", () => {
    // Nothing a tool call, a turn ending or a receipt does touches a phase.
    expect(heldOrderTarget(HELD, START)).toEqual(ids(START));
    expect(heldOrderTarget(HELD, withPhase(START, "a2", "resting"))).toEqual(ids(START));
  });

  it("floats a new question above everything, the one already open included", () => {
    const asked = withPhase(START, "a3", "waiting");
    expect(heldOrderTarget(HELD, asked)).toEqual(["a3", "a1", "a2", "a4", "a5"]);
  });

  it("lifts a row to the top when a new turn starts, and lands it under the question", () => {
    const started = withPhase(START, "a5", "working");
    expect(heldOrderTarget(HELD, started)).toEqual(["a1", "a5", "a2", "a3", "a4"]);
  });

  it("lands a new turn at the very top once no question is open", () => {
    const answered = withPhase(START, "a1", "working");
    const afterAnswer = commitHeldOrder(ids(START), answered);
    const started = withPhase(answered, "a5", "working");
    expect(heldOrderTarget(afterAnswer, started)).toEqual(["a5", "a1", "a2", "a3", "a4"]);
  });

  it("does not count an answer as a new turn: waiting → working holds", () => {
    expect(heldOrderTarget(HELD, withPhase(START, "a1", "working"))).toEqual(ids(START));
  });

  it("pins an answered question where it floated, over one still asked", () => {
    const asked = withPhase(START, "a3", "waiting");
    const floated = heldOrderTarget(HELD, asked);
    const afterAsk = commitHeldOrder([...floated], asked);
    const answered = withPhase(asked, "a3", "working");
    expect(heldOrderTarget(afterAsk, answered)).toEqual(floated);
  });

  it("lands a row new to the band under the questions still open", () => {
    const joined = [...START, { id: "p1", phase: "resting" } as const];
    expect(heldOrderTarget(HELD, joined)).toEqual(["a1", "p1", "a2", "a3", "a4", "a5"]);
  });

  it("lands a row new to the band at the very top when nothing is asking", () => {
    const quiet = withPhase(START, "a1", "resting");
    const committed = commitHeldOrder(ids(START), quiet);
    const joined = [...quiet, { id: "p1", phase: "resting" } as const];
    expect(heldOrderTarget(committed, joined)).toEqual(["p1", "a1", "a2", "a3", "a4", "a5"]);
  });

  it("keeps several lifted rows in the shipped order, under the questions", () => {
    const busy = withPhase(withPhase(START, "a4", "working"), "a5", "working");
    expect(heldOrderTarget(HELD, busy)).toEqual(["a1", "a4", "a5", "a2", "a3"]);
  });

  it("drops a row that has left the band, moving nothing else", () => {
    const left = START.filter((member) => member.id !== "a3");
    expect(heldOrderTarget(HELD, left)).toEqual(["a1", "a2", "a4", "a5"]);
  });

  it("puts a brand-new question above a lift arriving in the same build", () => {
    const both = withPhase(withPhase(START, "a4", "waiting"), "a5", "working");
    expect(heldOrderTarget(HELD, both)).toEqual(["a4", "a1", "a5", "a2", "a3"]);
  });
});

describe("commitHeldOrder", () => {
  it("records the order drawn and the phase every member was in", () => {
    expect(HELD).toEqual({
      order: ["a1", "a2", "a3", "a4", "a5"],
      phases: { a1: "waiting", a2: "working", a3: "working", a4: "resting", a5: "resting" },
    });
  });
});

describe("frozenHeldOrder", () => {
  it("draws exactly what it committed, a retired row included, and adds at the bottom", () => {
    expect(frozenHeldOrder(HELD, ["a1", "a2", "new"])).toEqual([...HELD.order, "new"]);
  });
});

describe("sameHeldOrder", () => {
  it("knows when a commit would change nothing", () => {
    expect(sameHeldOrder(HELD, commitHeldOrder(ids(START), START))).toBe(true);
  });

  it("is never the same as never having committed", () => {
    expect(sameHeldOrder(null, HELD)).toBe(false);
  });

  it("compares the order", () => {
    expect(sameHeldOrder(HELD, commitHeldOrder(HELD.order.toReversed(), START))).toBe(false);
  });

  it("compares membership by length too", () => {
    const shorter = commitHeldOrder(HELD.order.slice(1), START.slice(1));
    expect(sameHeldOrder(HELD, shorter)).toBe(false);
  });

  it("compares the phases, not only the order", () => {
    const asked = commitHeldOrder(ids(START), withPhase(START, "a3", "waiting"));
    expect(sameHeldOrder(HELD, asked)).toBe(false);
  });
});

describe("applyHeldOrder", () => {
  const rows = [{ id: "a1" }, { id: "a2" }, { id: "a3" }];

  it("puts rows in the committed order", () => {
    expect(applyHeldOrder(["a3", "a1", "a2"], rows)).toEqual([
      { id: "a3" },
      { id: "a1" },
      { id: "a2" },
    ]);
  });

  it("ignores an id no row answers to — the rail holds a subset of the band", () => {
    expect(applyHeldOrder(["a9", "a2", "a1"], [{ id: "a1" }, { id: "a2" }])).toEqual([
      { id: "a2" },
      { id: "a1" },
    ]);
  });

  it("keeps rows the order has never heard of, in their own relative order, at the end", () => {
    expect(applyHeldOrder(["a3"], rows)).toEqual([{ id: "a3" }, { id: "a1" }, { id: "a2" }]);
  });

  it("places a row once, however often an order names it", () => {
    expect(applyHeldOrder(["a2", "a2", "a1"], rows)).toEqual([
      { id: "a2" },
      { id: "a1" },
      { id: "a3" },
    ]);
  });
});
