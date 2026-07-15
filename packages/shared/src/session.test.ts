import { describe, it, expect } from "vite-plus/test";
import { createSessionRecord, isSessionActivityState, SESSION_ACTIVITY_STATES } from "./session";
import type { SessionActivityState, SessionRecord } from "./session";

describe("SESSION_ACTIVITY_STATES", () => {
  it("lists working, idle, exited in order", () => {
    expect(SESSION_ACTIVITY_STATES).toEqual(["working", "idle", "exited"]);
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

describe("createSessionRecord", () => {
  it("uses the supplied id verbatim and stamps createdAt from now", () => {
    const session = createSessionRecord({
      id: "session-1",
      projectId: "proj-1",
      harnessId: "claude-code",
      title: "Fix the bug",
      cwd: "/Users/dev/project",
      now: 1000,
    });
    expect(session.id).toBe("session-1");
    expect(session.projectId).toBe("proj-1");
    expect(session.harnessId).toBe("claude-code");
    expect(session.title).toBe("Fix the bug");
    expect(session.cwd).toBe("/Users/dev/project");
    expect(session.createdAt).toBe(1000);
  });

  it("defaults ticketId to null (project-scoped scratch session)", () => {
    const session = createSessionRecord({
      id: "session-1",
      projectId: "proj-1",
      harnessId: "codex",
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
