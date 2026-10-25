/**
 * `runners.places`: the runner a visible Session lives on, for "Waiting for
 * <Mac>". Keyed by Session, so a teammate reaches a runner only through a
 * Session they can already see, never by enumerating anyone's runners.
 */
import { describe, expect, test } from "vite-plus/test";

import { newId, RUNNER_PLACES_MAX_SESSIONS } from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import {
  code,
  createTicket,
  seedSession,
  seedWorkspace,
  setup,
  signIn,
  type Tester,
} from "./board-helpers";

/** Alice and Bob in one Workspace, a ticket, and one Session of Alice's on her Mac. */
async function fixture(t: Tester) {
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const workspaceId = await seedWorkspace(t, [{ userId: alice.userId }, { userId: bob.userId }]);
  const projectId = newId("project");
  await alice.as.mutation(api.projects.create, {
    commandId: newId("command"),
    workspaceId,
    projectId,
    name: "Volli Code",
    origin: "github",
  });
  const { ticketId } = await createTicket(alice.as, projectId);
  const shared = await seedSession(t, { ticketId, projectId }, alice.userId);
  return { alice, bob, projectId, ticketId, shared };
}

async function patchSession(t: Tester, sessionId: string, patch: Record<string, unknown>) {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", sessionId))
      .unique();
    await ctx.db.patch(row!._id, patch);
  });
}

async function patchRunner(t: Tester, runnerId: string, patch: Record<string, unknown>) {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", runnerId))
      .unique();
    await ctx.db.patch(row!._id, patch);
  });
}

describe("runners.places", () => {
  test("the owner and a teammate see a shared Session's Place; only the owner owns it", async () => {
    const t = setup();
    const { alice, bob, shared } = await fixture(t);
    await patchRunner(t, shared.runnerId, {
      status: "asleep",
      statusChangedAt: 1_234,
      name: "hp-mac",
    });
    const expected = {
      id: shared.runnerId,
      name: "hp-mac",
      kind: "mac",
      status: "asleep",
      statusChangedAt: 1_234,
      statusReason: null,
    };
    expect(await alice.as.query(api.runners.places, { sessionIds: [shared.sessionId] })).toEqual([
      { sessionId: shared.sessionId, place: { ...expected, owned: true } },
    ]);
    expect(await bob.as.query(api.runners.places, { sessionIds: [shared.sessionId] })).toEqual([
      { sessionId: shared.sessionId, place: { ...expected, owned: false } },
    ]);
  });

  test("a private Session's Place is the owner's alone; refusals read as absent", async () => {
    const t = setup();
    const { alice, bob, shared, projectId, ticketId } = await fixture(t);
    const secret = await seedSession(t, { ticketId, projectId }, alice.userId);
    await patchSession(t, secret.sessionId, { visibility: "private", visibilityReason: "adhoc" });
    const deleted = await seedSession(t, { ticketId, projectId }, alice.userId);
    await patchSession(t, deleted.sessionId, { deletedAt: 5 });
    const unknown = newId("session");
    const ids = [secret.sessionId, deleted.sessionId, unknown, "not-a-uuid", shared.sessionId];

    const forBob = await bob.as.query(api.runners.places, { sessionIds: ids });
    expect(forBob.map((row) => row.place?.id ?? null)).toEqual([
      null,
      null,
      null,
      null,
      shared.runnerId,
    ]);
    const forAlice = await alice.as.query(api.runners.places, { sessionIds: ids });
    expect(forAlice.map((row) => row.place?.id ?? null)).toEqual([
      secret.runnerId,
      null,
      null,
      null,
      shared.runnerId,
    ]);
  });

  test("someone outside the Workspace learns nothing", async () => {
    const t = setup();
    const { shared } = await fixture(t);
    const carol = await signIn(t, "carol");
    expect(await carol.as.query(api.runners.places, { sessionIds: [shared.sessionId] })).toEqual([
      { sessionId: shared.sessionId, place: null },
    ]);
  });

  test("a removed runner is still answered, so its Sessions can say so", async () => {
    const t = setup();
    const { alice, shared } = await fixture(t);
    await patchRunner(t, shared.runnerId, { status: "revoked", statusReason: "removed" });
    const [row] = await alice.as.query(api.runners.places, { sessionIds: [shared.sessionId] });
    expect(row!.place).toMatchObject({ status: "revoked", statusReason: "removed" });
  });

  test("a Place whose runner row is missing reads as no Place", async () => {
    const t = setup();
    const { alice, shared } = await fixture(t);
    await patchSession(t, shared.sessionId, { placeRunnerId: newId("runner") });
    expect(await alice.as.query(api.runners.places, { sessionIds: [shared.sessionId] })).toEqual([
      { sessionId: shared.sessionId, place: null },
    ]);
  });

  test("ids are read once each and the read is bounded", async () => {
    const t = setup();
    const { alice, shared } = await fixture(t);
    const twice = await alice.as.query(api.runners.places, {
      sessionIds: [shared.sessionId, shared.sessionId],
    });
    expect(twice).toHaveLength(1);
    const many = Array.from({ length: RUNNER_PLACES_MAX_SESSIONS + 1 }, () => newId("session"));
    await expect(alice.as.query(api.runners.places, { sessionIds: many })).rejects.toThrow(
      code("invalid_request"),
    );
  });

  test("needs a signed-in person", async () => {
    const t = setup();
    await expect(t.query(api.runners.places, { sessionIds: [] })).rejects.toThrow(
      code("unauthenticated"),
    );
  });
});
