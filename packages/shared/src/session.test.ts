import { describe, it, expect } from "vite-plus/test";
import {
  createSessionRecord,
  isSessionActivityState,
  isSessionLaunchKind,
  isSessionPlacement,
  SESSION_ACTIVITY_STATES,
  SESSION_LAUNCH_KINDS,
  SESSION_PLACEMENTS,
} from "./session";
import type { SessionActivityState, SessionRecord } from "./session";

describe("SESSION_ACTIVITY_STATES", () => {
  it("lists working, idle, parked, exited in order", () => {
    expect(SESSION_ACTIVITY_STATES).toEqual(["working", "idle", "parked", "exited"]);
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
    };
    expect(record.ticketId).toBeNull();
  });

  it("accepts every SessionActivityState as a value", () => {
    const state: SessionActivityState = SESSION_ACTIVITY_STATES[0];
    expect(SESSION_ACTIVITY_STATES).toContain(state);
  });
});
