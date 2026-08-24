/**
 * The pure slice transitions, driven directly. The client suite exercises
 * them end-to-end through `createSurfaceStore`; these pin the guards each
 * transition owns — the identity-preserving no-ops, the turn-epoch rule, the
 * settle handback — one function at a time, where the next store to delegate
 * here can read them.
 */
import type { SessionPresentationProjection } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import type { ChatSessionSlice } from "./client";
import {
  applyProjection,
  dequeueSlice,
  enqueueSlice,
  foldStreamBatch,
  markAttaching,
  markDelivered,
  retitleSlice,
  seedSlice,
  settleSlice,
} from "./session-slice";
import { EMPTY_TRANSCRIPT, type ChatSessionFrame } from "./transcript";

const SESSION = { id: "durable-1", projectId: "p1", ticketId: null, title: "Plan", createdAt: 0 };

function projectionFor(attachmentId: string | null): SessionPresentationProjection {
  return {
    session: SESSION,
    status: "open",
    liveExecutor: attachmentId === null ? null : { id: attachmentId },
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    modelSelection: null,
    turnActive: false,
    lastActivityAt: SESSION.createdAt,
    bornTicketless: SESSION.ticketId === null,
  };
}

function turnFrame(sequence: number, kind: "turn.started" | "turn.completed"): ChatSessionFrame {
  return {
    sessionId: SESSION.id,
    sequence,
    event: { payload: { kind } } as never,
    transcript: null,
  };
}

describe("seedSlice", () => {
  it("starts undescribed and empty, at the lifecycle it was seeded with", () => {
    expect(seedSlice("starting")).toEqual({
      projection: null,
      transcript: EMPTY_TRANSCRIPT,
      lifecycle: "starting",
      sessionError: null,
      queue: [],
    });
    expect(seedSlice("ready").lifecycle).toBe("ready");
  });
});

describe("foldStreamBatch", () => {
  it("keeps its identity for a batch that folded to nothing", () => {
    const slice = seedSlice("ready");

    expect(foldStreamBatch(slice, [], [])).toBe(slice);
  });

  it("settles the lifecycle a folded turn boundary implies", () => {
    const slice = applyProjection(seedSlice("ready"), projectionFor("attach-1"));

    const working = foldStreamBatch(slice, [turnFrame(1, "turn.started")], [], [], false);
    expect(working.lifecycle).toBe("working");
    expect(working.transcript.turnActive).toBe(true);

    const done = foldStreamBatch(working, [turnFrame(2, "turn.completed")], []);
    expect(done.lifecycle).toBe("ready");
  });
});

describe("applyProjection", () => {
  it("replaces the projection and settles what the executor change implies", () => {
    const turning = foldStreamBatch(
      applyProjection(seedSlice("ready"), projectionFor("attach-1")),
      [turnFrame(1, "turn.started")],
      [],
    );
    expect(turning.lifecycle).toBe("working");

    // Losing the executor mid-turn is a change the settle rule must see.
    const lost = applyProjection(turning, projectionFor(null));

    expect(lost.projection?.liveExecutor).toBeNull();
    expect(lost.lifecycle).toBe("ready");
  });
});

describe("markAttaching", () => {
  it("latches starting and clears the error the attempt supersedes", () => {
    const slice = settleSlice(seedSlice("ready"), "broke");

    expect(markAttaching(slice)).toMatchObject({ lifecycle: "starting", sessionError: null });
  });
});

describe("markDelivered", () => {
  it("marks a delivered message working while the stream has said nothing since", () => {
    const slice = seedSlice("ready");

    expect(markDelivered(slice, slice.transcript.turnEpoch)).toMatchObject({
      lifecycle: "working",
      sessionError: null,
    });
  });

  it("does not re-open a turn the stream closed while the reply was in flight", () => {
    // Pi answers a submit when the turn it started has already ended, so the
    // reply routinely lands behind its own turn.completed. Latching on it left
    // the composer showing Stop and stranded every queued message behind a
    // turn that was over.
    const seeded = applyProjection(seedSlice("ready"), projectionFor("attach-1"));
    const epoch = seeded.transcript.turnEpoch;
    const closed = foldStreamBatch(
      seeded,
      [turnFrame(1, "turn.started"), turnFrame(2, "turn.completed")],
      [],
    );

    expect(markDelivered(closed, epoch).lifecycle).toBe("ready");
  });

  it("keeps working when the stream spoke and a turn is still live", () => {
    const seeded = applyProjection(seedSlice("ready"), projectionFor("attach-1"));
    const epoch = seeded.transcript.turnEpoch;
    const turning = foldStreamBatch(seeded, [turnFrame(1, "turn.started")], []);

    expect(markDelivered(turning, epoch).lifecycle).toBe("working");
  });
});

describe("settleSlice", () => {
  it("latches an error, and clearing settles onto what the stream already says", () => {
    const idle = seedSlice("ready");

    const latched = settleSlice(idle, "Lost the Session stream: socket hang up");
    expect(latched).toMatchObject({
      lifecycle: "error",
      sessionError: "Lost the Session stream: socket hang up",
    });

    expect(settleSlice(latched, null)).toMatchObject({ lifecycle: "ready", sessionError: null });
  });

  it("hands a cleared failure back to a turn that is still running", () => {
    const turning = foldStreamBatch(
      applyProjection(seedSlice("ready"), projectionFor("attach-1")),
      [turnFrame(1, "turn.started")],
      [],
    );

    const cleared = settleSlice(settleSlice(turning, "broke"), null);

    expect(cleared.lifecycle).toBe("working");
  });
});

describe("the queue transitions", () => {
  it("appends what was typed and keeps identity for blank text", () => {
    const slice = seedSlice("ready");

    const queued = enqueueSlice(slice, { id: "q1", text: " first " });
    expect(queued.queue).toEqual([{ id: "q1", text: "first" }]);

    expect(enqueueSlice(slice, { id: "q2", text: "   " })).toBe(slice);
  });

  it("removes one entry and keeps identity when it was never there", () => {
    const queued = enqueueSlice(seedSlice("ready"), { id: "q1", text: "first" });

    expect(dequeueSlice(queued, "q1").queue).toEqual([]);
    expect(dequeueSlice(queued, "q9")).toBe(queued);
  });
});

describe("retitleSlice", () => {
  it("moves the title the surface reads, ahead of the stream", () => {
    const described = applyProjection(seedSlice("ready"), projectionFor(null));

    const retitled = retitleSlice(described, "Parser");

    expect(retitled.projection?.session).toMatchObject({ id: SESSION.id, title: "Parser" });
  });

  it("keeps its identity for a Session the stream has not described", () => {
    // No projection is no title to correct — inventing one would put a Session
    // on screen that nothing has described yet.
    const slice: ChatSessionSlice = seedSlice("ready");

    expect(retitleSlice(slice, "Parser")).toBe(slice);
  });
});
