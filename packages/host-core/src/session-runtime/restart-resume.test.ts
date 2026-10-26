import { describe, expect, it, vi } from "vite-plus/test";
import type { SessionRuntimeCommandRequest } from "@volli/session-engine";
import {
  RECOVERED_TURN_INTERRUPTED_DETAIL,
  restartResumeCommandId,
  type SessionProjection,
} from "@volli/shared";

import {
  CLOUD_RECOVERY_CONNECT_WAIT_MS,
  resumeRecoveredTurns,
  type CloudRecoverySiblings,
  type RestartResumeCloud,
  type RestartResumePorts,
} from "./restart-resume";

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
    lastTurnOutcome: "interrupted",
    attention: {
      active: [
        {
          id: `${id}-warning`,
          kind: "partial_turn_interrupted",
          attachmentId: `${id}-attachment`,
          detail: RECOVERED_TURN_INTERRUPTED_DETAIL,
          diagnostic: null,
        },
      ],
      primary: null,
    },
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

  it("resumes nothing in a launch that shows Volli Cloud's board (VC-889)", async () => {
    const { port, sessions, commands } = ports({ cloudLaunch: () => true });
    sessions.set("a", projection("a"));
    await resumeRecoveredTurns(port, { turns: [turn("a")], lostAt: LOST_AT });
    expect(commands).toEqual([]);
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

function cloud(
  answer: CloudRecoverySiblings | Error = { siblings: [], complete: true },
  connected: boolean | Error = true,
) {
  const reads: Parameters<RestartResumeCloud["ticketSiblings"]>[0][] = [];
  const waits: Parameters<RestartResumeCloud["firstConnect"]>[0][] = [];
  const port: RestartResumeCloud = {
    firstConnect: async (options) => {
      waits.push(options);
      if (connected instanceof Error) throw connected;
      return connected;
    },
    ticketSiblings: async (input) => {
      reads.push(input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { port, reads, waits };
}

describe("resumeRecoveredTurns in a cloud store (N2-3)", () => {
  it("resumes its own turns once connected, even in a launch showing Volli Cloud", async () => {
    const remote = cloud({
      siblings: [
        { sessionId: "a", movedOn: true },
        { sessionId: "other", movedOn: false },
      ],
      complete: true,
    });
    const { port, sessions, commands } = ports({ cloudLaunch: () => true, cloud: remote.port });
    sessions.set("a", projection("a"));
    await resumeRecoveredTurns(port, { turns: [turn("a")], lostAt: LOST_AT });
    // The recovering Session's own row in the answer never supersedes it.
    expect(commands).toEqual([expect.objectContaining({ sessionId: "a" })]);
    expect(remote.reads).toEqual([
      { sessionId: "a", projectId: "project-1", ticketId: "ticket-1", since: LOST_AT },
    ]);
    // Bounded by default; a never-aborted signal stands in for no host close.
    expect(remote.waits).toEqual([
      { timeoutMs: CLOUD_RECOVERY_CONNECT_WAIT_MS, signal: expect.any(AbortSignal) },
    ]);
    expect(CLOUD_RECOVERY_CONNECT_WAIT_MS).toBe(30_000);
  });

  it("asks the backend about a ticketless Session too: its claim may have moved", async () => {
    const remote = cloud(new Error("fenced"));
    const { port, sessions, commands } = ports({ cloud: remote.port });
    sessions.set("b", projection("b", null));
    await resumeRecoveredTurns(port, { turns: [turn("b")], lostAt: LOST_AT });
    expect(remote.reads).toEqual([
      { sessionId: "b", projectId: "project-1", ticketId: null, since: LOST_AT },
    ]);
    expect(commands).toEqual([]);
  });

  it("leaves every turn for the person when the runner does not connect in time", async () => {
    const closing = new AbortController();
    const remote = cloud(undefined, false);
    const { port, sessions, commands } = ports({
      cloud: remote.port,
      closing: closing.signal,
      connectWaitMs: 5,
    });
    sessions.set("a", projection("a"));
    await resumeRecoveredTurns(port, { turns: [turn("a"), turn("b")], lostAt: LOST_AT });
    expect(remote.waits).toEqual([{ timeoutMs: 5, signal: closing.signal }]);
    expect(remote.reads).toEqual([]);
    expect(commands).toEqual([]);

    // A wait that fails reads as no connection; one a close ended, as a stop.
    const failing = cloud(undefined, new Error("link gone"));
    const second = ports({ cloud: failing.port });
    second.sessions.set("a", projection("a"));
    await resumeRecoveredTurns(second.port, { turns: [turn("a")], lostAt: LOST_AT });
    const stopped = ports({ cloud: cloud(undefined, false).port, shouldStop: () => true });
    stopped.sessions.set("a", projection("a"));
    await resumeRecoveredTurns(stopped.port, { turns: [turn("a")], lostAt: LOST_AT });
    expect([...second.commands, ...stopped.commands]).toEqual([]);
  });

  it("waits for nothing when nothing was recovered", async () => {
    const remote = cloud();
    const { port } = ports({ cloud: remote.port });
    await resumeRecoveredTurns(port, { turns: [], lostAt: LOST_AT });
    expect(remote.waits).toEqual([]);
  });

  it("a remote sibling that moved on supersedes the turn", async () => {
    const remote = cloud({ siblings: [{ sessionId: "remote", movedOn: true }], complete: true });
    const { port, sessions, commands } = ports({ cloud: remote.port });
    sessions.set("a", projection("a"));
    await resumeRecoveredTurns(port, { turns: [turn("a")], lostAt: LOST_AT });
    expect(remote.reads).toHaveLength(1);
    expect(commands).toEqual([]);
  });

  it("fails closed on an unreadable, unsettled or partial sibling answer", async () => {
    const answers: (CloudRecoverySiblings | Error)[] = [
      new Error("offline"),
      { siblings: [{ sessionId: "remote", movedOn: null }], complete: true },
      { siblings: [{ sessionId: "remote", movedOn: false }], complete: false },
    ];
    for (const answer of answers) {
      const { port, sessions, commands } = ports({ cloud: cloud(answer).port });
      sessions.set("a", projection("a"));
      await resumeRecoveredTurns(port, { turns: [turn("a")], lostAt: LOST_AT });
      expect(commands).toEqual([]);
    }
  });

  it("asks nothing of the backend for a turn the local verdict already leaves", async () => {
    const remote = cloud();
    const { port, sessions, commands } = ports({
      cloud: remote.port,
      resumeBoundary: () => "tool-in-flight",
    });
    sessions.set("a", projection("a"));
    await resumeRecoveredTurns(port, { turns: [turn("a")], lostAt: LOST_AT });
    expect(remote.reads).toEqual([]);
    expect(commands).toEqual([]);
  });

  it("never judges a Session outside the store's owner scope", async () => {
    const remote = cloud();
    const { port, sessions, commands } = ports({
      cloud: remote.port,
      ownsSession: (sessionId) => sessionId === "mine",
    });
    sessions.set("theirs", projection("theirs"));
    sessions.set("mine", projection("mine"));
    await resumeRecoveredTurns(port, { turns: [turn("theirs"), turn("mine")], lostAt: LOST_AT });
    expect(remote.reads.map(({ sessionId }) => sessionId)).toEqual(["mine"]);
    expect(commands).toEqual([expect.objectContaining({ sessionId: "mine" })]);
  });

  it("judges again after the backend read, and stops if the host closed meanwhile", async () => {
    // The person picked the Session up while the backend was read.
    const sessionsRef: { current?: Map<string, SessionProjection> } = {};
    const picked: RestartResumeCloud = {
      firstConnect: async () => true,
      ticketSiblings: async () => {
        sessionsRef.current!.set("a", projection("a", "ticket-1", { turnActive: true }));
        return { siblings: [], complete: true };
      },
    };
    const first = ports({ cloud: picked });
    sessionsRef.current = first.sessions;
    first.sessions.set("a", projection("a"));
    await resumeRecoveredTurns(first.port, { turns: [turn("a")], lostAt: LOST_AT });
    expect(first.commands).toEqual([]);

    let closing = false;
    const closedDuringRead: RestartResumeCloud = {
      firstConnect: async () => true,
      ticketSiblings: async () => {
        closing = true;
        return { siblings: [], complete: true };
      },
    };
    const second = ports({ cloud: closedDuringRead, shouldStop: () => closing });
    second.sessions.set("a", projection("a"));
    await resumeRecoveredTurns(second.port, { turns: [turn("a")], lostAt: LOST_AT });
    expect(second.commands).toEqual([]);
  });
});
