import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  ACTIVITY_COALESCING,
  decideSessionOutcomeEvents,
  newId,
  type ActivityPage,
  type Actor,
  type SessionId,
  type TicketId,
} from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { MAX_FEED_SCAN, encodeFeedCursor } from "../functions/lib/activity";
import { recordBoardEvents } from "../functions/lib/board";
import {
  code,
  createTicket,
  seedSession,
  seedWorkspace,
  setup,
  signIn,
  type Client,
  type Tester,
} from "./board-helpers";

const MINUTE = 60 * 1000;
/** Far enough apart that nothing folds. */
const APART = ACTIVITY_COALESCING.gapMs / MINUTE + 1;
const command = () => newId("command");

let now = Date.UTC(2026, 9, 25);
function tick(minutes: number) {
  now += minutes * MINUTE;
  vi.setSystemTime(now);
}

beforeEach(() => {
  vi.useFakeTimers();
  tick(0);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Alice and Bob, Members of one Workspace with one project. */
async function team(t: Tester) {
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const workspaceId = await seedWorkspace(t, [{ userId: alice.userId }, { userId: bob.userId }]);
  const projectId = await createProject(alice.as, workspaceId, "Volli Code");
  return { alice, bob, workspaceId, projectId };
}

async function createProject(as: Client, workspaceId: string, name: string) {
  const projectId = newId("project");
  await as.mutation(api.projects.create, {
    commandId: command(),
    workspaceId,
    projectId,
    name,
    origin: "github",
  });
  return projectId;
}

async function update(as: Client, ticketId: string, fields: Record<string, unknown>) {
  await as.mutation(api.board.updateTicket, { commandId: command(), ticketId, ...fields });
}

async function comment(as: Client, ticketId: string, body = "Looks good") {
  await as.mutation(api.board.createComment, {
    commandId: command(),
    ticketId,
    commentId: newId("comment"),
    body,
  });
}

/** Appends the board events a Session's first listing records, as the intake fold will. */
async function sessionStarted(
  t: Tester,
  ticket: { ticketId: string; projectId: string },
  ownerUserId: string,
  visibility: "shared" | "private" = "shared",
) {
  const { sessionId } = await seedSession(t, ticket, ownerUserId);
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", sessionId))
      .unique();
    await ctx.db.patch(row!._id, { visibility });
    const drafts = decideSessionOutcomeEvents(null, {
      id: sessionId as SessionId,
      ticketId: ticket.ticketId as TicketId,
      origin: { kind: "user" },
      latestTurnId: null,
      lastTurnOutcome: null,
      signal: null,
      stopped: null,
    });
    const actor = { kind: "agent", userId: ownerUserId, sessionId } as Actor;
    await recordBoardEvents(ctx, ticket.projectId, actor, Date.now(), drafts);
  });
  return sessionId;
}

type Page = { numItems: number; cursor: string | null; endCursor?: string | null };

function projectFeed(as: Client, projectId: string, page: Page, extra: object = {}) {
  return as.query(api.activity.project, { projectId, page, ...extra }) as Promise<ActivityPage>;
}

function workspaceFeed(as: Client, workspaceId: string, page: Page, extra: object = {}) {
  return as.query(api.activity.workspace, { workspaceId, page, ...extra }) as Promise<ActivityPage>;
}

/** Every page of a feed, `numItems` at a time. */
async function allPages(read: (page: Page) => Promise<ActivityPage>, numItems: number) {
  const pages: ActivityPage[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await read({ numItems, cursor });
    pages.push(page);
    if (page.isDone) return pages;
    cursor = page.continueCursor;
  }
}

const summary = (page: ActivityPage) =>
  page.page.map((item) =>
    item.what.kind === "event" ? item.what.payload.kind : `${item.what.kind}×${item.count}`,
  );

const label = (page: ActivityPage) =>
  page.page.map((item) =>
    item.what.kind === "created"
      ? item.what.title
      : item.what.kind === "event"
        ? item.what.payload.kind
        : item.what.kind,
  );

describe("activity.project", () => {
  test("newest first, one person's run on a ticket folded, with the tickets and people it names", async () => {
    const t = setup();
    const { alice, bob, projectId } = await team(t);
    tick(APART);
    const { ticketId, key } = await createTicket(alice.as, projectId, {
      title: "Fix it",
      labels: ["UI"],
    });
    tick(1);
    await update(alice.as, ticketId, { priority: "high" });
    tick(APART);
    await comment(bob.as, ticketId);
    tick(1);
    await comment(bob.as, ticketId, "And another thing");
    tick(1);
    await update(alice.as, ticketId, { title: "Fix it well" });
    tick(1);
    await update(alice.as, ticketId, { title: "Fix it properly", addLabels: ["Backend"] });

    const page = await projectFeed(bob.as, projectId, { numItems: 10, cursor: null });
    expect(summary(page)).toEqual(["changed×3", "commented×2", "created×3", "project_created"]);
    expect(page.isDone).toBe(true);
    expect(page.page[0]).toMatchObject({
      ticketId,
      actor: { kind: "person", userId: alice.userId },
      count: 3,
      what: {
        kind: "changed",
        changes: [
          { field: "labels", added: ["Backend"], removed: [] },
          { field: "title", from: "Fix it", to: "Fix it properly" },
        ],
      },
    });
    expect(page.page[2]!.what).toEqual({
      kind: "created",
      title: "Fix it",
      status: "todo",
      changes: [
        { field: "priority", from: "medium", to: "high" },
        { field: "labels", added: ["UI"], removed: [] },
      ],
    });
    expect(page.page[3]).toMatchObject({ ticketId: null, actor: { kind: "person" } });
    expect(page.tickets).toEqual([
      { id: ticketId, projectId, key, title: "Fix it properly", status: "todo", archived: false },
    ]);
    expect(page.people).toHaveLength(2);
    expect(page.people).toEqual(
      expect.arrayContaining([
        { userId: alice.userId, displayName: "Volli user", deleted: false },
        { userId: bob.userId, displayName: "Volli user", deleted: false },
      ]),
    );
  });

  test("pages concatenate to the whole feed and never end inside a run", async () => {
    const t = setup();
    const { alice, projectId } = await team(t);
    const tickets: string[] = [];
    for (const title of ["One", "Two", "Three"]) {
      tick(APART);
      tickets.push((await createTicket(alice.as, projectId, { title })).ticketId);
    }
    tick(APART);
    for (const priority of ["low", "high", "medium"] as const) {
      await update(alice.as, tickets[0]!, { priority });
      tick(1);
    }

    const whole = await projectFeed(alice.as, projectId, { numItems: 50, cursor: null });
    expect(summary(whole)).toEqual([
      "changed×3",
      "created×1",
      "created×1",
      "created×1",
      "project_created",
    ]);
    const pages = await allPages((page) => projectFeed(alice.as, projectId, page), 1);
    expect(pages.map(summary)).toEqual([
      ["changed×3"],
      ["created×1"],
      ["created×1"],
      ["created×1"],
      ["project_created"],
    ]);
    expect(pages.flatMap((page) => page.page)).toEqual(whole.page);
    expect(pages.slice(0, -1).every((page) => !page.isDone)).toBe(true);
  });

  test("a pinned page grows at the top as events arrive, and the next page stays put", async () => {
    const t = setup();
    const { alice, projectId } = await team(t);
    for (const title of ["One", "Two", "Three"]) {
      tick(APART);
      await createTicket(alice.as, projectId, { title });
    }
    const first = await projectFeed(alice.as, projectId, { numItems: 2, cursor: null });
    const second = await projectFeed(alice.as, projectId, {
      numItems: 2,
      cursor: first.continueCursor,
    });
    tick(APART);
    await createTicket(alice.as, projectId, { title: "Four" });

    const pinned = await projectFeed(alice.as, projectId, {
      numItems: 2,
      cursor: null,
      endCursor: first.continueCursor,
    });
    expect(pinned.page.map((item) => item.what.kind === "created" && item.what.title)).toEqual([
      "Four",
      "Three",
      "Two",
    ]);
    expect(pinned.continueCursor).toBe(first.continueCursor);
    expect(pinned.isDone).toBe(false);
    const again = await projectFeed(alice.as, projectId, {
      numItems: 2,
      cursor: first.continueCursor,
    });
    expect(again).toEqual(second);
    expect(summary(second)).toEqual(["created×1", "project_created"]);
    expect(second.isDone).toBe(true);
    // A pinned last page reports done like the page it pins.
    const lastPinned = await projectFeed(alice.as, projectId, {
      numItems: 2,
      cursor: first.continueCursor,
      endCursor: second.continueCursor,
    });
    expect(lastPinned.isDone).toBe(true);
    expect(lastPinned.page).toEqual(second.page);
  });

  test("filters by person and by time", async () => {
    const t = setup();
    const { alice, bob, projectId } = await team(t);
    tick(APART);
    const { ticketId } = await createTicket(alice.as, projectId);
    tick(APART);
    const since = now;
    await comment(bob.as, ticketId);
    tick(APART);
    await update(alice.as, ticketId, { priority: "low" });

    const bobs = await projectFeed(
      alice.as,
      projectId,
      { numItems: 10, cursor: null },
      {
        person: bob.userId,
      },
    );
    expect(summary(bobs)).toEqual(["commented×1"]);
    const recent = await projectFeed(
      alice.as,
      projectId,
      { numItems: 10, cursor: null },
      { since },
    );
    expect(summary(recent)).toEqual(["changed×1", "commented×1"]);
    expect(recent.isDone).toBe(true);
    // A window that ends a page early still pages on from where it stopped.
    const first = await projectFeed(alice.as, projectId, { numItems: 1, cursor: null }, { since });
    const rest = await projectFeed(
      alice.as,
      projectId,
      { numItems: 1, cursor: first.continueCursor },
      { since },
    );
    expect([...summary(first), ...summary(rest)]).toEqual(["changed×1", "commented×1"]);
    expect(rest.isDone).toBe(true);
  });

  test("a private Session's entries show only to its owner, or to everyone under shareAll", async () => {
    const t = setup();
    const { alice, bob, workspaceId, projectId } = await team(t);
    tick(APART);
    const { ticketId } = await createTicket(alice.as, projectId);
    tick(APART);
    const shared = await sessionStarted(t, { ticketId, projectId }, alice.userId, "shared");
    tick(APART);
    await sessionStarted(t, { ticketId, projectId }, alice.userId, "private");

    const sessionsSeenBy = async (as: Client) =>
      (await projectFeed(as, projectId, { numItems: 10, cursor: null })).page.filter(
        (item) => item.what.kind === "event" && item.what.payload.kind === "session_started",
      ).length;
    expect(await sessionsSeenBy(alice.as)).toBe(2);
    expect(await sessionsSeenBy(bob.as)).toBe(1);
    const page = await projectFeed(bob.as, projectId, { numItems: 10, cursor: null });
    expect(page.page[0]).toMatchObject({
      actor: { kind: "agent", userId: alice.userId, sessionId: shared },
      what: { kind: "event", payload: { kind: "session_started", sessionId: shared } },
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("workspacePolicies", {
        workspaceId,
        shareAll: true,
        whoCanInvite: "members",
        revision: 1,
        updatedByUserId: alice.userId,
        updatedAt: now,
      });
    });
    expect(await sessionsSeenBy(bob.as)).toBe(2);
  });

  test("a deleted ticket's events and a deleted Session's are left out", async () => {
    const t = setup();
    const { alice, projectId } = await team(t);
    tick(APART);
    const kept = await createTicket(alice.as, projectId, { title: "Kept" });
    tick(APART);
    const gone = await createTicket(alice.as, projectId, { title: "Gone" });
    tick(APART);
    const sessionId = await sessionStarted(t, { ticketId: kept.ticketId, projectId }, alice.userId);
    await t.run(async (ctx) => {
      for (const [table, id] of [
        ["tickets", gone.ticketId],
        ["sessions", sessionId],
      ] as const) {
        const row = await ctx.db
          .query(table)
          .withIndex("by_uuid", (q) => q.eq("id", id))
          .unique();
        await ctx.db.patch(row!._id, { deletedAt: now });
      }
    });
    const page = await projectFeed(alice.as, projectId, { numItems: 10, cursor: null });
    expect(page.page.map((item) => item.ticketId)).toEqual([kept.ticketId, null]);
    expect(page.tickets.map((ticket) => ticket.key)).toEqual([kept.key]);
  });

  test("names a link's target in this Workspace, and a deleted account as such", async () => {
    const t = setup();
    const { alice, bob, projectId } = await team(t);
    const otherProject = await createProject(alice.as, (await team(t)).workspaceId, "Elsewhere");
    tick(APART);
    const { ticketId } = await createTicket(alice.as, projectId, { title: "Here" });
    const target = await createTicket(alice.as, projectId, { title: "There" });
    const foreign = await createTicket(alice.as, otherProject, { title: "Foreign" });
    tick(APART);
    await t.run(async (ctx) => {
      const actor: Actor = { kind: "person", userId: bob.userId } as Actor;
      await recordBoardEvents(ctx, projectId, actor, now, [
        {
          ticketId: ticketId as TicketId,
          payload: { kind: "linked", toTicketId: target.ticketId as TicketId, linkKind: "blocks" },
        },
        {
          ticketId: ticketId as TicketId,
          payload: {
            kind: "linked",
            toTicketId: foreign.ticketId as TicketId,
            linkKind: "relates",
          },
        },
      ]);
      const user = await ctx.db
        .query("users")
        .withIndex("by_uuid", (q) => q.eq("id", bob.userId))
        .unique();
      await ctx.db.patch(user!._id, { status: "deleted" });
    });
    const page = await projectFeed(alice.as, projectId, { numItems: 2, cursor: null });
    expect(summary(page)).toEqual(["linked", "linked"]);
    expect(page.tickets.map((ticket) => ticket.title).toSorted()).toEqual(["Here", "There"]);
    expect(page.people).toEqual([
      { userId: bob.userId, displayName: "Deleted user", deleted: true },
    ]);
  });

  test("refuses outsiders, bad cursors and bad page sizes", async () => {
    const t = setup();
    const { projectId } = await team(t);
    const carol = await signIn(t, "carol");
    await expect(projectFeed(carol.as, projectId, { numItems: 5, cursor: null })).rejects.toThrow();
    await expect(
      projectFeed(carol.as, projectId, { numItems: 5, cursor: null }),
    ).rejects.toMatchObject(code("not_a_member"));
    const alice = (await signIn(t, "alice")).as;
    for (const cursor of [
      "nope",
      "null",
      "[]",
      '{"v":2,"at":0,"b":{},"d":false}',
      '{"v":1,"at":0,"b":[],"d":false}',
      `{"v":1,"at":0,"b":{"${projectId}":0},"d":false}`,
    ]) {
      await expect(projectFeed(alice, projectId, { numItems: 5, cursor })).rejects.toMatchObject(
        code("invalid_cursor"),
      );
    }
    for (const numItems of [0, 1.5, 201]) {
      await expect(projectFeed(alice, projectId, { numItems, cursor: null })).rejects.toMatchObject(
        code("invalid_page_size"),
      );
    }
  });

  test("a page reads a bounded number of events", async () => {
    const t = setup();
    const { alice, projectId } = await team(t);
    const { ticketId } = await createTicket(alice.as, projectId);
    // More hidden events than one page reads: a private Session's outcomes, to Bob.
    const bob = await signIn(t, "bob");
    const sessionId = await sessionStarted(t, { ticketId, projectId }, alice.userId, "private");
    await t.run(async (ctx) => {
      const actor = { kind: "agent", userId: alice.userId, sessionId } as Actor;
      const drafts = Array.from({ length: MAX_FEED_SCAN }, (_, at) => ({
        ticketId: ticketId as TicketId,
        payload: {
          kind: "session_stopped" as const,
          sessionId: sessionId as SessionId,
          reason: `${at}`,
        },
      }));
      await recordBoardEvents(ctx, projectId, actor, now, drafts);
    });
    const first = await projectFeed(bob.as, projectId, { numItems: 5, cursor: null });
    expect(first.page).toEqual([]);
    expect(first.isDone).toBe(false);
    const next = await projectFeed(bob.as, projectId, {
      numItems: 5,
      cursor: first.continueCursor,
    });
    expect(summary(next)).toEqual(["created×1", "project_created"]);
    expect(next.isDone).toBe(true);
  });
});

describe("activity.workspace", () => {
  test("merges the Workspace's projects by time and pages across them", async () => {
    const t = setup();
    const { alice, bob, workspaceId, projectId } = await team(t);
    tick(APART);
    const other = await createProject(bob.as, workspaceId, "Website");
    const titles: string[] = [];
    for (const [i, target] of [projectId, other, projectId, other].entries()) {
      tick(APART);
      const title = `T${i}`;
      titles.unshift(title);
      await createTicket(i % 2 === 0 ? alice.as : bob.as, target, { title });
    }
    const whole = await workspaceFeed(alice.as, workspaceId, { numItems: 50, cursor: null });
    expect(label(whole)).toEqual([...titles, "project_created", "project_created"]);
    expect(whole.tickets.map((ticket) => ticket.key)).toEqual(["WE-2", "VC-2", "WE-1", "VC-1"]);

    const pages = await allPages((page) => workspaceFeed(alice.as, workspaceId, page), 3);
    expect(pages.flatMap((page) => page.page)).toEqual(whole.page);

    // A project created after the first page: it joins the top of the pinned
    // first page, and none of it lands in the older pages.
    const first = await workspaceFeed(alice.as, workspaceId, { numItems: 3, cursor: null });
    tick(APART);
    const late = await createProject(alice.as, workspaceId, "Late");
    await createTicket(alice.as, late, { title: "Late one" });
    const pinned = await workspaceFeed(alice.as, workspaceId, {
      numItems: 3,
      cursor: null,
      endCursor: first.continueCursor,
    });
    expect(label(pinned)).toEqual(["Late one", "project_created", ...label(first)]);
    const older = await workspaceFeed(alice.as, workspaceId, {
      numItems: 50,
      cursor: first.continueCursor,
    });
    expect(label(older)).toEqual(label(whole).slice(3));
  });

  test("refuses a non-member, and shows a deleted project's history to nobody", async () => {
    const t = setup();
    const { alice, workspaceId, projectId } = await team(t);
    const carol = await signIn(t, "carol");
    await expect(
      workspaceFeed(carol.as, workspaceId, { numItems: 5, cursor: null }),
    ).rejects.toMatchObject(code("not_a_member"));
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", projectId))
        .unique();
      await ctx.db.patch(row!._id, { deletedAt: now });
    });
    const page = await workspaceFeed(alice.as, workspaceId, { numItems: 5, cursor: null });
    expect(page).toMatchObject({ page: [], tickets: [], people: [], isDone: true });
    // A cursor naming a project that is gone reads on without it.
    const stale = encodeFeedCursor({ at: now, bounds: { [projectId]: 5 }, done: false });
    const after = await workspaceFeed(alice.as, workspaceId, { numItems: 5, cursor: stale });
    expect(after).toMatchObject({ page: [], isDone: true });
  });
});
