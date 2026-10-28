import { describe, expect, it, vi } from "vite-plus/test";

import type { NotificationRequest, SessionProjection } from "@volli/shared";

import { getAppState } from "../db/app-state-repo";
import { openTestDb } from "../db/test-helpers";
import type { SessionWakeListener } from "../session-control/session-wake";
import { CLOUD_RUN_ATTENTION_RETRY_MS, createCloudRunAttention } from "./automation-attention";

const OWNER = "owner-a";
const SESSION = "55555555-2222-4333-8444-555555555555";

function projection(state: "idle" | "waiting" | "error"): SessionProjection {
  return {
    session: { id: SESSION, projectId: "p", ticketId: "t", title: "Review" },
    stopped: null,
    interactions: { active: state === "waiting" ? [{ id: "question" }] : [] },
    attention: {
      active: state === "error" ? [{ id: "broken", kind: "configuration_invalid" }] : [],
      primary: state === "error" ? { id: "broken", kind: "configuration_invalid" } : null,
    },
  } as unknown as SessionProjection;
}

function harness(db = openTestDb()) {
  let state: "idle" | "waiting" | "error" = "idle";
  const listeners: SessionWakeListener[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const raised: { sessionId: string; args: Record<string, string> }[] = [];
  const local: NotificationRequest[] = [];
  let raiseFails = 0;
  const attention = createCloudRunAttention({
    db: db.db,
    ownerUserId: OWNER,
    engine: { getSession: async () => projection(state) },
    subscribe: (listener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    raise: async (sessionId, args) => {
      raised.push({ sessionId, args });
      if (raiseFails > 0) {
        raiseFails -= 1;
        throw new Error("not yet accepted");
      }
      return { displayName: "Dana" };
    },
    setTimer: (run, ms) => {
      const timer = { run, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
    newId: () => "notify-1",
  });
  attention.bindLocal((request) => void local.push(request));
  /** A committed write to the Session, then its coalesced fold. */
  async function write(next: typeof state, sessionId = SESSION) {
    state = next;
    for (const listener of listeners)
      listener({ event: { sessionId } } as Parameters<SessionWakeListener>[0]);
    for (const timer of timers.splice(0)) timer.run();
    await vi.waitFor(() => Promise.resolve());
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    db,
    attention,
    raised,
    local,
    timers,
    write,
    failRaises: (count: number) => {
      raiseFails = count;
    },
    listeners,
  };
}

describe("cloud run-attention", () => {
  it("raises Needs-you and a local alert when an unattended Run's Session starts waiting", async () => {
    const h = harness();
    h.attention.track({ sessionId: SESSION, attendance: "unattended", fresh: true });
    expect(getAppState(h.db.db, `volli:runner-automation-run:${OWNER}:${SESSION}`)).toBe(
      "unattended",
    );
    await h.write("idle");
    expect(h.raised).toEqual([]);
    await h.write("waiting");
    expect(h.raised).toEqual([
      {
        sessionId: SESSION,
        args: {
          notifyId: "notify-1",
          title: "An Automation is waiting on you",
          detail: "Review stopped to ask.",
        },
      },
    ]);
    expect(h.local).toMatchObject([{ producer: "run-attention", target: { sessionId: SESSION } }]);
    // The same need again is not a new edge.
    await h.write("waiting");
    expect(h.raised).toHaveLength(1);
  });

  it("never alerts for an attended Run or a Session no Run of this runner opened", async () => {
    const h = harness();
    h.attention.track({ sessionId: SESSION, attendance: "attended", fresh: true });
    await h.write("error");
    const other = "66666666-2222-4333-8444-555555555555";
    await h.write("error", other);
    expect(h.raised).toEqual([]);
    expect(h.local).toEqual([]);
  });

  it("remembers attendance across a relaunch, where a first sighting only seeds", async () => {
    const db = openTestDb();
    harness(db).attention.track({ sessionId: SESSION, attendance: "unattended", fresh: true });
    const relaunched = harness(db);
    await relaunched.write("waiting");
    expect(relaunched.raised).toEqual([]);
    await relaunched.write("idle");
    await relaunched.write("error");
    expect(relaunched.raised.map((raise) => raise.args.title)).toEqual(["An Automation stopped"]);
  });

  it("retries a raise the backend could not take yet, under the same notify id", async () => {
    const h = harness();
    h.attention.track({ sessionId: SESSION, attendance: "unattended", fresh: true });
    h.failRaises(CLOUD_RUN_ATTENTION_RETRY_MS.length + 1);
    await h.write("idle");
    await h.write("waiting");
    for (const delay of CLOUD_RUN_ATTENTION_RETRY_MS) {
      await vi.waitFor(() => expect(h.timers.map((timer) => timer.ms)).toEqual([delay]));
      h.timers.splice(0)[0]!.run();
    }
    await vi.waitFor(() => expect(h.raised).toHaveLength(CLOUD_RUN_ATTENTION_RETRY_MS.length + 1));
    expect(new Set(h.raised.map((raise) => raise.args.notifyId))).toEqual(new Set(["notify-1"]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.timers).toEqual([]);
  });

  it("stops folding and retrying once disposed", async () => {
    const h = harness();
    h.attention.track({ sessionId: SESSION, attendance: "unattended", fresh: true });
    h.attention.dispose();
    expect(h.listeners).toEqual([]);
    await h.write("waiting");
    expect(h.raised).toEqual([]);
  });
});
