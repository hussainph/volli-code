/**
 * What a teammate can read of someone else's Session, on each surface a
 * client reads Sessions through.
 *
 * A private Session is private end to end: it is not in a teammate's listing
 * (the only "search" a client does is filtering that listing), its snapshot
 * and history are `not_found`, and a board event it caused on a ticket names
 * it only as an opaque id in the Actor. Two things open it, and only two: its
 * owner's one-way Share (which carries its subagents with it) and the
 * Workspace's `shareAll` policy while it is on. The matrix of every position
 * against every Session, and the board filter's own unit behaviour, live in
 * `visibility.test.ts`; this file pins the reading surfaces a teammate
 * actually uses.
 */

import { convexTest } from "convex-test";
import type { GenericMutationCtx } from "convex/server";
import { describe, expect, test } from "vite-plus/test";

import {
  PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  newId,
  type SessionRole,
  type SessionVisibility,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { DataModel } from "../functions/_generated/dataModel.js";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

function setup() {
  return convexTest(schema, modules);
}

type T = ReturnType<typeof setup>;
type Client = ReturnType<T["withIdentity"]>;
type Ctx = GenericMutationCtx<DataModel>;

const ISSUER = "https://issuer.test";

/** Titles that must never reach a teammate: one word, so a leak is one substring. */
const SECRET = "Acquisition";
const SHARED_TITLE = "Ship the thing";
const PRIVATE_CHAT_TITLE = `${SECRET} notes`;
const PRIVATE_HELPER_TITLE = `${SECRET} helper`;
const PRIVATE_BOARD_TITLE = `${SECRET} board chat`;

function person(name: string) {
  return {
    subject: `user:${name.toLowerCase()}`,
    issuer: ISSUER,
    name,
    email: `${name.toLowerCase()}@example.com`,
    emailVerified: true,
  };
}

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

async function signIn(t: T, name: string) {
  const identity = person(name);
  await t.mutation(internal.previewAccess.set, {
    kind: "email",
    value: identity.email,
    enabled: true,
  });
  const client = t.withIdentity(identity);
  const { userId } = await client.mutation(api.accounts.ensureViewer, {
    acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  });
  return { client, userId };
}

async function addMember(
  inviter: Client,
  invitee: Client,
  workspaceId: string,
  role: "owner" | "admin" | "member",
) {
  const { token } = await inviter.mutation(api.invites.create, { workspaceId, email: null, role });
  await invitee.mutation(api.invites.acceptLink, { token });
}

async function seedSession(
  ctx: Ctx,
  input: {
    projectId: string;
    ownerUserId: string;
    role: SessionRole;
    visibility: SessionVisibility;
    title: string;
    ticketId?: string;
    parentSessionId?: string;
  },
) {
  const id = newId("session");
  await ctx.db.insert("sessions", {
    id,
    projectId: input.projectId,
    ticketId: input.ticketId ?? null,
    role: input.role,
    parentSessionId: input.parentSessionId ?? null,
    ownerUserId: input.ownerUserId,
    origin: { kind: "user" },
    title: input.title,
    visibility: input.visibility,
    visibilityReason:
      input.role === "subagent" ? "inherited" : input.visibility === "shared" ? "ticket" : "adhoc",
    sharedAt: null,
    status: "open",
    turnActive: false,
    lastTurnOutcome: null,
    signal: null,
    stopped: null,
    needsUser: false,
    attentionCount: 0,
    placeRunnerId: newId("runner"),
    model: null,
    usageTotals: {},
    createdAt: 0,
    lastActivityAt: 0,
    deletedAt: null,
    purgeAfter: null,
  });
  return id;
}

/**
 * Alice's Workspace with one teammate (Bob), a project, a ticket, and the
 * four Sessions the surfaces below read: the ticket's shared work, Alice's
 * private chat with a private subagent, and a private chat started from the
 * ticket (a Board Session). A board event records a change Alice's private
 * chat's agent made to the ticket.
 */
async function world(t: T) {
  const alice = await signIn(t, "Alice");
  const bob = await signIn(t, "Bob");
  const workspaceId = newId("workspace");
  await alice.client.mutation(api.workspaces.create, { workspaceId, name: "Acme" });
  await addMember(alice.client, bob.client, workspaceId, "member");
  const projectId = newId("project");
  await alice.client.mutation(api.projects.create, {
    commandId: newId("command"),
    workspaceId,
    projectId,
    name: "Volli",
    origin: "github",
  });
  const ticketId = newId("ticket");
  await alice.client.mutation(api.board.createTicket, {
    commandId: newId("command"),
    projectId,
    ticketId,
    status: "todo",
    title: SHARED_TITLE,
  });
  const sessions = await t.run(async (ctx) => {
    const base = { projectId, ownerUserId: alice.userId };
    const privateChat = await seedSession(ctx, {
      ...base,
      role: "project",
      visibility: "private",
      title: PRIVATE_CHAT_TITLE,
    });
    const privateHelper = await seedSession(ctx, {
      ...base,
      role: "subagent",
      visibility: "private",
      title: PRIVATE_HELPER_TITLE,
      parentSessionId: privateChat,
    });
    const privateBoardChat = await seedSession(ctx, {
      ...base,
      role: "project",
      visibility: "private",
      title: PRIVATE_BOARD_TITLE,
      ticketId,
    });
    const ticketWork = await seedSession(ctx, {
      ...base,
      role: "ticket",
      visibility: "shared",
      title: SHARED_TITLE,
      ticketId,
    });
    // A change the private chat's agent made on the ticket: the Session is in
    // the Actor as attribution, never in the payload.
    await ctx.db.insert("boardEvents", {
      id: newId("boardEvent"),
      projectId,
      ticketId,
      seq: 100,
      kind: "status_changed",
      actor: { kind: "agent", userId: alice.userId, sessionId: privateChat },
      occurredAt: 100,
      payload: { kind: "status_changed", from: "todo", to: "doing" },
    });
    return { privateChat, privateHelper, privateBoardChat, ticketWork };
  });
  return { workspaceId, projectId, ticketId, sessions, alice, bob };
}

const PAGE = { numItems: 10, cursor: null };

async function listing(
  client: Client,
  project: { projectId: string; ticketId?: string },
): Promise<string[]> {
  const page = await client.query(api.sessions.list, {
    projectId: project.projectId,
    ...(project.ticketId === undefined ? {} : { ticketId: project.ticketId }),
    paginationOpts: PAGE,
  });
  return page.page.map((row) => row.id).toSorted();
}

async function listingText(client: Client, projectId: string): Promise<string> {
  const page = await client.query(api.sessions.list, {
    projectId,
    paginationOpts: PAGE,
  });
  return JSON.stringify(page);
}

describe("a private Session on the reading surfaces", () => {
  test("a teammate's listing carries the shared ticket work and never a private chat", async () => {
    const t = setup();
    const w = await world(t);
    const { privateChat, privateHelper, privateBoardChat, ticketWork } = w.sessions;

    // The owner sees all four, by project and by ticket.
    expect(await listing(w.alice.client, { projectId: w.projectId })).toEqual(
      [privateChat, privateHelper, privateBoardChat, ticketWork].toSorted(),
    );
    expect(await listing(w.alice.client, { projectId: w.projectId, ticketId: w.ticketId })).toEqual(
      [privateBoardChat, ticketWork].toSorted(),
    );

    // The teammate sees the ticket's shared work only: the private chat is not
    // a row the client could filter, search or count.
    expect(await listing(w.bob.client, { projectId: w.projectId })).toEqual([ticketWork]);
    expect(await listing(w.bob.client, { projectId: w.projectId, ticketId: w.ticketId })).toEqual([
      ticketWork,
    ]);
    // Nor does any private title come along with the page.
    expect(await listingText(w.bob.client, w.projectId)).not.toContain(SECRET);
  });

  test("a teammate cannot read a private Session's content, and the owner still can", async () => {
    const t = setup();
    const w = await world(t);
    const { privateChat } = w.sessions;
    for (const read of [
      (client: Client) => client.query(api.sessions.snapshot, { sessionId: privateChat }),
      (client: Client) => client.query(api.sessions.history, { sessionId: privateChat }),
      (client: Client) => client.query(api.sessionVisibility.get, { sessionId: privateChat }),
      (client: Client) => client.query(api.sessions.attention, { sessionId: privateChat }),
    ]) {
      await expect(read(w.bob.client)).rejects.toThrow(code("not_found"));
    }
    const snapshot = await w.alice.client.query(api.sessions.snapshot, { sessionId: privateChat });
    expect(snapshot.session).toMatchObject({ title: PRIVATE_CHAT_TITLE, visibility: "private" });
    await expect(
      w.alice.client.query(api.sessions.history, { sessionId: privateChat }),
    ).resolves.toMatchObject({ events: [] });
  });

  test("the board shows the change a private chat's agent made, naming it only as an opaque id", async () => {
    const t = setup();
    const w = await world(t);
    const { privateChat } = w.sessions;
    const events = await w.bob.client.query(api.board.ticketEvents, { ticketId: w.ticketId });
    const byAgent = events.find((event) => event.kind === "status_changed");
    // The change is the ticket's, so a teammate sees it, attributed to the
    // person whose agent made it; the Session id stays opaque, and the id
    // resolves to nothing for them.
    expect(byAgent).toMatchObject({
      actor: { kind: "agent", userId: w.alice.userId, sessionId: privateChat },
      payload: { kind: "status_changed", from: "todo", to: "doing" },
    });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    await expect(
      w.bob.client.query(api.sessionVisibility.get, { sessionId: privateChat }),
    ).rejects.toThrow(code("not_found"));
  });

  test("the owner's Share opens the chat and its subagents in the listing, and only those", async () => {
    const t = setup();
    const w = await world(t);
    const { privateChat, privateHelper, ticketWork } = w.sessions;
    await w.alice.client.mutation(api.sessionVisibility.share, { sessionId: privateChat });

    expect(await listing(w.bob.client, { projectId: w.projectId })).toEqual(
      [privateChat, privateHelper, ticketWork].toSorted(),
    );
    // Shared means readable: the titles come with the rows now.
    const text = await listingText(w.bob.client, w.projectId);
    expect(text).toContain(PRIVATE_CHAT_TITLE);
    expect(text).toContain(PRIVATE_HELPER_TITLE);
    // The private Board Session was never part of that tree, so it stays out.
    expect(await listing(w.bob.client, { projectId: w.projectId, ticketId: w.ticketId })).toEqual([
      ticketWork,
    ]);
    expect(text).not.toContain(PRIVATE_BOARD_TITLE);
  });

  test("shareAll opens every private Session to a teammate, and turning it off closes them again", async () => {
    const t = setup();
    const w = await world(t);
    const { privateChat, privateHelper, privateBoardChat, ticketWork } = w.sessions;
    const all = [privateChat, privateHelper, privateBoardChat, ticketWork].toSorted();
    const stored = () =>
      t.run(async (ctx) =>
        ctx.db
          .query("sessions")
          .withIndex("by_uuid", (q) => q.eq("id", privateChat))
          .unique(),
      );
    const before = await stored();

    await w.alice.client.mutation(api.workspaces.setPolicy, {
      workspaceId: w.workspaceId,
      shareAll: true,
    });
    expect(await listing(w.bob.client, { projectId: w.projectId })).toEqual(all);
    expect(await listingText(w.bob.client, w.projectId)).toContain(PRIVATE_BOARD_TITLE);

    await w.alice.client.mutation(api.workspaces.setPolicy, {
      workspaceId: w.workspaceId,
      shareAll: false,
    });
    expect(await listing(w.bob.client, { projectId: w.projectId })).toEqual([ticketWork]);
    // The policy is read at read time: nothing was rewritten on the Session.
    expect(await stored()).toEqual(before);
  });
});
