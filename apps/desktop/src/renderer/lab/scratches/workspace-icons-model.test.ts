import { describe, expect, it } from "vite-plus/test";

import {
  readWorkspaceSession,
  visibleWorkspaceSessions,
  workspaceFixtures,
  workspaceSummary,
  workspaceSummaryLabel,
  type WorkspaceFixture,
  type WorkspaceSession,
} from "./workspace-icons-model";

function fixture(sessions: WorkspaceSession[]): WorkspaceFixture {
  return { id: "test", name: "Test", colorIndex: 0, canvas: null, appearance: null, sessions };
}

function session(state: WorkspaceSession["state"], unread = false): WorkspaceSession {
  return { id: state, title: state, scope: "Home", state, unread };
}

describe("workspace icon prototype semantics", () => {
  it("keeps unread orthogonal to activity, including stopped conversations", () => {
    for (const state of [
      "working",
      "setup",
      "waiting",
      "interrupted",
      "idle",
      "stopped",
    ] as const) {
      expect(workspaceSummary(fixture([session(state, true)])).unread).toBe(1);
      expect(workspaceSummary(fixture([session(state)])).unread).toBe(0);
    }
  });

  it("follows the roster's input, recovery, active order without dropping other counts", () => {
    const workspace = fixture([
      session("interrupted", true),
      session("waiting"),
      session("working"),
      session("setup"),
    ]);
    expect(workspaceSummary(workspace)).toEqual({
      recovery: 1,
      waiting: 1,
      working: 2,
      unread: 1,
      signal: "waiting",
    });
    expect(workspaceSummaryLabel(workspace)).toBe(
      "1 needs input · 1 needs recovery · 2 active · 1 unread",
    );
    expect(workspaceSummary(fixture([session("interrupted"), session("working")])).signal).toBe(
      "interrupted",
    );
    expect(workspaceSummary(fixture([session("waiting"), session("working")])).signal).toBe(
      "waiting",
    );
    expect(workspaceSummary(fixture([session("setup")])).signal).toBe("working");
  });

  it("does not light idle, stopped, or empty workspaces", () => {
    for (const sessions of [[], [session("idle")], [session("stopped")]]) {
      const workspace = fixture(sessions);
      expect(workspaceSummary(workspace).signal).toBeNull();
      expect(workspaceSummaryLabel(workspace)).toBe("No activity or unread sessions");
    }
  });

  it("does not count a helper as a second visible Session or direct input target", () => {
    const parent = session("working");
    const workspace = fixture([parent, { ...session("waiting", true), role: "subagent" }]);
    expect(visibleWorkspaceSessions(workspace)).toEqual([parent]);
    expect(workspaceSummary(workspace)).toEqual({
      recovery: 0,
      waiting: 0,
      working: 1,
      unread: 0,
      signal: "working",
    });
  });

  it("reads only the opened conversation without clearing its input state or mutating fixtures", () => {
    const workspaces = workspaceFixtures("mixed");
    const updated = readWorkspaceSession(workspaces, "volli", "v2");
    expect(workspaceSummary(updated[0]!)).toEqual({
      recovery: 0,
      waiting: 1,
      working: 1,
      unread: 1,
      signal: "waiting",
    });
    expect(workspaceSummary(workspaces[0]!).unread).toBe(2);
    expect(updated[1]).toBe(workspaces[1]);
    expect(readWorkspaceSession(workspaces, "missing", "v2")).toEqual(workspaces);
    expect(readWorkspaceSession(workspaces, "volli", "missing")).toEqual(workspaces);
  });

  it("offers independent resettable quiet, busy, and collision scenarios", () => {
    expect(
      workspaceFixtures("quiet").every((workspace) => workspaceSummary(workspace).signal === null),
    ).toBe(true);
    const busy = workspaceFixtures("busy");
    expect(workspaceSummary(busy[0]!).signal).toBe("working");
    expect(workspaceSummary(busy[0]!).unread).toBe(0);
    expect(workspaceSummary(busy[4]!).signal).toBeNull();
    const collision = workspaceFixtures("collision");
    expect(workspaceSummary(collision[0]!).signal).toBe("waiting");
    expect(workspaceSummary(collision[0]!).unread).toBe(3);
    expect(workspaceFixtures("mixed")[0]!.sessions[0]!.state).toBe("working");
  });
});
