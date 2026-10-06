/** The board's Workspace change feed (VC-565, F1): stamp, resume or resnapshot, the bus tap. */
import { isFeedResnapshotRequired, type BoardChange } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_FEED_RETENTION,
  BoardChangeFeed,
  createBoardChangeFeed,
  type BoardFeedBatch,
} from "./change-feed";

const ticketChange = (id: string, projectId = "p", title = id): BoardChange => ({
  kind: "ticket",
  op: "upsert",
  id,
  projectId,
  ticket: { id, title } as never,
});

function capture(feed: BoardChangeFeed, workspaceId: string, after: string | null = null) {
  const batches: BoardFeedBatch[] = [];
  const unsubscribe = feed.subscribe(workspaceId, after, (batch) => batches.push(batch));
  return { batches, unsubscribe };
}

function resnapshot(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(isFeedResnapshotRequired(thrown)).toBe(true);
}

const seqOf = (cursor: string): number => Number(cursor.split(":")[2]);

describe("stamp and cursor", () => {
  it("starts at seq 0 in epoch 0 and rises by one per stamped change", () => {
    const feed = createBoardChangeFeed();
    const start = feed.cursor("p");
    expect(start).toMatch(/^0:[0-9a-f-]{36}:0$/);
    // The same Workspace answers the same instance until it stamps.
    expect(feed.cursor("p")).toBe(start);
    feed.stamp("p", [ticketChange("a"), ticketChange("b")]);
    expect(seqOf(feed.cursor("p"))).toBe(2);
    feed.stamp("p", [ticketChange("a")]);
    expect(seqOf(feed.cursor("p"))).toBe(3);
    expect(feed.cursor("p").split(":")[1]).toBe(start.split(":")[1]);
  });

  it("keeps one feed per Workspace, each with its own instance and seq", () => {
    const feed = createBoardChangeFeed();
    feed.stamp("p", [ticketChange("a")]);
    expect(seqOf(feed.cursor("q"))).toBe(0);
    expect(feed.cursor("q").split(":")[1]).not.toBe(feed.cursor("p").split(":")[1]);
  });

  it("delivers a stamp to every subscriber at once, naming the cursor it reaches", () => {
    const feed = createBoardChangeFeed();
    const one = capture(feed, "p");
    const two = capture(feed, "p");
    const other = capture(feed, "q");
    const changes = [ticketChange("a"), ticketChange("b")];
    feed.stamp("p", changes);
    const expected = [{ cursor: feed.cursor("p"), changes }];
    expect(one.batches).toEqual(expected);
    expect(two.batches).toEqual(expected);
    expect(other.batches).toEqual([]);
  });

  it("stamps nothing, and moves no cursor, for an empty change list", () => {
    const feed = createBoardChangeFeed();
    const { batches } = capture(feed, "p");
    const before = feed.cursor("p");
    feed.stamp("p", []);
    expect(feed.cursor("p")).toBe(before);
    expect(batches).toEqual([]);
  });

  it("stops delivering to a listener that unsubscribed", () => {
    const feed = createBoardChangeFeed();
    const { batches, unsubscribe } = capture(feed, "p");
    feed.stamp("p", [ticketChange("a")]);
    unsubscribe();
    feed.stamp("p", [ticketChange("b")]);
    expect(batches).toHaveLength(1);
  });

  it("lets a listener unsubscribe while a batch is being delivered", () => {
    const feed = createBoardChangeFeed();
    const seen: string[] = [];
    const first: { unsubscribe?: () => void } = {};
    first.unsubscribe = feed.subscribe("p", null, () => {
      seen.push("first");
      first.unsubscribe?.();
    });
    feed.subscribe("p", null, () => seen.push("second"));
    feed.stamp("p", [ticketChange("a")]);
    feed.stamp("p", [ticketChange("b")]);
    expect(seen).toEqual(["first", "second", "second"]);
  });
});

describe("subscribe: resume or resnapshot", () => {
  it("with no cursor, delivers live changes only", () => {
    const feed = createBoardChangeFeed();
    feed.stamp("p", [ticketChange("a")]);
    const { batches } = capture(feed, "p", null);
    expect(batches).toEqual([]);
    feed.stamp("p", [ticketChange("b")]);
    expect(batches.map((batch) => batch.changes.map((change) => change.id))).toEqual([["b"]]);
  });

  it("replays the latest change per entity after a cursor, in one batch, then goes live", () => {
    const feed = createBoardChangeFeed();
    feed.stamp("p", [ticketChange("before")]);
    const cursor = feed.cursor("p");
    feed.stamp("p", [ticketChange("a", "p", "first"), ticketChange("b")]);
    feed.stamp("p", [ticketChange("a", "p", "second")]);
    feed.stamp("p", [{ kind: "ticket", op: "delete", id: "b", projectId: "p" }]);

    const { batches } = capture(feed, "p", cursor);
    expect(batches).toEqual([
      {
        cursor: feed.cursor("p"),
        changes: [
          // Compacted: each entity once, at its latest stamp, tombstones included.
          ticketChange("a", "p", "second"),
          { kind: "ticket", op: "delete", id: "b", projectId: "p" },
        ],
      },
    ]);

    feed.stamp("p", [ticketChange("c")]);
    expect(batches).toHaveLength(2);
    expect(batches[1]!.changes).toEqual([ticketChange("c")]);
  });

  it("keys compaction by kind and id, so a ticket and its history are separate entities", () => {
    const feed = createBoardChangeFeed();
    const cursor = feed.cursor("p");
    const event: BoardChange = {
      kind: "ticketEvent",
      op: "upsert",
      id: "a",
      projectId: "p",
      ticketId: "a",
    };
    feed.stamp("p", [ticketChange("a"), event]);
    expect(capture(feed, "p", cursor).batches[0]!.changes).toEqual([ticketChange("a"), event]);
  });

  it("replays nothing for the current cursor, and still goes live", () => {
    const feed = createBoardChangeFeed();
    feed.stamp("p", [ticketChange("a")]);
    const { batches } = capture(feed, "p", feed.cursor("p"));
    expect(batches).toEqual([]);
    feed.stamp("p", [ticketChange("b")]);
    expect(batches).toHaveLength(1);
  });

  it("resumes from the floor itself: the oldest seq still answered for", () => {
    const feed = createBoardChangeFeed({ retention: 2 });
    feed.stamp("p", [ticketChange("a"), ticketChange("b"), ticketChange("c")]);
    // "a" (seq 1) was compacted away: the window answers for everything after seq 1.
    const atFloor = `0:${feed.cursor("p").split(":")[1]}:1`;
    expect(capture(feed, "p", atFloor).batches[0]!.changes.map((change) => change.id)).toEqual([
      "b",
      "c",
    ]);
  });

  it("refuses a cursor compacted past", () => {
    const feed = createBoardChangeFeed({ retention: 2 });
    const cursor = feed.cursor("p");
    feed.stamp("p", [ticketChange("a"), ticketChange("b"), ticketChange("c")]);
    resnapshot(() => feed.subscribe("p", cursor, () => {}));
  });

  it("refuses a cursor from another feed instance, even of the same Workspace", () => {
    const old = createBoardChangeFeed();
    const cursor = old.cursor("p");
    const restarted = createBoardChangeFeed();
    resnapshot(() => restarted.subscribe("p", cursor, () => {}));
  });

  it("refuses a cursor from another Workspace", () => {
    const feed = createBoardChangeFeed();
    resnapshot(() => feed.subscribe("p", feed.cursor("q"), () => {}));
  });

  it("refuses a cursor from another epoch", () => {
    const feed = createBoardChangeFeed({ epochOf: (workspaceId) => (workspaceId === "p" ? 3 : 0) });
    const cursor = feed.cursor("p");
    expect(cursor.startsWith("3:")).toBe(true);
    const instance = cursor.split(":")[1];
    resnapshot(() => feed.subscribe("p", `2:${instance}:0`, () => {}));
    expect(capture(feed, "p", cursor).batches).toEqual([]);
  });

  it("refuses a cursor from the future, and every malformed one", () => {
    const feed = createBoardChangeFeed();
    feed.stamp("p", [ticketChange("a")]);
    const [epoch, instance] = feed.cursor("p").split(":");
    for (const cursor of [
      `${epoch}:${instance}:2`,
      `${epoch}:${instance}:-1`,
      `${epoch}:${instance}:0.5`,
      `${epoch}:${instance}:x`,
      `${epoch}:${instance}:1:extra`,
      `${epoch}:${instance}`,
      "",
      "garbage",
    ]) {
      resnapshot(() => feed.subscribe("p", cursor, () => {}));
    }
  });

  it("retains BOARD_FEED_RETENTION entities by default", () => {
    const feed = new BoardChangeFeed();
    const cursor = feed.cursor("p");
    feed.stamp(
      "p",
      Array.from({ length: BOARD_FEED_RETENTION }, (_, index) => ticketChange(`t${index}`)),
    );
    expect(capture(feed, "p", cursor).batches[0]!.changes).toHaveLength(BOARD_FEED_RETENTION);
    feed.stamp("p", [ticketChange("one-more")]);
    resnapshot(() => feed.subscribe("p", cursor, () => {}));
  });
});

describe("untapped and noteDataChanged", () => {
  it("maps an untargeted data-changed to a project change on every known Workspace", () => {
    const feed = createBoardChangeFeed();
    feed.cursor("p");
    feed.cursor("q");
    const p = capture(feed, "p");
    const q = capture(feed, "q");
    feed.noteDataChanged({});
    expect(p.batches[0]!.changes).toEqual([
      { kind: "project", op: "upsert", id: "p", projectId: "p" },
    ]);
    expect(q.batches[0]!.changes).toEqual([
      { kind: "project", op: "upsert", id: "q", projectId: "q" },
    ]);
  });

  it("uses the host's own Workspace list when it is given one", () => {
    const feed = createBoardChangeFeed({ workspaces: () => ["held"] });
    const known = capture(feed, "known");
    const held = capture(feed, "held");
    feed.noteDataChanged({});
    expect(known.batches).toEqual([]);
    expect(held.batches[0]!.changes).toEqual([
      { kind: "project", op: "upsert", id: "held", projectId: "held" },
    ]);
  });

  it("maps a project-scoped data-changed to that project's change", () => {
    const feed = createBoardChangeFeed();
    const p = capture(feed, "p");
    const q = capture(feed, "q");
    feed.noteDataChanged({ projectId: "p" });
    expect(p.batches[0]!.changes).toEqual([
      { kind: "project", op: "upsert", id: "p", projectId: "p" },
    ]);
    expect(q.batches).toEqual([]);
  });

  it("maps a ticket-scoped data-changed to a rowless ticket change", () => {
    const feed = createBoardChangeFeed();
    const { batches } = capture(feed, "p");
    feed.noteDataChanged({ projectId: "p", ticketId: "t", kind: "ticket" });
    expect(batches[0]!.changes).toEqual([
      { kind: "ticket", op: "upsert", id: "t", projectId: "p" },
    ]);
  });

  it("resolves a ticket-only scope to its project, and falls back to every board when it cannot", () => {
    const feed = createBoardChangeFeed({
      projectOfTicket: (ticketId) => (ticketId === "t" ? "p" : undefined),
    });
    const p = capture(feed, "p");
    const q = capture(feed, "q");
    feed.noteDataChanged({ ticketId: "t" });
    expect(p.batches.map((batch) => batch.changes)).toEqual([
      [{ kind: "ticket", op: "upsert", id: "t", projectId: "p" }],
    ]);
    expect(q.batches).toEqual([]);
    feed.noteDataChanged({ ticketId: "gone" });
    expect(p.batches[1]!.changes).toEqual([
      { kind: "project", op: "upsert", id: "p", projectId: "p" },
    ]);
    expect(q.batches[0]!.changes).toEqual([
      { kind: "project", op: "upsert", id: "q", projectId: "q" },
    ]);
  });

  it("treats a ticket-only scope as untargeted when nothing can resolve it", () => {
    const feed = createBoardChangeFeed();
    const { batches } = capture(feed, "p");
    feed.noteDataChanged({ ticketId: "t" });
    expect(batches[0]!.changes).toEqual([
      { kind: "project", op: "upsert", id: "p", projectId: "p" },
    ]);
  });

  it("maps a comment to its ticket's history, and a worktree change to a moved checkout", () => {
    const feed = createBoardChangeFeed();
    const { batches } = capture(feed, "p");
    feed.noteDataChanged({ projectId: "p", ticketId: "t", kind: "comment" });
    feed.noteDataChanged({ projectId: "p", ticketId: "t", kind: "worktree" });
    expect(batches.map((batch) => batch.changes)).toEqual([
      [{ kind: "ticketEvent", op: "upsert", id: "t", projectId: "p", ticketId: "t" }],
      [{ kind: "ticket", op: "upsert", id: "t", projectId: "p", checkoutMoved: true }],
    ]);
  });

  it("stamps nothing while untapped, nested or not, and returns what the announcement did", () => {
    const feed = createBoardChangeFeed();
    const { batches } = capture(feed, "p");
    const answer = feed.untapped(() => {
      feed.noteDataChanged({ projectId: "p" });
      const inner = feed.untapped(() => {
        feed.noteDataChanged({ projectId: "p" });
        return "inner";
      });
      // Still untapped after the inner scope closed.
      feed.noteDataChanged({ projectId: "p" });
      return inner;
    });
    expect(answer).toBe("inner");
    expect(batches).toEqual([]);
    feed.noteDataChanged({ projectId: "p" });
    expect(batches).toHaveLength(1);
  });

  it("taps again after an announcement that threw", () => {
    const feed = createBoardChangeFeed();
    const { batches } = capture(feed, "p");
    expect(() =>
      feed.untapped(() => {
        throw new Error("publish failed");
      }),
    ).toThrow("publish failed");
    feed.noteDataChanged({ projectId: "p" });
    expect(batches).toHaveLength(1);
  });
});
