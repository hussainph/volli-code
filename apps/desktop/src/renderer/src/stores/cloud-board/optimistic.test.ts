import { describe, expect, it } from "vite-plus/test";
import type { TicketId } from "@volli/shared/cloud";

import {
  optimisticArchive,
  optimisticComment,
  optimisticCreate,
  optimisticLabelColor,
  optimisticMove,
  optimisticUnarchive,
  optimisticUpdate,
  type LocalStore,
} from "./optimistic";

const P = "00000000-0000-4000-8000-000000000001";
const QUERIES = { roster: "roster", getTicket: "getTicket", comments: "comments" } as const;

function row(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    projectId: P,
    number: n,
    title: `T${n}`,
    status: "todo",
    priority: "medium",
    position: `a${n}`,
    labelIds: [] as string[],
    assigneeUserId: null,
    checkoutMode: "worktree",
    preferredHarnessId: "claude-code",
    branch: null,
    baseBranch: null,
    retentionKeep: false,
    placeRunnerId: null,
    archivedAt: null,
    pullRequests: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as const;
}

const id = (n: number) => row(n).id as TicketId;

const key = (query: unknown, args: Record<string, unknown>) =>
  `${String(query)} ${JSON.stringify(args)}`;

/** A Map-backed stand-in for Convex's optimistic local store. */
function fakeStore(entries: [string, Record<string, unknown>, unknown][] = []) {
  const values = new Map<string, unknown>();
  for (const [query, args, value] of entries) values.set(key(query, args), value);
  const store: LocalStore & { read(query: string, args: Record<string, unknown>): unknown } = {
    getQuery: (query, args) => values.get(key(query, args)),
    setQuery: (query, args, value) => void values.set(key(query, args), value),
    read: (query, args) => values.get(key(query, args)),
  };
  return store;
}

const roster = (tickets: unknown[], labels: unknown[] = []) => ({ tickets, labels });
const label = (labelId: string, name: string) => ({
  id: labelId,
  projectId: P,
  name,
  nameKey: name.toLowerCase(),
  color: null,
  mergedIntoId: null,
});

describe("the cloud board's optimistic updates (VC-889)", () => {
  it("does nothing when the query it would patch is not loaded", () => {
    const store = fakeStore();
    optimisticMove(store, QUERIES, {
      projectId: P,
      command: { ticketIds: [id(1)], toStatus: "doing" },
      now: 0,
    });
    optimisticCreate(store, QUERIES, {
      projectId: P,
      command: { ticketId: id(9), status: "todo", title: "x" },
      createdBy: null,
      now: 0,
    });
    optimisticUpdate(store, QUERIES, {
      projectId: P,
      ticketId: id(1),
      command: { title: "x" },
      now: 0,
    });
    optimisticArchive(store, QUERIES, { projectId: P, ticketId: id(1) });
    optimisticUnarchive(store, QUERIES, { projectId: P, ticketId: id(1), now: 0 });
    optimisticLabelColor(store, QUERIES, { projectId: P, labelId: "l", color: null });
    optimisticComment(store, QUERIES, { kind: "remove", ticketId: id(1), commentId: "c" });
    expect(store.read("roster", { projectId: P })).toBeUndefined();
  });

  it("moves through the shared rules, leaves the input untouched, and composes two moves in order", () => {
    const tickets = [row(1), row(2), row(3, { status: "doing", position: "a0" })].map((ticket) =>
      Object.freeze(ticket),
    );
    const before = roster(tickets);
    const store = fakeStore([["roster", { projectId: P }, before]]);
    optimisticMove(store, QUERIES, {
      projectId: P,
      command: {
        ticketIds: [id(3)],
        toStatus: "todo",
        afterTicketId: id(1),
        beforeTicketId: id(2),
      },
      now: 0,
    });
    const first = store.read("roster", { projectId: P }) as typeof before;
    const moved = first.tickets.find((ticket) => (ticket as { id: string }).id === id(3)) as {
      status: string;
      position: string;
    };
    expect(moved.status).toBe("todo");
    expect(moved.position > "a1" && moved.position < "a2").toBe(true);
    expect(tickets[2]!.status).toBe("doing");
    expect(first.tickets[0]).toBe(tickets[0]);
    // A second pending move reads the first's paint.
    optimisticMove(store, QUERIES, {
      projectId: P,
      command: { ticketIds: [id(1)], toStatus: "todo", afterTicketId: id(3) },
      now: 0,
    });
    const second = store.read("roster", { projectId: P }) as typeof before;
    const order = second.tickets
      .filter((ticket) => (ticket as { status: string }).status === "todo")
      .toSorted((a, b) =>
        (a as { position: string }).position < (b as { position: string }).position ? -1 : 1,
      )
      .map((ticket) => (ticket as { number: number }).number);
    expect(order).toEqual([3, 1, 2]);
  });

  it("paints nothing for a move the rules refuse, or one that moves nothing", () => {
    const before = roster([row(1), row(2)]);
    const store = fakeStore([["roster", { projectId: P }, before]]);
    optimisticMove(store, QUERIES, {
      projectId: P,
      command: { ticketIds: [], toStatus: "todo" },
      now: 0,
    });
    optimisticMove(store, QUERIES, {
      projectId: P,
      command: { ticketIds: [id(1)], toStatus: "todo" },
      now: 0,
    });
    expect(store.read("roster", { projectId: P })).toBe(before);
  });

  it("creates at the column's end with no key, a pending label, and its body ready", () => {
    const store = fakeStore([["roster", { projectId: P }, roster([row(1)], [label("l1", "UI")])]]);
    optimisticCreate(store, QUERIES, {
      projectId: P,
      command: {
        ticketId: id(9),
        status: "todo",
        title: " New ",
        body: "# Body",
        labels: ["ui", "Fresh"],
      },
      createdBy: { kind: "person" },
      now: 7,
    });
    const next = store.read("roster", { projectId: P }) as {
      tickets: { id: string; number: number; position: string; labelIds: string[] }[];
      labels: { id: string; name: string }[];
    };
    const created = next.tickets.at(-1)!;
    expect(created).toMatchObject({ id: id(9), number: 0, title: "New", createdAt: 7 });
    expect(created.position > "a1").toBe(true);
    expect(created.labelIds[0]).toBe("l1");
    expect(created.labelIds[1]).toMatch(/^pending:[0-9a-f-]{36}$/u);
    expect(next.labels.map((value) => [value.id, value.name])).toEqual([
      ["l1", "UI"],
      [created.labelIds[1], "Fresh"],
    ]);
    expect(store.read("getTicket", { ticketId: id(9) })).toMatchObject({
      body: "# Body",
      bodyRevision: 0,
    });
    // An empty column, and a title the rules refuse.
    const empty = fakeStore([["roster", { projectId: P }, roster([])]]);
    optimisticCreate(empty, QUERIES, {
      projectId: P,
      command: { ticketId: id(8), status: "done", title: "First" },
      createdBy: null,
      now: 0,
    });
    expect((empty.read("roster", { projectId: P }) as { tickets: unknown[] }).tickets).toHaveLength(
      1,
    );
    const refused = fakeStore([["roster", { projectId: P }, roster([])]]);
    optimisticCreate(refused, QUERIES, {
      projectId: P,
      command: { ticketId: id(8), status: "todo", title: "  " },
      createdBy: null,
      now: 0,
    });
    expect(refused.read("getTicket", { ticketId: id(8) })).toBeUndefined();
  });

  it("updates fields, labels and a loaded body, and paints nothing that would not change", () => {
    const store = fakeStore([
      ["roster", { projectId: P }, roster([row(1), row(2)])],
      ["getTicket", { ticketId: id(1) }, { ticket: row(1), body: "old", bodyRevision: 3 }],
    ]);
    optimisticUpdate(store, QUERIES, {
      projectId: P,
      ticketId: id(1),
      command: { title: "Renamed", priority: "high", body: "new", labels: ["bug"] },
      now: 5,
    });
    const next = store.read("roster", { projectId: P }) as {
      tickets: Record<string, unknown>[];
      labels: { id: string }[];
    };
    expect(next.tickets[0]).toMatchObject({ title: "Renamed", priority: "high", updatedAt: 5 });
    const [pending] = next.tickets[0]!.labelIds as string[];
    expect(next.labels.map((value) => value.id)).toEqual([pending]);
    // Another pending write's new label never shares its id.
    optimisticUpdate(store, QUERIES, {
      projectId: P,
      ticketId: id(2),
      command: { labels: ["other"] },
      now: 5,
    });
    const both = store.read("roster", { projectId: P }) as typeof next;
    expect(new Set(both.labels.map((value) => value.id)).size).toBe(2);
    expect(store.read("getTicket", { ticketId: id(1) })).toMatchObject({
      body: "new",
      ticket: { title: "Renamed" },
    });
    // The body unread: the rules compare against "", and nothing else to patch.
    optimisticUpdate(store, QUERIES, {
      projectId: P,
      ticketId: id(2),
      command: { priority: "low" },
      now: 6,
    });
    expect(store.read("getTicket", { ticketId: id(2) })).toBeUndefined();
    const unchanged = store.read("roster", { projectId: P });
    optimisticUpdate(store, QUERIES, {
      projectId: P,
      ticketId: id(2),
      command: { priority: "low" },
      now: 7,
    });
    optimisticUpdate(store, QUERIES, {
      projectId: P,
      ticketId: id(2),
      command: { title: " " },
      now: 7,
    });
    optimisticUpdate(store, QUERIES, {
      projectId: P,
      ticketId: id(9),
      command: { title: "x" },
      now: 7,
    });
    expect(store.read("roster", { projectId: P })).toBe(unchanged);
    // A loaded body the update leaves alone stays as it was.
    optimisticUpdate(store, QUERIES, {
      projectId: P,
      ticketId: id(1),
      command: { priority: "low" },
      now: 8,
    });
    expect(store.read("getTicket", { ticketId: id(1) })).toMatchObject({ body: "new" });
  });

  it("archives off the board, and unarchives to the column's end when the row is at hand", () => {
    const store = fakeStore([
      ["roster", { projectId: P }, roster([row(1), row(2)])],
      [
        "getTicket",
        { ticketId: id(3) },
        { ticket: row(3, { archivedAt: 4 }), body: "", bodyRevision: 1 },
      ],
      ["getTicket", { ticketId: id(1) }, { ticket: row(1), body: "", bodyRevision: 1 }],
    ]);
    optimisticArchive(store, QUERIES, { projectId: P, ticketId: id(2) });
    expect((store.read("roster", { projectId: P }) as { tickets: unknown[] }).tickets).toHaveLength(
      1,
    );
    optimisticUnarchive(store, QUERIES, { projectId: P, ticketId: id(3), now: 9 });
    const back = (store.read("roster", { projectId: P }) as { tickets: Record<string, unknown>[] })
      .tickets;
    expect(back.at(-1)).toMatchObject({ id: id(3), archivedAt: null, updatedAt: 9 });
    expect((back.at(-1)!.position as string) > "a1").toBe(true);
    // Already on the board: nothing to bring back.
    optimisticUnarchive(store, QUERIES, { projectId: P, ticketId: id(1), now: 9 });
    expect((store.read("roster", { projectId: P }) as { tickets: unknown[] }).tickets).toHaveLength(
      2,
    );
    const empty = fakeStore([
      ["roster", { projectId: P }, roster([])],
      [
        "getTicket",
        { ticketId: id(3) },
        { ticket: row(3, { archivedAt: 4 }), body: "", bodyRevision: 1 },
      ],
    ]);
    optimisticUnarchive(empty, QUERIES, { projectId: P, ticketId: id(3), now: 9 });
    expect((empty.read("roster", { projectId: P }) as { tickets: unknown[] }).tickets).toHaveLength(
      1,
    );
  });

  it("recolors a label as the backend stores it, and refuses a color it would refuse", () => {
    const store = fakeStore([
      ["roster", { projectId: P }, roster([], [label("l1", "UI"), label("l2", "Bug")])],
    ]);
    optimisticLabelColor(store, QUERIES, { projectId: P, labelId: "l1", color: "#ff0000" });
    const painted = store.read("roster", { projectId: P }) as {
      labels: { color: string | null }[];
    };
    expect(painted.labels.map((value) => value.color)).toEqual(["#ff0000", null]);
    optimisticLabelColor(store, QUERIES, { projectId: P, labelId: "l1", color: null });
    expect((store.read("roster", { projectId: P }) as typeof painted).labels[0]!.color).toBeNull();
    const before = store.read("roster", { projectId: P });
    optimisticLabelColor(store, QUERIES, { projectId: P, labelId: "l1", color: "" });
    optimisticLabelColor(store, QUERIES, { projectId: P, labelId: "gone", color: "#000000" });
    expect(store.read("roster", { projectId: P })).toBe(before);
  });

  it("adds, edits and removes a comment in the loaded list", () => {
    const store = fakeStore([
      ["comments", { ticketId: id(1) }, [{ id: "c1", body: "hi", editedAt: null }]],
    ]);
    optimisticComment(store, QUERIES, {
      kind: "create",
      ticketId: id(1),
      comment: { id: "c2", body: "new" },
    });
    optimisticComment(store, QUERIES, {
      kind: "update",
      ticketId: id(1),
      commentId: "c1",
      body: "edited",
      now: 3,
    });
    expect(store.read("comments", { ticketId: id(1) })).toEqual([
      { id: "c1", body: "edited", editedAt: 3 },
      { id: "c2", body: "new" },
    ]);
    optimisticComment(store, QUERIES, { kind: "remove", ticketId: id(1), commentId: "c2" });
    expect(store.read("comments", { ticketId: id(1) })).toEqual([
      { id: "c1", body: "edited", editedAt: 3 },
    ]);
  });
});
