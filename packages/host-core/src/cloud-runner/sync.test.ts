import { describe, expect, it, vi } from "vite-plus/test";

import type { SessionEvent } from "@volli/shared";

import { createBackendLink, type BackendConnection, type LinkStatus } from "./backend-link";
import { createFactDrain, type DrainCursor } from "./drain";
import { createMutationGate } from "./flow";
import { createInboxWorker, type JobJournalEntry } from "./inbox";
import {
  acceptOverLink,
  inboxOverLink,
  RUNNER_SYNC_FUNCTIONS,
  startRunnerSync,
  wakeOverLink,
} from "./sync";

describe("the runner's cloud sync", () => {
  it("calls the backend's runner functions by name, at the priority given", async () => {
    const mutate = vi.fn(
      async (_n: string, _a: Record<string, unknown>, _o?: object) =>
        ({ acceptedThrough: 1 }) as unknown,
    );
    const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => [] as unknown);
    await acceptOverLink({ mutate })(
      { sessionId: "s", generation: 1, events: ["{}"] },
      { priority: "live", bytes: 2 },
    );
    expect(mutate).toHaveBeenCalledWith(
      "sessions:accept",
      { sessionId: "s", generation: 1, events: ["{}"] },
      { priority: "live", bytes: 2 },
    );
    const inbox = inboxOverLink({ call });
    await inbox.claim({ bootId: "b", max: 1 });
    await inbox.renew({ jobId: "j", bootId: "b", attempt: 1 });
    await inbox.complete({
      jobId: "j",
      bootId: "b",
      attempt: 1,
      outcome: { status: "done", result: null },
    });
    const subscribe = vi.fn(
      (_name: string, _args: Record<string, unknown>, listener: (value: unknown) => void) => {
        listener({ ready: 2, nextAvailableAt: null });
        return () => {};
      },
    );
    const wakes: unknown[] = [];
    wakeOverLink({ subscribe })((wake) => wakes.push(wake));
    expect(subscribe).toHaveBeenCalledWith("runnerJobs:wake", {}, expect.any(Function));
    expect(wakes).toEqual([{ ready: 2, nextAvailableAt: null }]);
    expect(call.mock.calls.map(([name]) => name)).toEqual([
      RUNNER_SYNC_FUNCTIONS.claim,
      RUNNER_SYNC_FUNCTIONS.renew,
      RUNNER_SYNC_FUNCTIONS.complete,
    ]);
  });

  it("starts everything, catches up on every reconnect (renew before claim), and stops in order", async () => {
    const order: string[] = [];
    let listener!: (status: LinkStatus) => void;
    const off = vi.fn();
    const sync = startRunnerSync({
      link: {
        onStatus: (next) => {
          listener = next;
          return off;
        },
        close: async () => void order.push("link.close"),
      },
      drain: {
        start: () => order.push("drain.start"),
        stop: () => order.push("drain.stop"),
        resumeAll: () => order.push("drain.resumeAll"),
      } as never,
      inbox: {
        start: async () => void order.push("inbox.start"),
        stop: () => order.push("inbox.stop"),
        renewInFlight: async () => void order.push("inbox.renew"),
        claimNow: async () => void order.push("inbox.claim"),
      } as never,
      presence: {
        start: async () => void order.push("presence.start"),
        stop: async () => void order.push("presence.stop"),
      } as never,
    });
    expect(order).toEqual(["drain.start", "inbox.start", "presence.start"]);
    order.length = 0;
    listener({ state: "connecting" });
    listener({ state: "connected" });
    await new Promise((done) => setTimeout(done, 0));
    expect(order).toEqual(["drain.resumeAll", "inbox.renew", "inbox.claim"]);
    order.length = 0;
    await sync.stop();
    expect(off).toHaveBeenCalled();
    expect(order).toEqual(["presence.stop", "inbox.stop", "drain.stop", "link.close"]);
  });
});

describe("the composed sync over one gate", () => {
  it("drains big facts and a backlog and reports jobs through one link without deadlocking", async () => {
    const heads = new Map<string, number>();
    const completes: string[] = [];
    const connection: BackendConnection = {
      onUpdate: () => () => {},
      isConnected: () => true,
      onConnectionChange: () => () => {},
      close: async () => {},
      mutation: async (name, args) => {
        await new Promise((done) => setTimeout(done, 0));
        if (name === RUNNER_SYNC_FUNCTIONS.accept) {
          const { sessionId, events } = args as { sessionId: string; events: string[] };
          let head = heads.get(sessionId) ?? 0;
          for (const text of events) {
            const { sequence } = JSON.parse(text) as { sequence: number };
            if (sequence !== head + 1)
              throw Object.assign(new Error("ooo"), {
                data: { code: "out_of_order", acceptedThrough: head },
              });
            head = sequence;
          }
          heads.set(sessionId, head);
          return { acceptedThrough: head, duplicates: 0, quarantined: 0 };
        }
        if (name === RUNNER_SYNC_FUNCTIONS.claim) return [];
        if (name === RUNNER_SYNC_FUNCTIONS.complete) {
          completes.push((args as { jobId: string }).jobId);
          return { ack: "recorded", status: "done" };
        }
        return null;
      },
    };
    const link = createBackendLink({
      connect: () => connection,
      token: async () => "jwt",
      gate: createMutationGate(),
    });
    const events = new Map<string, SessionEvent[]>();
    const add = (sessionId: string, count: number, size: number) => {
      const list = events.get(sessionId) ?? [];
      for (let n = 0; n < count; n += 1) {
        list.push({
          id: `${sessionId}:${list.length + 1}`,
          sessionId,
          sequence: list.length + 1,
          occurredAt: 0,
          recordedAt: 0,
          provenance: { kind: "test" },
          payload: { kind: "note", text: "x".repeat(size) },
        } as unknown as SessionEvent);
      }
      events.set(sessionId, list);
    };
    const rows = new Map<string, DrainCursor>();
    const drain = createFactDrain({
      ledger: {
        listEvents: ({ sessionId, afterSequence, limit }) =>
          (events.get(sessionId) ?? []).filter((e) => e.sequence > afterSequence).slice(0, limit),
        latestEventSequence: (sessionId) => events.get(sessionId)?.length ?? 0,
      },
      cursors: {
        list: () => [...rows.values()],
        get: (id) => rows.get(id) ?? null,
        save: (c) => void rows.set(c.sessionId, c),
      },
      accept: acceptOverLink(link),
      ownerUserId: "u",
    });
    const journal = new Map<string, JobJournalEntry>([
      [
        "j1",
        {
          jobId: "j1",
          kind: "k",
          lease: { bootId: "b", attempt: 1 },
          state: "done",
          outcome: { status: "done", result: null },
          receivedAt: 0,
        },
      ],
    ]);
    const inbox = createInboxWorker({
      backend: inboxOverLink(link),
      journal: {
        get: (id) => journal.get(id) ?? null,
        save: (e) => void journal.set(e.jobId, e),
        unreported: () => [...journal.values()],
        remove: (id) => void journal.delete(id),
      },
      bootId: "00000000-0000-4000-8000-000000000002",
    });
    const sync = startRunnerSync({
      link,
      drain,
      inbox,
      presence: { start: async () => {}, stop: async () => {} } as never,
    });
    // A single 130 KB fact, three Sessions of backlog, and live facts, all at once.
    add("big", 1, 130 * 1024);
    for (const sessionId of ["a", "b", "c"]) add(sessionId, 120, 900);
    for (const sessionId of ["big", "a", "b", "c"]) drain.adopt(sessionId);
    await drain.idle();
    for (let n = 0; n < 20 && journal.size > 0; n += 1)
      await new Promise((done) => setTimeout(done, 1));
    expect(heads.get("big")).toBe(1);
    for (const sessionId of ["a", "b", "c"]) expect(heads.get(sessionId)).toBe(120);
    expect(completes).toEqual(["j1"]);
    await sync.stop();
  });
});
