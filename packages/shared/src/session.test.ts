import { describe, it, expect } from "vite-plus/test";
import {
  createSessionHarnessState,
  createSessionRecord,
  receiveHarnessEvent,
  HARNESS_EVENT_GRACE_MS,
  sessionHarnessStatus,
  isSessionActivityState,
  isSessionLaunchKind,
  isSessionPlacement,
  SESSION_ACTIVITY_STATES,
  SESSION_LAUNCH_KINDS,
  SESSION_PLACEMENTS,
  shortSessionId,
} from "./session";
import { parseHarnessId } from "./ticket";
import type { SessionActivityState, SessionHarnessState, SessionRecord } from "./session";

describe("SESSION_ACTIVITY_STATES", () => {
  it("lists working, waiting, idle, parked, exited in order", () => {
    expect(SESSION_ACTIVITY_STATES).toEqual(["working", "waiting", "idle", "parked", "exited"]);
  });
});

describe("shortSessionId", () => {
  it("keeps the stable first eight characters", () => {
    expect(shortSessionId("abcdef12-3456-7890")).toBe("abcdef12");
  });
});

describe("isSessionActivityState", () => {
  it("accepts every activity state", () => {
    for (const state of SESSION_ACTIVITY_STATES) {
      expect(isSessionActivityState(state)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isSessionActivityState("blocked")).toBe(false);
    expect(isSessionActivityState("")).toBe(false);
    expect(isSessionActivityState(42)).toBe(false);
    expect(isSessionActivityState(null)).toBe(false);
    expect(isSessionActivityState(undefined)).toBe(false);
  });
});

describe("durable session metadata vocabularies", () => {
  it("accepts the known launch kinds and rejects unknown values", () => {
    expect(SESSION_LAUNCH_KINDS).toEqual(["agent", "shell", "unknown"]);
    for (const kind of SESSION_LAUNCH_KINDS) expect(isSessionLaunchKind(kind)).toBe(true);
    expect(isSessionLaunchKind("claude-code")).toBe(false);
    expect(isSessionLaunchKind(null)).toBe(false);
  });

  it("accepts the known placements and rejects unknown values", () => {
    expect(SESSION_PLACEMENTS).toEqual(["tab", "split", "unknown"]);
    for (const placement of SESSION_PLACEMENTS) expect(isSessionPlacement(placement)).toBe(true);
    expect(isSessionPlacement("pane")).toBe(false);
    expect(isSessionPlacement(undefined)).toBe(false);
  });
});

describe("createSessionRecord", () => {
  it("uses the supplied id verbatim and stamps createdAt from now", () => {
    const session = createSessionRecord({
      id: "session-1",
      projectId: "proj-1",
      harnessId: "claude-code",
      launchKind: "agent",
      placement: "tab",
      title: "Fix the bug",
      cwd: "/Users/dev/project",
      now: 1000,
    });
    expect(session.id).toBe("session-1");
    expect(session.projectId).toBe("proj-1");
    expect(session.harnessId).toBe("claude-code");
    expect(session.launchKind).toBe("agent");
    expect(session.placement).toBe("tab");
    expect(session.title).toBe("Fix the bug");
    expect(session.cwd).toBe("/Users/dev/project");
    expect(session.createdAt).toBe(1000);
  });

  it("defaults ticketId to null (project-scoped scratch session)", () => {
    const session = createSessionRecord({
      id: "session-1",
      projectId: "proj-1",
      harnessId: "codex",
      launchKind: "shell",
      placement: "split",
      title: "Scratch",
      cwd: "/Users/dev/project",
      now: 0,
    });
    expect(session.ticketId).toBeNull();
  });

  it("honors an explicit ticketId", () => {
    const session = createSessionRecord({
      id: "session-1",
      projectId: "proj-1",
      ticketId: "ticket-1",
      harnessId: "opencode",
      launchKind: "agent",
      placement: "tab",
      title: "Work",
      cwd: "/Users/dev/project",
      now: 0,
    });
    expect(session.ticketId).toBe("ticket-1");
  });

  it("starts harnessSessionId and endedAt as null", () => {
    const session = createSessionRecord({
      id: "session-1",
      projectId: "proj-1",
      harnessId: "claude-code",
      launchKind: "unknown",
      placement: "unknown",
      title: "Work",
      cwd: "/Users/dev/project",
      now: 0,
    });
    expect(session.harnessSessionId).toBeNull();
    expect(session.endedAt).toBeNull();
    expect(session.exitCode).toBeNull();
  });
});

describe("SessionRecord", () => {
  it("builds a well-formed record shape", () => {
    const record: SessionRecord = {
      id: "session-1",
      projectId: "proj-1",
      ticketId: null,
      harnessId: "claude-code",
      launchKind: "unknown",
      placement: "unknown",
      harnessSessionId: null,
      title: "Scratch",
      cwd: "/Users/dev/project",
      createdAt: 0,
      endedAt: null,
      exitCode: null,
    };
    expect(record.ticketId).toBeNull();
  });

  it("accepts every SessionActivityState as a value", () => {
    const state: SessionActivityState = SESSION_ACTIVITY_STATES[0];
    expect(SESSION_ACTIVITY_STATES).toContain(state);
  });
});

/** A hooked claude-code-shaped session: reports input.needed, launched at t=1000. */
function hookedSession(): SessionHarnessState {
  return createSessionHarnessState({
    harnessId: "claude-code",
    expectedTier: "hooked",
    declaredEvents: ["session.started", "turn.started", "input.needed"],
    startedAt: 1000,
  });
}

describe("receiveHarnessEvent", () => {
  it("declares waiting when the harness reports a human is blocking the agent", () => {
    expect(receiveHarnessEvent(hookedSession(), "input.needed").declared).toBe("waiting");
  });

  it("returns a waiting session to PTY derivation once the agent moves again", () => {
    const waiting = receiveHarnessEvent(hookedSession(), "input.needed");
    expect(receiveHarnessEvent(waiting, "turn.started").declared).toBeNull();
  });

  it("leaves a waiting session waiting when only a subagent finished", () => {
    const waiting = receiveHarnessEvent(hookedSession(), "input.needed");
    expect(receiveHarnessEvent(waiting, "subagent.completed").declared).toBe("waiting");
  });

  it("refuses a blocking event from a harness that cannot report one, but records the delivery", () => {
    const cursor = createSessionHarnessState({
      harnessId: "cursor",
      expectedTier: "hooked",
      declaredEvents: ["session.started", "turn.started", "turn.completed"],
      startedAt: 1000,
    });
    const after = receiveHarnessEvent(cursor, "input.needed");
    expect(after.declared).toBeNull();
    expect(after.delivered).toBe(true);
  });
});

describe("sessionHarnessStatus", () => {
  it("is reporting once a hooked session has delivered its first event", () => {
    const started = receiveHarnessEvent(hookedSession(), "session.started");
    expect(sessionHarnessStatus(started, 2000)).toEqual({
      tier: "hooked",
      activitySource: "reported",
      input: "reported",
    });
  });

  it("drops a hooked launch to known once the grace window passes with nothing delivered", () => {
    const state = hookedSession();
    expect(sessionHarnessStatus(state, state.startedAt + HARNESS_EVENT_GRACE_MS + 1)).toEqual({
      tier: "known",
      activitySource: "silent",
      input: "unconfirmed",
    });
  });

  it("keeps a harness that never promised hooks at its own tier, inferring forever", () => {
    const declared = createSessionHarnessState({
      harnessId: parseHarnessId("my-harness")!,
      expectedTier: "declared",
      declaredEvents: [],
      startedAt: 1000,
    });
    expect(sessionHarnessStatus(declared, 1000 + HARNESS_EVENT_GRACE_MS + 1)).toEqual({
      tier: "declared",
      activitySource: "inferred",
      input: "unsupported",
    });
  });

  it("infers rather than claims while a hooked launch's grace window is still open", () => {
    const state = hookedSession();
    expect(sessionHarnessStatus(state, state.startedAt + HARNESS_EVENT_GRACE_MS)).toEqual({
      tier: "hooked",
      activitySource: "inferred",
      input: "unconfirmed",
    });
  });

  it("says a reporting cursor session still cannot tell you a human is blocking it", () => {
    const cursor = receiveHarnessEvent(
      createSessionHarnessState({
        harnessId: "cursor",
        expectedTier: "hooked",
        declaredEvents: ["session.started", "turn.started", "turn.completed"],
        startedAt: 1000,
      }),
      "session.started",
    );
    expect(sessionHarnessStatus(cursor, 2000)).toEqual({
      tier: "hooked",
      activitySource: "reported",
      input: "unsupported",
    });
  });
});
