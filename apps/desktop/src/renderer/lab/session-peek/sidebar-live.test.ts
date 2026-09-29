import { describe, expect, it } from "vite-plus/test";

import {
  buildActiveSessionListing,
  type ActiveSessionRow,
} from "@renderer/components/sidebar/active-session-listing";

import { NOW } from "../fixtures";
import {
  activeMembers,
  applyWorld,
  commitOf,
  frozenOrder,
  heldTarget,
  listingInputOf,
  liveOf,
  phaseOf,
  sameOrder,
  SCRIPT,
  scriptEvents,
  WORLD_START,
  type HeldOrder,
  type QuestionRule,
  type World,
  type WorldEvent,
} from "./sidebar-live";

const MINUTE = 60_000;

function play(world: World, ...events: readonly WorldEvent[]): World {
  return events.reduce(applyWorld, world);
}

function membersOf(world: World): readonly ActiveSessionRow[] {
  const listing = buildActiveSessionListing({ ...listingInputOf(world), now: world.now });
  return activeMembers(listing, world.unread);
}

const ids = (rows: readonly ActiveSessionRow[]) => rows.map((row) => row.id);

describe("the world", () => {
  it("dates a tool call and changes nothing else", () => {
    const world = play(
      WORLD_START,
      { kind: "advance", ms: 10_000 },
      { kind: "tool-call", id: "chat-a3" },
    );
    expect(liveOf(world, "chat-a3")).toMatchObject({
      activity: "working",
      lastActivityAt: NOW + 10_000,
    });
    expect(world.unread["chat-a3"]).toBeUndefined();
  });

  it("leaves a turn that ends out of sight unread, and one that ends in front read", () => {
    const away = play(WORLD_START, { kind: "turn-complete", id: "chat-a3", inFront: false });
    expect(liveOf(away, "chat-a3")?.activity).toBe("idle");
    expect(away.unread["chat-a3"]).toBe(NOW);
    const watched = play(WORLD_START, { kind: "turn-complete", id: "chat-a3", inFront: true });
    expect(watched.unread["chat-a3"]).toBeUndefined();
  });

  it("asks, then resumes the same turn when answered", () => {
    const asked = play(WORLD_START, { kind: "ask", id: "chat-a2" });
    expect(liveOf(asked, "chat-a2")).toMatchObject({ activity: "waiting", waitingOn: "question" });
    expect(liveOf(play(asked, { kind: "answer", id: "chat-a2" }), "chat-a2")).toMatchObject({
      activity: "working",
      waitingOn: null,
    });
  });

  it("reads and unreads without touching activity or recency — a receipt is not work", () => {
    const before = liveOf(WORLD_START, "chat-a4");
    const read = play(WORLD_START, { kind: "read", id: "chat-a4" });
    expect(read.unread["chat-a4"]).toBeUndefined();
    expect(liveOf(read, "chat-a4")).toEqual(before);
    expect(play(read, { kind: "unread", id: "chat-a4" }).unread["chat-a4"]).toBe(NOW);
  });

  it("puts a Session's live fields back on restore, to the corpus when there were none", () => {
    const sent = play(WORLD_START, { kind: "answer", id: "chat-a1" });
    const undone = play(sent, { kind: "restore", id: "chat-a1", overlay: null });
    expect(undone.sessions["chat-a1"]).toBeUndefined();
    expect(liveOf(undone, "chat-a1")?.activity).toBe("waiting");
  });
});

describe("unread and the bands", () => {
  it("keeps a six-hour-old unread Session in Active, after the shipped band", () => {
    expect(ids(membersOf(WORLD_START))).toEqual([
      "chat:chat-a1",
      "chat:chat-a2",
      "chat:chat-a3",
      "chat:chat-a4",
      "chat:chat-a5",
      "chat:chat-p8",
    ]);
  });

  it("lets the clock retire it once it is read", () => {
    const read = play(WORLD_START, { kind: "read", id: "chat-p8" });
    expect(ids(membersOf(read))).not.toContain("chat:chat-p8");
  });

  it("brings a Previous Session back to Active when it is marked unread", () => {
    const marked = play(WORLD_START, { kind: "unread", id: "chat-p1" });
    expect(ids(membersOf(marked))).toContain("chat:chat-p1");
  });

  it("carries a retired row into Active as it was: quiet, its turn's end intact", () => {
    const died = play(WORLD_START, { kind: "unread", id: "chat-p6" });
    const row = membersOf(died).find((member) => member.id === "chat:chat-p6");
    expect(row).toMatchObject({ activity: "interrupted", attention: null });
    expect(row === undefined ? null : phaseOf(row)).toBe("idle");
  });
});

describe("the held order", () => {
  const start = membersOf(WORLD_START);
  const held: HeldOrder = commitOf(ids(start), start);

  it("starts where the shipped band would", () => {
    expect(heldTarget(null, start, "hold")).toEqual(ids(start));
  });

  it("holds every row through tool calls, a finished turn and a read", () => {
    const later = play(
      WORLD_START,
      { kind: "advance", ms: 10_000 },
      { kind: "tool-call", id: "chat-a3" },
      { kind: "turn-complete", id: "chat-a2", inFront: false },
      { kind: "read", id: "chat-a4" },
    );
    expect(heldTarget(held, membersOf(later), "hold")).toEqual(ids(start));
  });

  it("lifts a row to the top when a new turn starts, and only then", () => {
    const started = play(WORLD_START, { kind: "turn-start", id: "chat-a5" });
    expect(heldTarget(held, membersOf(started), "hold")[0]).toBe("chat:chat-a5");
  });

  it("does not count an answer as a new turn: waiting → working holds", () => {
    const answered = play(WORLD_START, { kind: "answer", id: "chat-a1" });
    expect(heldTarget(held, membersOf(answered), "hold")).toEqual(ids(start));
  });

  it("lifts a row new to the band to the top", () => {
    const marked = play(WORLD_START, { kind: "unread", id: "chat-p1" });
    expect(heldTarget(held, membersOf(marked), "hold")[0]).toBe("chat:chat-p1");
  });

  it("with questions held, a new question moves nothing; floated, it tops the band", () => {
    const asked = play(WORLD_START, { kind: "ask", id: "chat-a3" });
    expect(heldTarget(held, membersOf(asked), "hold")).toEqual(ids(start));
    expect(heldTarget(held, membersOf(asked), "float").slice(0, 2)).toEqual([
      "chat:chat-a3",
      "chat:chat-a1",
    ]);
  });

  describe("floated", () => {
    const asked = play(WORLD_START, { kind: "ask", id: "chat-a3" });
    const floated = heldTarget(held, membersOf(asked), "float");
    const afterAsk = commitOf([...floated], membersOf(asked));
    const answered = play(asked, { kind: "answer", id: "chat-a3" });
    const afterAnswer = commitOf([...floated], membersOf(answered));

    it("puts a new question above everything, the one already open included", () => {
      expect(floated.slice(0, 2)).toEqual(["chat:chat-a3", "chat:chat-a1"]);
    });

    it("pins an answered question where it floated, over one still asked", () => {
      expect(heldTarget(afterAsk, membersOf(answered), "float")).toEqual(floated);
    });

    it("lands a new turn under the lowest open question, not above it", () => {
      const started = play(answered, { kind: "turn-start", id: "chat-a5" });
      expect(heldTarget(afterAnswer, membersOf(started), "float").slice(0, 3)).toEqual([
        "chat:chat-a3",
        "chat:chat-a1",
        "chat:chat-a5",
      ]);
    });

    it("lands a new turn at the very top once no question is open", () => {
      const clear = play(answered, { kind: "answer", id: "chat-a1" });
      const cleared = commitOf([...floated], membersOf(clear));
      const started = play(clear, { kind: "turn-start", id: "chat-a5" });
      expect(heldTarget(cleared, membersOf(started), "float")[0]).toBe("chat:chat-a5");
    });
  });

  it("while frozen, draws exactly what it committed, a retired row included, and adds at the bottom", () => {
    expect(frozenOrder(held, ["chat:chat-a1", "chat:chat-a2", "chat:chat-new"])).toEqual([
      ...held.order,
      "chat:chat-new",
    ]);
  });

  it("knows when a commit would change nothing", () => {
    expect(sameOrder(held, commitOf(ids(start), start))).toBe(true);
    expect(sameOrder(null, held)).toBe(false);
    const moved = commitOf(held.order.toReversed(), start);
    expect(sameOrder(held, moved)).toBe(false);
  });
});

/** How many steps of a played script changed the band's order. */
function movesIn(orders: readonly string[][]): number {
  return orders.filter((order, index) => index > 0 && order.join() !== orders[index - 1]!.join())
    .length;
}

describe("the script", () => {
  function run(
    order: "held" | "live",
    questions: QuestionRule = "float",
  ): { orders: string[][]; world: World } {
    let world = WORLD_START;
    let committed: HeldOrder | null = null;
    const orders: string[][] = [];
    for (const step of SCRIPT) {
      world = play(world, ...scriptEvents(step, "chat-a2"));
      const members = membersOf(world);
      const target =
        order === "live" ? ids(members) : [...heldTarget(committed, members, questions)];
      committed = commitOf(target, members);
      orders.push(target);
    }
    return { orders, world };
  }

  it("moves the shipped band on most steps, and the held band only for a new turn and a question", () => {
    const live = run("live");
    const held = run("held");
    expect(movesIn(live.orders)).toBeGreaterThanOrEqual(4);
    expect(movesIn(held.orders)).toBe(2);
    // Backlog scan's new turn lands under the question already asked…
    expect(held.orders[4]?.slice(0, 2)).toEqual(["chat:chat-a1", "chat:chat-a5"]);
    // …and Chat's new question tops them both, where it stays.
    expect(held.orders.at(-1)?.slice(0, 3)).toEqual([
      "chat:chat-a2",
      "chat:chat-a1",
      "chat:chat-a5",
    ]);
  });

  it("with questions held too, moves only for the new turn", () => {
    const held = run("held", "hold");
    expect(movesIn(held.orders)).toBe(1);
    expect(held.orders.at(-1)?.[0]).toBe("chat:chat-a5");
  });

  it("ends with two new unread results and the question still asked", () => {
    const { world } = run("held");
    expect(Object.keys(world.unread).toSorted()).toEqual([
      "chat-a3",
      "chat-a4",
      "chat-a5",
      "chat-p8",
    ]);
    expect(liveOf(world, "chat-a2")?.activity).toBe("waiting");
    expect(world.now - NOW).toBe(SCRIPT.reduce((total, step) => total + step.after, 0));
  });

  it("never finishes a turn in front of the person as unread", () => {
    const [, finished] = scriptEvents(
      { after: MINUTE, event: { kind: "turn-end", id: "chat-a2" }, note: "" },
      "chat-a2",
    );
    expect(finished).toEqual({ kind: "turn-complete", id: "chat-a2", inFront: true });
  });
});
