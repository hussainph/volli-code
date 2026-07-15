import {
  agentActor,
  type TicketComment,
  type TicketEvent,
  type TicketEventKind,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  BUNCH_GAP_MS,
  buildActivityFeed,
  commentAuthorLabel,
  describeEvent,
  EVENT_KIND_PRIORITY,
  pickBunchLabel,
} from "./activity";

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

describe("EVENT_KIND_PRIORITY", () => {
  it("pins the label priority order (highest signal first, `commented` excluded)", () => {
    const expected: TicketEventKind[] = [
      "status_changed",
      "session_started",
      "session_ended",
      "created",
      "retitled",
      "priority_changed",
      "labels_changed",
      "worktree_changed",
      "archived",
      "unarchived",
      "body_edited",
    ];
    expect(EVENT_KIND_PRIORITY).toEqual(expected);
    expect(EVENT_KIND_PRIORITY).not.toContain("commented");
  });
});

describe("pickBunchLabel", () => {
  it("picks the highest-priority kind present in the bunch", () => {
    const edited = event({ kind: "body_edited" }, 10);
    const moved = event({ kind: "status_changed", from: "backlog", to: "doing" }, 20);
    const retagged = event({ kind: "labels_changed", added: ["api"], removed: [] }, 30);
    expect(pickBunchLabel([edited, moved, retagged]).id).toBe(moved.id);
    expect(pickBunchLabel([edited, retagged]).id).toBe(retagged.id);
    expect(pickBunchLabel([edited]).id).toBe(edited.id);
  });

  it("breaks a same-kind tie in favour of the latest occurrence", () => {
    const first = event({ kind: "status_changed", from: "backlog", to: "todo" }, 10);
    const second = event({ kind: "status_changed", from: "todo", to: "doing" }, 20);
    const edited = event({ kind: "body_edited" }, 30);
    expect(pickBunchLabel([first, second, edited]).id).toBe(second.id);
  });

  it("falls back to the latest event when no kind matches the priority list (defensive; unreachable for real bunches since `commented` is filtered before bunching)", () => {
    const first = event({ kind: "commented", commentId: "c1" }, 10);
    const second = event({ kind: "commented", commentId: "c2" }, 20);
    expect(pickBunchLabel([first, second]).id).toBe(second.id);
  });
});

describe("buildActivityFeed", () => {
  it("returns an empty feed for no events or comments", () => {
    expect(buildActivityFeed([], [])).toEqual([]);
  });

  it("bunches one burst of many events into a single row", () => {
    const created = event({ kind: "created", status: "backlog", title: "T" }, 10);
    const edit1 = event({ kind: "body_edited" }, 20);
    const edit2 = event({ kind: "retitled", from: "A", to: "B" }, 30);
    const moved = event({ kind: "status_changed", from: "backlog", to: "doing" }, 40);
    const tagged = event({ kind: "labels_changed", added: ["api"], removed: [] }, 50);
    const feed = buildActivityFeed([created, edit1, edit2, moved, tagged], []);
    expect(feed).toHaveLength(1);
    const bunch = feed[0]!;
    if (bunch.kind !== "bunch") throw new Error("expected a bunch");
    // +N count = the whole bunch; label = highest-priority kind; at = latest.
    expect(bunch.events.map((e) => e.id)).toEqual([
      created.id,
      edit1.id,
      edit2.id,
      moved.id,
      tagged.id,
    ]);
    expect(bunch.label.id).toBe(moved.id);
    expect(bunch.at).toBe(50);
  });

  it("breaks a bunch at a quiet gap of more than BUNCH_GAP_MS (not at exactly the gap)", () => {
    const a = event({ kind: "body_edited" }, 0);
    const b = event({ kind: "retitled", from: "A", to: "B" }, BUNCH_GAP_MS); // exactly the gap: stays
    const c = event({ kind: "priority_changed", from: "low", to: "high" }, BUNCH_GAP_MS * 2 + 1); // > gap: breaks
    const feed = buildActivityFeed([a, b, c], []);
    expect(feed.map((item) => item.kind)).toEqual(["bunch", "bunch"]);
    const [first, second] = feed;
    if (first?.kind !== "bunch" || second?.kind !== "bunch") throw new Error("expected bunches");
    expect(first.events.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(second.events.map((e) => e.id)).toEqual([c.id]);
  });

  it("breaks a bunch at a comment", () => {
    const before = event({ kind: "body_edited" }, 10);
    const after = event({ kind: "retitled", from: "A", to: "B" }, 30);
    const feed = buildActivityFeed([before, after], [comment({ id: "c1", createdAt: 20 })]);
    expect(feed.map((item) => ({ kind: item.kind, id: item.id }))).toEqual([
      { kind: "bunch", id: `bunch:${before.id}` },
      { kind: "comment", id: "c1" },
      { kind: "bunch", id: `bunch:${after.id}` },
    ]);
  });

  it("renders a single-event bunch with that event as its label", () => {
    const edit = event({ kind: "body_edited" }, 10);
    const feed = buildActivityFeed([edit], []);
    expect(feed).toHaveLength(1);
    const bunch = feed[0]!;
    if (bunch.kind !== "bunch") throw new Error("expected a bunch");
    expect(bunch.label.id).toBe(edit.id);
    expect(bunch.events).toHaveLength(1);
    expect(bunch.at).toBe(10);
  });

  it("labels a bunch with the LATEST occurrence of the highest-priority kind", () => {
    const move1 = event({ kind: "status_changed", from: "backlog", to: "todo" }, 10);
    const edit = event({ kind: "body_edited" }, 20);
    const move2 = event({ kind: "status_changed", from: "todo", to: "doing" }, 30);
    const feed = buildActivityFeed([move1, edit, move2], []);
    expect(feed).toHaveLength(1);
    const bunch = feed[0]!;
    if (bunch.kind !== "bunch") throw new Error("expected a bunch");
    expect(bunch.label.id).toBe(move2.id);
  });

  it("drops commented events (the comment renders instead)", () => {
    const edited = event({ kind: "body_edited" }, 20);
    const feed = buildActivityFeed(
      [event({ kind: "commented", commentId: "c1" }, 10), edited],
      [comment({ id: "c1", createdAt: 10 })],
    );
    expect(feed.map((item) => item.kind)).toEqual(["comment", "bunch"]);
    const bunch = feed[1]!;
    if (bunch.kind !== "bunch") throw new Error("expected a bunch");
    expect(bunch.events.map((e) => e.id)).toEqual([edited.id]);
  });

  it("keeps input order (event before comment) on a timestamp tie", () => {
    const feed = buildActivityFeed(
      [event({ kind: "status_changed", from: "backlog", to: "doing" }, 500)],
      [comment({ id: "c9", createdAt: 500 })],
    );
    expect(feed.map((item) => item.kind)).toEqual(["bunch", "comment"]);
  });

  it("merges bunches and comments in chronological order", () => {
    const created = event({ kind: "created", status: "backlog", title: "T" }, 100);
    const feed = buildActivityFeed(
      [created],
      [comment({ id: "c1", createdAt: 50 }), comment({ id: "c2", createdAt: 200 })],
    );
    expect(feed.map((item) => ({ kind: item.kind, at: item.at }))).toEqual([
      { kind: "comment", at: 50 },
      { kind: "bunch", at: 100 },
      { kind: "comment", at: 200 },
    ]);
  });
});
