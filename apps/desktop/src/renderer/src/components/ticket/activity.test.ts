import { agentActor, type TicketComment, type TicketEvent } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { buildActivityFeed, commentAuthorLabel, describeEvent } from "./activity";

let nextId = 1;

/** A ticket event with a given payload; `createdAt` controls feed ordering. */
function event(payload: TicketEvent["payload"], createdAt = 0): TicketEvent {
  return { id: `e${nextId++}`, ticketId: "t1", actor: "user", createdAt, payload };
}

/** A minimal user comment for feed/merge tests. */
function comment(overrides: Partial<TicketComment> = {}): TicketComment {
  return {
    id: overrides.id ?? `c${nextId++}`,
    ticketId: overrides.ticketId ?? "t1",
    sessionId: overrides.sessionId ?? null,
    actor: overrides.actor ?? "user",
    body: overrides.body ?? "hi",
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
  };
}

describe("describeEvent", () => {
  it("phrases every property-change kind as a one-liner", () => {
    expect(describeEvent({ kind: "created", status: "backlog", title: "T" })).toBe(
      "created the ticket",
    );
    expect(describeEvent({ kind: "status_changed", from: "backlog", to: "doing" })).toBe(
      "moved Backlog → Doing",
    );
    expect(describeEvent({ kind: "priority_changed", from: "low", to: "high" })).toBe(
      "changed priority Low → High",
    );
    expect(describeEvent({ kind: "retitled", from: "Old", to: "New" })).toBe('renamed to "New"');
    expect(describeEvent({ kind: "body_edited" })).toBe("edited the description");
    expect(describeEvent({ kind: "archived" })).toBe("archived the ticket");
    expect(describeEvent({ kind: "unarchived" })).toBe("restored the ticket");
    expect(
      describeEvent({ kind: "session_started", sessionId: "s1", title: "fix", harnessId: "codex" }),
    ).toBe("started session fix");
    expect(describeEvent({ kind: "session_ended", sessionId: "s1" })).toBe("ended a session");
  });

  it("returns null for a commented event (rendered as its comment instead)", () => {
    expect(describeEvent({ kind: "commented", commentId: "c1" })).toBeNull();
  });

  it("summarises label changes in both directions", () => {
    expect(describeEvent({ kind: "labels_changed", added: ["auth", "api"], removed: [] })).toBe(
      "added auth, api",
    );
    expect(describeEvent({ kind: "labels_changed", added: [], removed: ["ui"] })).toBe(
      "removed ui",
    );
    expect(describeEvent({ kind: "labels_changed", added: ["auth"], removed: ["ui"] })).toBe(
      "added auth, removed ui",
    );
    expect(describeEvent({ kind: "labels_changed", added: [], removed: [] })).toBe(
      "updated labels",
    );
  });

  it("describes worktree changes, favouring the branch then base then path", () => {
    const base = { worktreePath: null, branch: null, baseBranch: null };
    expect(
      describeEvent({
        kind: "worktree_changed",
        from: base,
        to: { ...base, branch: "volli/VC-12-x" },
      }),
    ).toBe("set branch volli/VC-12-x");
    expect(
      describeEvent({
        kind: "worktree_changed",
        from: { ...base, branch: "volli/VC-12-x" },
        to: base,
      }),
    ).toBe("cleared branch");
    expect(
      describeEvent({ kind: "worktree_changed", from: base, to: { ...base, baseBranch: "main" } }),
    ).toBe("set base branch main");
    expect(
      describeEvent({
        kind: "worktree_changed",
        from: { ...base, baseBranch: "main" },
        to: base,
      }),
    ).toBe("cleared base branch");
    expect(
      describeEvent({ kind: "worktree_changed", from: base, to: { ...base, worktreePath: "/w" } }),
    ).toBe("set worktree /w");
    expect(
      describeEvent({
        kind: "worktree_changed",
        from: { ...base, worktreePath: "/w" },
        to: base,
      }),
    ).toBe("cleared worktree");
    expect(describeEvent({ kind: "worktree_changed", from: base, to: base })).toBe(
      "updated worktree",
    );
  });
});

describe("commentAuthorLabel", () => {
  it("maps the human, first-class harnesses, custom harnesses, and unknown actors", () => {
    expect(commentAuthorLabel("user")).toBe("You");
    expect(commentAuthorLabel(agentActor("claude-code"))).toBe("Claude Code");
    expect(commentAuthorLabel("agent:my-harness")).toBe("my-harness");
    expect(commentAuthorLabel("automation")).toBe("automation");
  });
});

describe("buildActivityFeed", () => {
  it("merges events and comments in chronological order", () => {
    const feed = buildActivityFeed(
      [event({ kind: "created", status: "backlog", title: "T" }, 100)],
      [comment({ id: "c1", createdAt: 50 }), comment({ id: "c2", createdAt: 200 })],
    );
    expect(feed.map((item) => ({ kind: item.kind, at: item.at, id: item.id }))).toEqual([
      { kind: "comment", at: 50, id: "c1" },
      { kind: "event", at: 100, id: feed[1]!.id },
      { kind: "comment", at: 200, id: "c2" },
    ]);
  });

  it("drops commented events (the comment renders instead)", () => {
    const feed = buildActivityFeed(
      [event({ kind: "commented", commentId: "c1" }, 10), event({ kind: "body_edited" }, 20)],
      [comment({ id: "c1", createdAt: 10 })],
    );
    expect(feed).toHaveLength(2);
    expect(feed.filter((item) => item.kind === "event")).toHaveLength(1);
    expect(
      feed.some((item) => item.kind === "event" && item.event.payload.kind === "commented"),
    ).toBe(false);
  });

  it("keeps input order (event before comment) on a timestamp tie", () => {
    const feed = buildActivityFeed(
      [event({ kind: "body_edited" }, 500)],
      [comment({ id: "c9", createdAt: 500 })],
    );
    expect(feed.map((item) => item.kind)).toEqual(["event", "comment"]);
  });

  it("returns an empty feed for no events or comments", () => {
    expect(buildActivityFeed([], [])).toEqual([]);
  });
});
