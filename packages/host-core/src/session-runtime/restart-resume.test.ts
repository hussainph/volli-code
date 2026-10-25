import { describe, expect, it, vi } from "vite-plus/test";
import type { SessionRuntimeCommandRequest } from "@volli/session-engine";
import { restartResumeCommandId, type SessionProjection } from "@volli/shared";

import { resumeRecoveredTurns, type RestartResumePorts } from "./restart-resume";

const LOST_AT = 1_000;

function projection(
  id: string,
  ticketId: string | null = "ticket-1",
  overrides: Partial<SessionProjection> = {},
): SessionProjection {
  return {
    session: {
      id,
      projectId: "project-1",
      ticketId,
      role: "ticket",
      parentSessionId: null,
      title: null,
      createdAt: 0,
    },
    status: "open",
    stopped: null,
    liveExecutor: { id: `${id}-attachment` },
    turnActive: false,
    latestTurnId: "turn-1",
    latestTurnOrigin: { kind: "user" },
    lastTurnOutcome: "interrupted",
    commands: [],
    receipts: [],
    ...overrides,
  } as unknown as SessionProjection;
}

function ports(overrides: Partial<RestartResumePorts> = {}) {
  const sessions = new Map<string, SessionProjection>();
  const commands: SessionRuntimeCommandRequest[] = [];
  const port: RestartResumePorts = {
    projection: async (sessionId) => {
      const found = sessions.get(sessionId);
      if (found === undefined) throw new Error(`no ${sessionId}`);
      return found;
    },
    ticketSessions: async () => [...sessions.values()],
    resumeBoundary: () => "settled",
    pendingTurnStarts: () => new Set(),
    command: async (request) => {
      commands.push(request);
      return { receipt: { status: "accepted" } } as unknown as Awaited<
        ReturnType<RestartResumePorts["command"]>
      >;
    },
    shouldStop: () => false,
    now: () => LOST_AT + 10,
    ...overrides,
  };
  return { port, sessions, commands };
}

const turn = (sessionId: string) => ({ sessionId, attachmentId: `${sessionId}-attachment` });

describe("resumeRecoveredTurns (VC-450)", () => {
  it("resumes what the verdict allows through the retry door, as a recovery", async () => {
    const { port, sessions, commands } = ports();
    sessions.set("a", projection("a"));
    sessions.set("b", projection("b", null));
    await resumeRecoveredTurns(port, { turns: [turn("a"), turn("b")], lostAt: LOST_AT });
    // Judged side by side, so in no promised order.
    expect(commands).toHaveLength(2);
    expect(commands).toContainEqual({
      origin: { kind: "volli", reason: "relaunch-recovery" },
      commandId: restartResumeCommandId("a-attachment", "turn-1"),
      sessionId: "a",
      command: { kind: "executor.retry", attachmentId: "a-attachment" },
    });
    expect(commands).toContainEqual(expect.objectContaining({ sessionId: "b" }));
  });

  it("leaves a skipped turn, and every turn when the moment of loss is unknown", async () => {
    const { port, sessions, commands } = ports({ resumeBoundary: () => "tool-in-flight" });
    sessions.set("a", projection("a"));
    await resumeRecoveredTurns(port, { turns: [turn("a")], lostAt: LOST_AT });
    const unknown = ports();
    unknown.sessions.set("a", projection("a"));
    await resumeRecoveredTurns(unknown.port, { turns: [turn("a")], lostAt: null });
    expect([...commands, ...unknown.commands]).toEqual([]);
  });

  it("judges each Session on its own, and outlives a refused or failed resume", async () => {
    let calls = 0;
    const { port, sessions } = ports({
      command: async () => {
        calls += 1;
        if (calls === 1) throw new Error("executor gone");
        return {
          receipt: { status: "rejected", code: "restart_resume_stale", detail: "moved" },
        } as never;
      },
    });
    sessions.set("b", projection("b"));
    sessions.set("c", projection("c"));
    await expect(
      resumeRecoveredTurns(port, {
        // "missing" cannot be read at all.
        turns: [turn("missing"), turn("b"), turn("c")],
        lostAt: LOST_AT,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("runs a few resumes at a time, judging each only when a slot frees", async () => {
    const gates = new Map<string, PromiseWithResolvers<never>>();
    const started: string[] = [];
    const { port, sessions } = ports({
      command: (request) => {
        const sessionId = (request as { sessionId: string }).sessionId;
        started.push(sessionId);
        const gate = Promise.withResolvers<never>();
        gates.set(sessionId, gate);
        return gate.promise;
      },
    });
    for (const id of ["a", "b", "c"]) sessions.set(id, projection(id));
    const all = resumeRecoveredTurns(port, {
      turns: [turn("a"), turn("b"), turn("c")],
      lostAt: LOST_AT,
    });
    await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
    // The person picked "c" up while it waited for a slot.
    sessions.set("c", projection("c", "ticket-1", { turnActive: true }));
    gates.get("a")!.resolve({ receipt: { status: "accepted" } } as never);
    await vi.waitFor(() => expect(gates.size).toBe(2));
    gates.get("b")!.resolve({ receipt: { status: "accepted" } } as never);
    await all;
    expect(started).toEqual(["a", "b"]);
  });

  it("starts nothing once the host is closing, and treats the run it ends as a stop", async () => {
    let closing = false;
    const ended = Promise.withResolvers<never>();
    const command = vi.fn(() => ended.promise);
    const { port, sessions } = ports({ shouldStop: () => closing, command });
    sessions.set("a", projection("a"));
    sessions.set("b", projection("b"));
    const all = resumeRecoveredTurns(port, { turns: [turn("a")], lostAt: LOST_AT });
    await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
    closing = true;
    ended.reject(new Error("runtime closed"));
    await expect(all).resolves.toBeUndefined();

    await resumeRecoveredTurns(port, { turns: [turn("b")], lostAt: LOST_AT });
    expect(command).toHaveBeenCalledOnce();

    // Closing between the verdict and the act.
    let reads = 0;
    const between = ports({
      shouldStop: () => reads > 0,
      projection: async (sessionId) => {
        reads += 1;
        return projection(sessionId);
      },
    });
    await resumeRecoveredTurns(between.port, { turns: [turn("a")], lostAt: LOST_AT });
    expect(between.commands).toEqual([]);
  });

  it("defaults to the wall clock", async () => {
    const { port, sessions, commands } = ports();
    delete port.now;
    sessions.set("a", projection("a"));
    // Lost far in the past by the real clock: too old to continue unasked.
    await resumeRecoveredTurns(port, { turns: [turn("a")], lostAt: LOST_AT });
    expect(commands).toEqual([]);
  });
});
