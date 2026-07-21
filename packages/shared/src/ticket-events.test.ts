import { describe, expect, it } from "vite-plus/test";

import {
  MAX_WORKTREE_FAILURE_STDERR,
  TICKET_EVENT_KINDS,
  trimWorktreeFailureStderr,
} from "./ticket-events";
import type {
  TicketEvent,
  TicketEventKind,
  TicketEventPayload,
  WorktreeIdentity,
} from "./ticket-events";

describe("TICKET_EVENT_KINDS", () => {
  it("lists every event kind", () => {
    expect(TICKET_EVENT_KINDS).toEqual([
      "created",
      "status_changed",
      "priority_changed",
      "harness_changed",
      "retitled",
      "body_edited",
      "labels_changed",
      "archived",
      "unarchived",
      "commented",
      "session_started",
      "session_ended",
      "worktree_changed",
      "worktree_failed",
      "worktree_committed",
      "pr_opened",
      "pr_merged",
      "session_signal",
      "sessions_interrupted",
      "session_resumed",
    ]);
  });

  it("every member is assignable to TicketEventKind", () => {
    const kind: TicketEventKind = TICKET_EVENT_KINDS[0];
    expect(TICKET_EVENT_KINDS).toContain(kind);
  });
});

describe("TicketEventPayload", () => {
  it("has one payload shape per event kind, in TICKET_EVENT_KINDS order", () => {
    const worktreeA: WorktreeIdentity = { worktreePath: null, branch: null, baseBranch: null };
    const worktreeB: WorktreeIdentity = {
      worktreePath: "/repo/.worktrees/VC-12",
      branch: "volli/VC-12-mcp-server",
      baseBranch: "main",
    };
    const payloads: TicketEventPayload[] = [
      { kind: "created", status: "backlog", title: "T" },
      { kind: "status_changed", from: "backlog", to: "todo" },
      { kind: "priority_changed", from: "low", to: "high" },
      { kind: "harness_changed", from: "claude-code", to: "codex" },
      { kind: "retitled", from: "Old", to: "New" },
      { kind: "body_edited" },
      { kind: "labels_changed", added: ["bug"], removed: ["chore"] },
      { kind: "archived" },
      { kind: "unarchived" },
      { kind: "commented", commentId: "comment-1" },
      { kind: "session_started", sessionId: "session-1", title: "Fix bug", harnessId: "codex" },
      { kind: "session_ended", sessionId: "session-1" },
      { kind: "worktree_changed", from: worktreeA, to: worktreeB },
      { kind: "worktree_failed", stage: "copy", stderr: "fatal: could not copy" },
      { kind: "worktree_committed", message: "chore(VC-12): commit remaining work" },
      { kind: "pr_opened", url: "https://github.com/acme/repo/pull/7" },
      { kind: "pr_merged", url: "https://github.com/acme/repo/pull/7" },
      { kind: "session_signal", signal: "blocked", reason: "Waiting for credentials" },
      { kind: "sessions_interrupted", sessionIds: ["session-1", "session-2"] },
      { kind: "session_resumed", sessionId: "session-3", previousSessionId: "session-1" },
    ];
    expect(payloads.map((p) => p.kind)).toEqual(TICKET_EVENT_KINDS);
  });
});

describe("trimWorktreeFailureStderr", () => {
  it("passes short stderr through unchanged", () => {
    expect(trimWorktreeFailureStderr("fatal: boom")).toBe("fatal: boom");
  });

  it("keeps the trailing slice when stderr exceeds the cap (git's error is last)", () => {
    const noise = "x".repeat(MAX_WORKTREE_FAILURE_STDERR);
    const trimmed = trimWorktreeFailureStderr(`${noise}fatal: the real error`);
    expect(trimmed.length).toBe(MAX_WORKTREE_FAILURE_STDERR);
    expect(trimmed.endsWith("fatal: the real error")).toBe(true);
  });
});

describe("TicketEvent", () => {
  it("builds a well-formed event envelope", () => {
    const event: TicketEvent = {
      id: "evt-1",
      ticketId: "ticket-1",
      actor: "user",
      createdAt: 123,
      payload: { kind: "body_edited" },
    };
    expect(event.actor).toBe("user");
    expect(event.payload).toEqual({ kind: "body_edited" });
  });
});
