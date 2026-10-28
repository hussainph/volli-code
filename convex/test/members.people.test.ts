/**
 * `members.people`: the attribution read.
 *
 * Every row of a Workspace (a Session's owner, a board event's actor, a
 * ticket's assignee) names a person by id. This read turns those ids into
 * names for anyone who can already see the rows, and it is the only place a
 * departed Member's name comes back: the roster (`members.list`) lists who is
 * here now. It carries attribution and nothing else, so a teammate learns a
 * name and a status, never an address.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vite-plus/test";

import { PREVIEW_ENROLLMENT_AGREEMENT_VERSION, newId } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

function setup() {
  return convexTest(schema, modules);
}

type T = ReturnType<typeof setup>;
type Client = ReturnType<T["withIdentity"]>;

const ISSUER = "https://issuer.test";

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

/** VC-936: the preview admits only allowlisted accounts, by verified email, and the sign-in accepts the current Preview Agreement. */
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

/**
 * A team Workspace (Acme) with one person in each state attribution must name:
 * Alice owns it, Bob is an admin, Carol is a member, Dave is suspended and Erin
 * was removed, so she is `left`. Olga is a signed-in outsider with a Workspace
 * of her own, where Nina is a member: a second team whose people must never
 * appear in Acme's answer.
 */
async function team(t: T) {
  const owner = await signIn(t, "Alice");
  const admin = await signIn(t, "Bob");
  const member = await signIn(t, "Carol");
  const suspended = await signIn(t, "Dave");
  const left = await signIn(t, "Erin");
  const outsider = await signIn(t, "Olga");
  const stranger = await signIn(t, "Nina");
  const workspaceId = newId("workspace");
  await owner.client.mutation(api.workspaces.create, { workspaceId, name: "Acme" });
  await addMember(owner.client, admin.client, workspaceId, "admin");
  for (const someone of [member, suspended, left]) {
    await addMember(owner.client, someone.client, workspaceId, "member");
  }
  await owner.client.mutation(api.members.suspend, { workspaceId, userId: suspended.userId });
  await owner.client.mutation(api.members.remove, { workspaceId, userId: left.userId });
  // Olga's own Workspace came with her first sign-in.
  const otherWorkspaceId = (await outsider.client.query(api.workspaces.listMine, {}))[0]!
    .workspaceId;
  await addMember(outsider.client, stranger.client, otherWorkspaceId, "member");
  return {
    workspaceId,
    otherWorkspaceId,
    people: { owner, admin, member, suspended, left, outsider, stranger },
    anonymous: t,
  };
}

type World = Awaited<ReturnType<typeof team>>;

function directory(world: World) {
  return [
    { userId: world.people.owner.userId, displayName: "Alice", status: "active" },
    { userId: world.people.admin.userId, displayName: "Bob", status: "active" },
    { userId: world.people.member.userId, displayName: "Carol", status: "active" },
    { userId: world.people.suspended.userId, displayName: "Dave", status: "suspended" },
    { userId: world.people.left.userId, displayName: "Erin", status: "left" },
  ].toSorted((left, right) => left.userId.localeCompare(right.userId));
}

describe("members.people", () => {
  test("names every current and departed Member once, with their status and nothing else", async () => {
    const t = setup();
    const world = await team(t);
    const read = await world.people.owner.client.query(api.members.people, {
      workspaceId: world.workspaceId,
    });
    // The caller knows itself without a second read.
    expect(read.viewerUserId).toBe(world.people.owner.userId);
    // One row per person, sorted by user id; `toEqual` also pins the fields:
    // attribution is an id, a name and a status, never an address or a role.
    expect(read.people).toEqual(directory(world));
    // The roster still lists only who is here now.
    const roster = await world.people.owner.client.query(api.members.list, {
      workspaceId: world.workspaceId,
    });
    expect(roster.map((row) => row.userId)).not.toContain(world.people.left.userId);
  });

  test("every active Member reads the same directory, and a Member who returns is listed once", async () => {
    const t = setup();
    const world = await team(t);
    const read = async (client: Client) =>
      await client.query(api.members.people, { workspaceId: world.workspaceId });

    const asAdmin = await read(world.people.admin.client);
    const asMember = await read(world.people.member.client);
    expect(asAdmin.people).toEqual(directory(world));
    expect(asMember.people).toEqual(directory(world));
    expect(asAdmin.viewerUserId).toBe(world.people.admin.userId);
    expect(asMember.viewerUserId).toBe(world.people.member.userId);

    // A departed Member can be invited back: one row, back to active.
    await addMember(
      world.people.owner.client,
      world.people.left.client,
      world.workspaceId,
      "member",
    );
    const returned = await read(world.people.owner.client);
    expect(returned.people).toHaveLength(5);
    expect(returned.people.filter((row) => row.userId === world.people.left.userId)).toEqual([
      { userId: world.people.left.userId, displayName: "Erin", status: "active" },
    ]);
  });

  test("refuses anyone who is not an active Member", async () => {
    const t = setup();
    const world = await team(t);
    const read = (client: Client | T) =>
      client.query(api.members.people, { workspaceId: world.workspaceId });
    for (const position of ["suspended", "left", "outsider"] as const) {
      await expect(read(world.people[position].client), position).rejects.toThrow(
        code("not_a_member"),
      );
    }
    await expect(read(world.anonymous)).rejects.toThrow(code("unauthenticated"));
    // A Workspace that does not exist is not_found; one you are not in is not_a_member.
    await expect(
      world.people.owner.client.query(api.members.people, { workspaceId: newId("workspace") }),
    ).rejects.toThrow(code("not_found"));
  });

  test("never carries another Workspace's people", async () => {
    const t = setup();
    const world = await team(t);
    const acme = await world.people.owner.client.query(api.members.people, {
      workspaceId: world.workspaceId,
    });
    const ids = acme.people.map((row) => row.userId);
    for (const outsiderId of [world.people.outsider.userId, world.people.stranger.userId]) {
      expect(ids).not.toContain(outsiderId);
    }

    const own = await world.people.outsider.client.query(api.members.people, {
      workspaceId: world.otherWorkspaceId,
    });
    expect(own.people.map((row) => [row.displayName, row.status])).toEqual(
      expect.arrayContaining([
        ["Olga", "active"],
        ["Nina", "active"],
      ]),
    );
    expect(own.people).toHaveLength(2);

    // Neither side can read the other's directory.
    await expect(
      world.people.stranger.client.query(api.members.people, {
        workspaceId: world.workspaceId,
      }),
    ).rejects.toThrow(code("not_a_member"));
    await expect(
      world.people.owner.client.query(api.members.people, {
        workspaceId: world.otherWorkspaceId,
      }),
    ).rejects.toThrow(code("not_a_member"));
  });
});
