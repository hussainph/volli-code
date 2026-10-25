/**
 * Agent identity (convex-test): Agent tokens minted for a runner's claimed
 * Session, resolved to an `agent` Actor acting for the Session owner, fenced
 * by the claim, and kept out of everything person-only or runner-only.
 */
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  AGENT_TOKEN_AUDIENCE,
  AGENT_TOKEN_ISSUER,
  RUNNER_TOKEN_ISSUER,
  agentSubject,
  newId,
  runnerSubject,
  type RunnerId,
  type SessionId,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { seedTestWorld } from "../functions/lib/testWorld";
import {
  boardFixture,
  code,
  createTicket,
  projectEvents,
  seedRunner,
  seedSession,
  seedWorkspace,
  setup,
  signIn,
  ticketRow,
  type Tester,
} from "./board-helpers";
import { wire, writeSession } from "./sessionFixtures";

const command = () => newId("command");

function issuerKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    signingKey: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "k1" }),
    publicKey,
  };
}

function decodeJwt(jwt: string, publicKey: ReturnType<typeof createPublicKey>) {
  const [header, body, signature] = jwt.split(".");
  return {
    valid: verify(
      "sha256",
      Buffer.from(`${header}.${body}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    ),
    claims: JSON.parse(Buffer.from(body!, "base64url").toString()) as Record<string, unknown>,
  };
}

function asRunner(t: Tester, runnerId: string) {
  return t.withIdentity({
    issuer: RUNNER_TOKEN_ISSUER,
    subject: runnerSubject(runnerId as RunnerId),
    gen: 1,
  });
}

interface AgentClaims {
  own: string;
  rnr: string;
  gen: number;
  tkt?: string | null;
}

function asAgent(t: Tester, sessionId: string, claims: AgentClaims) {
  return t.withIdentity({
    issuer: AGENT_TOKEN_ISSUER,
    subject: agentSubject(sessionId as SessionId),
    ...claims,
  });
}

/** Alice, her project and ticket, and a Session on it her runner claims, with its agent. */
async function agentWorld(t: Tester) {
  const alice = await boardFixture(t);
  const ticket = await createTicket(alice.as, alice.projectId, { title: "Work" });
  const { sessionId, runnerId } = await seedSession(
    t,
    { ticketId: ticket.ticketId, projectId: alice.projectId },
    alice.userId,
  );
  const claims = { own: alice.userId, rnr: runnerId, gen: 1, tkt: ticket.ticketId };
  return {
    ...alice,
    ticketId: ticket.ticketId,
    sessionId,
    runnerId,
    claims,
    agent: asAgent(t, sessionId, claims),
  };
}

async function patchIntake(
  t: Tester,
  sessionId: string,
  patch: Partial<{ claim: { runnerId: string; generation: number }; state: "released" }>,
) {
  await t.run(async (ctx) => {
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    await ctx.db.patch(intake!._id, patch);
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function mintAs(as: Pick<Tester, "action">, sessionId: string) {
  return as.action(api.agentTokens.mint, { sessionId });
}

describe("agentTokens.mint", () => {
  let keys: ReturnType<typeof issuerKeys>;
  beforeEach(() => {
    keys = issuerKeys();
    vi.stubEnv("VOLLI_RUNNER_SIGNING_KEY", keys.signingKey);
  });

  test("signs a 15-minute token for one Session the runner claims, acting for its owner", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const grant = await asRunner(t, w.runnerId).action(api.agentTokens.mint, {
      sessionId: w.sessionId,
    });
    expect(grant.expiresAt - grant.serverTime).toBe(15 * 60_000);
    const jwt = decodeJwt(grant.token, keys.publicKey);
    expect(jwt.valid).toBe(true);
    expect(jwt.claims).toMatchObject({
      iss: AGENT_TOKEN_ISSUER,
      aud: AGENT_TOKEN_AUDIENCE,
      sub: `agent:${w.sessionId}`,
      own: w.userId,
      rnr: w.runnerId,
      gen: 1,
      tkt: w.ticketId,
    });
    expect((jwt.claims["exp"] as number) - (jwt.claims["iat"] as number)).toBe(15 * 60);
  });

  test("only a runner may mint, and only for a Session it holds for its own owner", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const mint = (as: Pick<Tester, "action">, sessionId: string = w.sessionId) =>
      mintAs(as, sessionId);

    await expect(mint(t)).rejects.toThrow(code("unauthenticated"));
    await expect(mint(w.as)).rejects.toThrow(code("not_a_runner"));
    // An agent cannot mint itself (or a sibling) a fresh token.
    await expect(mint(w.agent)).rejects.toThrow(code("not_a_runner"));

    const runner = asRunner(t, w.runnerId);
    await expect(mint(runner, newId("session"))).rejects.toThrow(code("unknown_session"));

    // Another of Alice's runners holds no claim on it.
    const other = await seedRunner(t, w.userId);
    await expect(mint(asRunner(t, other))).rejects.toThrow(code("not_claimed"));

    await patchIntake(t, w.sessionId, { state: "released" });
    await expect(mint(runner)).rejects.toThrow(code("not_claimed"));
  });

  test("a claim with no intake row yet is not claimed", async () => {
    const t = setup();
    const alice = await boardFixture(t);
    const ticket = await createTicket(alice.as, alice.projectId);
    const { sessionId, runnerId } = await seedSession(
      t,
      { ticketId: ticket.ticketId, projectId: alice.projectId },
      alice.userId,
      { intake: null },
    );
    await expect(asRunner(t, runnerId).action(api.agentTokens.mint, { sessionId })).rejects.toThrow(
      code("not_claimed"),
    );
  });

  test("refuses a Session of someone else, an owner who left, a removed runner, an unsigned deployment", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const runner = asRunner(t, w.runnerId);
    const mint = () => runner.action(api.agentTokens.mint, { sessionId: w.sessionId });

    // The Session is Bob's, though Alice's runner holds it.
    const bob = await signIn(t, "bob");
    await t.run(async (ctx) => {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.sessionId))
        .unique();
      await ctx.db.patch(session!._id, { ownerUserId: bob.userId });
    });
    await expect(mint()).rejects.toThrow(code("forbidden"));
    await t.run(async (ctx) => {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", w.sessionId))
        .unique();
      await ctx.db.patch(session!._id, { ownerUserId: w.userId });
    });
    await expect(mint()).resolves.toMatchObject({ token: expect.any(String) });

    // Alice left the Workspace the Session's project is in.
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", w.workspaceId).eq("userId", w.userId),
        )
        .unique();
      await ctx.db.patch(member!._id, { status: "left" });
    });
    await expect(mint()).rejects.toThrow(code("forbidden"));
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", w.workspaceId).eq("userId", w.userId),
        )
        .unique();
      await ctx.db.patch(member!._id, { status: "active" });
    });

    vi.stubEnv("VOLLI_RUNNER_SIGNING_KEY", "");
    await expect(mint()).rejects.toThrow(code("issuer_unconfigured"));
    vi.stubEnv("VOLLI_RUNNER_SIGNING_KEY", keys.signingKey);

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", w.runnerId))
        .unique();
      await ctx.db.patch(row!._id, { revokedAt: 1 });
    });
    await expect(mint()).rejects.toThrow(code("revoked"));
  });

  test("a Session whose project is gone has no workspace to act in", async () => {
    const t = setup();
    const w = await agentWorld(t);
    await t.run(async (ctx) => {
      const project = await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", w.projectId))
        .unique();
      await ctx.db.patch(project!._id, { deletedAt: 1 });
    });
    await expect(
      asRunner(t, w.runnerId).action(api.agentTokens.mint, { sessionId: w.sessionId }),
    ).rejects.toThrow(code("forbidden"));
  });

  test("a project in a deleted Workspace has no workspace to act in", async () => {
    const t = setup();
    const w = await agentWorld(t);
    await t.run(async (ctx) => {
      const workspace = await ctx.db
        .query("workspaces")
        .withIndex("by_uuid", (q) => q.eq("id", w.workspaceId))
        .unique();
      await ctx.db.patch(workspace!._id, { deletedAt: 1 });
    });
    await expect(
      asRunner(t, w.runnerId).action(api.agentTokens.mint, { sessionId: w.sessionId }),
    ).rejects.toThrow(code("forbidden"));
  });
});

describe("an agent caller", () => {
  test("writes the board as the agent Actor, acting with its owner's membership", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const actor = { kind: "agent", userId: w.userId, sessionId: w.sessionId, ticketId: w.ticketId };

    const created = await w.agent.mutation(api.board.createTicket, {
      commandId: command(),
      projectId: w.projectId,
      ticketId: newId("ticket"),
      status: "todo",
      title: "Found while working",
    });
    expect(created).toMatchObject({ key: "VC-2", receipt: { replayed: false } });
    expect((await ticketRow(t, created.ticketId))!.createdBy).toEqual(actor);

    await w.agent.mutation(api.board.updateTicket, {
      commandId: command(),
      ticketId: created.ticketId,
      priority: "high",
      addLabels: ["agent-found"],
    });
    await w.agent.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId: w.projectId,
      ticketIds: [w.ticketId],
      toStatus: "doing",
    });
    const comment = await w.agent.mutation(api.board.createComment, {
      commandId: command(),
      ticketId: w.ticketId,
      commentId: newId("comment"),
      body: "Halfway.",
    });
    await w.agent.mutation(api.board.createSignal, {
      commandId: command(),
      ticketId: w.ticketId,
      signalId: newId("signal"),
      kind: "review",
      verdict: "pass",
    });

    const events = await projectEvents(t, w.projectId);
    const byAgent = events.filter((event) => event.actor.kind === "agent");
    expect(byAgent.map((event) => event.kind)).toEqual([
      "created",
      "priority_changed",
      "labels_changed",
      "status_changed",
      "commented",
      "signaled",
    ]);
    for (const event of byAgent) expect(event.actor).toEqual(actor);
    const comments = await w.agent.query(api.board.comments, { ticketId: w.ticketId });
    expect(comments).toEqual([
      expect.objectContaining({ id: comment.commentId, author: actor, sessionId: w.sessionId }),
    ]);

    // The reads behind `board`, `ticket show|events`, `label list` and `project list`.
    expect(
      (await w.agent.query(api.board.roster, { projectId: w.projectId })).tickets,
    ).toHaveLength(2);
    await expect(
      w.agent.query(api.board.getTicket, { ticketId: w.ticketId }),
    ).resolves.toMatchObject({
      ticket: { id: w.ticketId, status: "doing" },
    });
    expect(
      (await w.agent.query(api.board.ticketEvents, { ticketId: w.ticketId })).length,
    ).toBeGreaterThan(0);
    await expect(w.agent.query(api.board.signals, { ticketId: w.ticketId })).resolves.toHaveLength(
      1,
    );
    await expect(
      w.agent.query(api.board.archivedTickets, {
        projectId: w.projectId,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).resolves.toMatchObject({ page: [] });
    await expect(
      w.agent.query(api.projects.get, { projectId: w.projectId }),
    ).resolves.toMatchObject({ id: w.projectId });
    await expect(
      w.agent.query(api.projects.list, { workspaceId: w.workspaceId }),
    ).resolves.toHaveLength(1);
  });

  test("its commandId is its own: the owner reusing it is a conflict, never a replay", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const intent = {
      commandId: command(),
      ticketId: w.ticketId,
      commentId: newId("comment"),
      body: "Once.",
    };
    await w.agent.mutation(api.board.createComment, intent);
    await expect(w.agent.mutation(api.board.createComment, intent)).resolves.toMatchObject({
      receipt: { replayed: true },
    });
    await expect(w.as.mutation(api.board.createComment, intent)).rejects.toThrow(
      code("command_conflict"),
    );
  });

  test("is fenced the moment its claim moves or ends, and revoked with its runner or owner", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const read = () => w.agent.query(api.board.roster, { projectId: w.projectId });
    await expect(read()).resolves.toBeTruthy();

    // A transfer to another runner bumps the claim.
    const other = await seedRunner(t, w.userId);
    await patchIntake(t, w.sessionId, { claim: { runnerId: other, generation: 2 } });
    await expect(read()).rejects.toThrow(code("fenced"));
    // Back on this runner but at a later generation: still the old token's end.
    await patchIntake(t, w.sessionId, { claim: { runnerId: w.runnerId, generation: 2 } });
    await expect(read()).rejects.toThrow(code("fenced"));
    await patchIntake(t, w.sessionId, { claim: { runnerId: w.runnerId, generation: 1 } });
    await expect(read()).resolves.toBeTruthy();
    await patchIntake(t, w.sessionId, { state: "released" });
    await expect(read()).rejects.toThrow(code("fenced"));
  });

  test("a removed runner, a closing account or a vanished Session end it", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const read = () => w.agent.query(api.board.roster, { projectId: w.projectId });
    const patchRow = async (table: "runners" | "users" | "sessions", id: string, patch: object) =>
      t.run(async (ctx) => {
        const row = await ctx.db
          .query(table)
          .withIndex("by_uuid", (q) => q.eq("id", id))
          .unique();
        await ctx.db.patch(row!._id, patch);
      });

    await patchRow("users", w.userId, { status: "deletion_pending" });
    await expect(read()).rejects.toThrow(code("revoked"));
    await patchRow("users", w.userId, { status: "active" });

    await patchRow("runners", w.runnerId, { revokedAt: 1 });
    await expect(read()).rejects.toThrow(code("revoked"));
    await patchRow("runners", w.runnerId, { revokedAt: null });

    await patchRow("sessions", w.sessionId, { deletedAt: 1 });
    await expect(read()).rejects.toThrow(code("not_found"));
  });

  test("a token whose claims do not match is refused", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const read = (agent: ReturnType<typeof asAgent>) =>
      agent.query(api.board.roster, { projectId: w.projectId });
    // Minted for another owner than the Session's.
    const bob = await signIn(t, "bob");
    await expect(read(asAgent(t, w.sessionId, { ...w.claims, own: bob.userId }))).rejects.toThrow(
      code("fenced"),
    );
    // A runner that is not the owner's own cannot vouch for it.
    const bobs = await seedRunner(t, bob.userId);
    await patchIntake(t, w.sessionId, { claim: { runnerId: bobs, generation: 1 } });
    await expect(read(asAgent(t, w.sessionId, { ...w.claims, rnr: bobs }))).rejects.toThrow(
      code("revoked"),
    );
    // Shapes the backend never signs.
    await expect(read(asAgent(t, w.sessionId, { ...w.claims, gen: -1 }))).rejects.toThrow(
      code("unauthenticated"),
    );
    await expect(
      read(
        t.withIdentity({
          issuer: AGENT_TOKEN_ISSUER,
          subject: `agent:${w.ticketId.slice(0, 8)}`,
          ...w.claims,
        }),
      ),
    ).rejects.toThrow(code("unauthenticated"));
  });

  test("acts with its owner's membership: an owner who left takes the agent's access too", async () => {
    const t = setup();
    const w = await agentWorld(t);
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", w.workspaceId).eq("userId", w.userId),
        )
        .unique();
      await ctx.db.patch(member!._id, { status: "suspended" });
    });
    await expect(w.agent.query(api.board.roster, { projectId: w.projectId })).rejects.toThrow(
      code("not_a_member"),
    );
  });

  test("person-only functions refuse it, runner functions refuse it, and it is never a viewer", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const notAPerson = code("not_a_person");
    await expect(w.agent.mutation(api.accounts.ensureViewer, {})).rejects.toThrow(notAPerson);
    await expect(w.agent.query(api.accounts.viewer, {})).rejects.toThrow(notAPerson);
    await expect(
      w.agent.mutation(api.projects.create, {
        commandId: command(),
        workspaceId: w.workspaceId,
        projectId: newId("project"),
        name: "Side",
        origin: "blank",
      }),
    ).rejects.toThrow(notAPerson);
    await expect(
      w.agent.mutation(api.projects.rename, {
        commandId: command(),
        projectId: w.projectId,
        name: "Renamed",
      }),
    ).rejects.toThrow(notAPerson);
    await expect(
      w.agent.mutation(api.board.archiveTicket, { commandId: command(), ticketId: w.ticketId }),
    ).rejects.toThrow(notAPerson);
    await expect(w.agent.query(api.workspaces.listMine, {})).rejects.toThrow(notAPerson);
    await expect(w.agent.query(api.runners.list, {})).rejects.toThrow(notAPerson);
    await expect(
      w.agent.query(api.activity.project, {
        projectId: w.projectId,
        page: { numItems: 5, cursor: null },
      }),
    ).rejects.toThrow(notAPerson);
    await expect(
      w.agent.mutation(api.runners.heartbeat, {
        bootId: "b",
        load: { activeSessions: 0, activeTurns: 0, queueDepth: 0, freeDiskMb: 1, freeMemMb: 1 },
      }),
    ).rejects.toThrow(code("not_a_runner"));
  });

  test("a runner token is not an agent's: board functions refuse it as not a person", async () => {
    const t = setup();
    const w = await agentWorld(t);
    await expect(
      asRunner(t, w.runnerId).query(api.board.roster, { projectId: w.projectId }),
    ).rejects.toThrow(code("not_a_person"));
    await expect(
      asRunner(t, w.runnerId).mutation(api.board.createComment, {
        commandId: command(),
        ticketId: w.ticketId,
        commentId: newId("comment"),
        body: "x",
      }),
    ).rejects.toThrow(code("not_a_person"));
  });
});

describe("projects.listForActor", () => {
  test("an agent sees its Session's Workspace; a person sees every Workspace they are in", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const elsewhere = await seedWorkspace(t, [{ userId: w.userId }]);
    await w.as.mutation(api.projects.create, {
      commandId: command(),
      workspaceId: elsewhere,
      projectId: newId("project"),
      name: "Side project",
      origin: "blank",
    });
    const gone = await seedWorkspace(t, [{ userId: w.userId }]);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaces")
        .withIndex("by_uuid", (q) => q.eq("id", gone))
        .unique();
      await ctx.db.patch(row!._id, { deletedAt: 1 });
    });
    const left = await seedWorkspace(t, [{ userId: w.userId, status: "left" }]);
    expect(left).toBeTruthy();

    const agents = await w.agent.query(api.projects.listForActor, {});
    expect(agents.projects.map((project) => project.name)).toEqual(["Volli Code"]);
    expect(agents.current).toBe(w.projectId);
    const persons = await w.as.query(api.projects.listForActor, {});
    expect(persons.projects.map((project) => project.name).toSorted()).toEqual([
      "Side project",
      "Volli Code",
    ]);
    expect(persons.current).toBeNull();
  });
});

describe("board.resolveTicketKey", () => {
  test("finds a key among the caller's Workspaces, and refuses a guess", async () => {
    const t = setup();
    const w = await agentWorld(t);
    await expect(w.as.query(api.board.resolveTicketKey, { key: "vc-1" })).resolves.toEqual({
      ticketId: w.ticketId,
      projectId: w.projectId,
      key: "VC-1",
    });
    await expect(w.as.query(api.board.resolveTicketKey, { key: "VC-99" })).rejects.toThrow(
      code("not_found"),
    );
    await expect(w.as.query(api.board.resolveTicketKey, { key: "not a key" })).rejects.toThrow(
      code("invalid_argument"),
    );
    // Someone else's Workspace is not searched.
    const bob = await signIn(t, "bob");
    await expect(bob.as.query(api.board.resolveTicketKey, { key: "VC-1" })).rejects.toThrow(
      code("not_found"),
    );

    // A second Workspace with the same prefix: ambiguous for the person, with the candidates.
    const elsewhere = await seedWorkspace(t, [{ userId: w.userId }]);
    const sideProject = newId("project");
    await w.as.mutation(api.projects.create, {
      commandId: command(),
      workspaceId: elsewhere,
      projectId: sideProject,
      name: "Volli Cloud",
      origin: "blank",
      ticketPrefix: "VC",
    });
    const side = await createTicket(w.as, sideProject, { title: "Elsewhere" });
    const refusal = await w.as.query(api.board.resolveTicketKey, { key: "VC-1" }).then(
      () => null,
      (error: { data: unknown }) => error.data,
    );
    expect(refusal).toMatchObject({
      code: "ambiguous_key",
      candidates: expect.arrayContaining([
        expect.objectContaining({ ticketId: w.ticketId, qualifiedKey: "volli-code/VC-1" }),
        expect.objectContaining({ ticketId: side.ticketId, qualifiedKey: "volli-cloud/VC-1" }),
      ]),
    });
    // Qualified by project name, or by Workspace slug.
    await expect(
      w.as.query(api.board.resolveTicketKey, { key: "volli-cloud/VC-1" }),
    ).resolves.toMatchObject({ ticketId: side.ticketId });
    const slug = await t.run(
      async (ctx) =>
        (await ctx.db
          .query("workspaces")
          .withIndex("by_uuid", (q) => q.eq("id", elsewhere))
          .unique())!.slug,
    );
    await expect(
      w.as.query(api.board.resolveTicketKey, { key: `${slug}/VC-1` }),
    ).resolves.toMatchObject({ ticketId: side.ticketId });
    await expect(w.as.query(api.board.resolveTicketKey, { key: "nowhere/VC-1" })).rejects.toThrow(
      code("not_found"),
    );
    // A qualifier with nothing left once normalised names no project.
    await expect(w.as.query(api.board.resolveTicketKey, { key: "--/VC-1" })).rejects.toThrow(
      code("invalid_argument"),
    );

    // The agent prefers its own Session's project.
    await expect(w.agent.query(api.board.resolveTicketKey, { key: "VC-1" })).resolves.toMatchObject(
      { ticketId: w.ticketId },
    );
  });

  test("an agent prefers its Session's Workspace when its project does not match", async () => {
    const t = setup();
    const w = await agentWorld(t);
    // Two more VC projects: one beside the Session's in its Workspace, one elsewhere.
    const sibling = newId("project");
    await t.run(async (ctx) => {
      const project = await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", w.projectId))
        .unique();
      await ctx.db.patch(project!._id, { ticketPrefix: "VCX" });
    });
    await w.as.mutation(api.projects.create, {
      commandId: command(),
      workspaceId: w.workspaceId,
      projectId: sibling,
      name: "Sibling",
      origin: "blank",
      ticketPrefix: "VC",
    });
    const near = await createTicket(w.as, sibling, { title: "Near" });
    const elsewhere = await seedWorkspace(t, [{ userId: w.userId }]);
    const far = newId("project");
    await w.as.mutation(api.projects.create, {
      commandId: command(),
      workspaceId: elsewhere,
      projectId: far,
      name: "Far",
      origin: "blank",
      ticketPrefix: "VC",
    });
    await createTicket(w.as, far, { title: "Far" });
    await expect(w.agent.query(api.board.resolveTicketKey, { key: "VC-1" })).resolves.toMatchObject(
      { ticketId: near.ticketId },
    );
  });
});

describe("ambiguous keys name each candidate alone", () => {
  test("by project name, else Workspace slug, else only by ticket id", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const elsewhere = await seedWorkspace(t, [{ userId: w.userId }]);
    // Same name and prefix in another Workspace, and a twin beside the first.
    for (const workspaceId of [elsewhere, w.workspaceId]) {
      const projectId = newId("project");
      await t.run(async (ctx) => {
        await ctx.db.insert("projects", {
          id: projectId,
          workspaceId,
          name: "Volli Code",
          description: "",
          iconKey: null,
          colorIndex: 0,
          ticketPrefix: "VC",
          origin: "migrated",
          shipBehaviour: "pr",
          customShipPrompt: null,
          coAuthorDefault: true,
          countsTowardCap: false,
          createdByUserId: w.userId,
          createdAt: 0,
          updatedAt: 0,
          archivedAt: null,
          deletedAt: null,
          purgeAfter: null,
        });
        await ctx.db.insert("projectCounters", { projectId, nextTicketNumber: 1, boardSeq: 0 });
      });
      await createTicket(w.as, projectId);
    }
    const refusal = await w.as.query(api.board.resolveTicketKey, { key: "VC-1" }).then(
      () => null,
      (error: { data: { candidates: { qualifiedKey: string | null }[] } }) => error.data,
    );
    const slug = await t.run(
      async (ctx) =>
        (await ctx.db
          .query("workspaces")
          .withIndex("by_uuid", (q) => q.eq("id", elsewhere))
          .unique())!.slug,
    );
    const keys = refusal!.candidates.map((candidate) => candidate.qualifiedKey);
    // The two in one Workspace share name and slug: only their ids tell them apart.
    expect(keys.toSorted()).toEqual([`${slug}/VC-1`, null, null].toSorted());
  });
});

describe("labels and label merges", () => {
  test("label list counts the board tickets wearing each live label", async () => {
    const t = setup();
    const w = await agentWorld(t);
    await createTicket(w.as, w.projectId, { labels: ["front-end", "api"] });
    await createTicket(w.as, w.projectId, { labels: ["frontend"] });
    const archived = await createTicket(w.as, w.projectId, { labels: ["api"] });
    await w.as.mutation(api.board.archiveTicket, {
      commandId: command(),
      ticketId: archived.ticketId,
    });
    const labels = await w.agent.query(api.board.labels, { projectId: w.projectId });
    expect(labels.map(({ name, tickets }) => [name, tickets])).toEqual(
      expect.arrayContaining([
        ["front-end", 1],
        ["frontend", 1],
        ["api", 1],
      ]),
    );
  });

  test("previews by default, then folds one label into another as the agent", async () => {
    const t = setup();
    const w = await agentWorld(t);
    const one = await createTicket(w.as, w.projectId, { labels: ["front-end"] });
    await createTicket(w.as, w.projectId, { labels: ["front-end", "frontend"] });
    const old = await createTicket(w.as, w.projectId, { labels: ["front-end"] });
    await w.as.mutation(api.board.archiveTicket, { commandId: command(), ticketId: old.ticketId });
    await createTicket(w.as, w.projectId, { labels: ["api"] });

    const preview = await w.agent.query(api.board.labelMergePreview, {
      projectId: w.projectId,
      from: "front-end",
      into: "frontend",
    });
    expect(preview).toMatchObject({ applied: false, from: "front-end", into: "frontend" });
    expect(preview.ticketCount).toBe(3);
    expect(preview.tickets.find((ticket) => ticket.ticketId === old.ticketId)).toMatchObject({
      archived: true,
    });
    // A preview writes nothing.
    expect((await projectEvents(t, w.projectId)).some((e) => e.kind === "label_merged")).toBe(
      false,
    );

    const merge = {
      commandId: command(),
      projectId: w.projectId,
      from: "front-end",
      into: "frontend",
    };
    const applied = await w.agent.mutation(api.board.mergeLabels, merge);
    expect(applied).toMatchObject({
      applied: true,
      from: "front-end",
      into: "frontend",
      receipt: { replayed: false },
    });
    await expect(w.agent.mutation(api.board.mergeLabels, merge)).resolves.toMatchObject({
      receipt: { replayed: true },
    });

    const merged = (await projectEvents(t, w.projectId)).filter((e) => e.kind === "label_merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.actor).toMatchObject({ kind: "agent", sessionId: w.sessionId });
    expect(merged[0]!.ticketId).toBeNull();

    // The retired name now resolves into the survivor, and the board wears it once.
    const live = await w.agent.query(api.board.labels, { projectId: w.projectId });
    expect(live.map((label) => label.name).toSorted()).toEqual(["api", "frontend"]);
    expect(live.find((label) => label.name === "frontend")!.tickets).toBe(2);
    await w.agent.mutation(api.board.updateTicket, {
      commandId: command(),
      ticketId: one.ticketId,
      addLabels: ["FRONT-END"],
    });
    const { labels } = await w.as.query(api.board.roster, { projectId: w.projectId });
    expect(labels.filter((label) => label.mergedIntoId === null)).toHaveLength(2);

    await expect(
      w.agent.mutation(api.board.mergeLabels, { ...merge, commandId: command() }),
    ).rejects.toThrow(code("invalid_argument"));
  });

  test("an archived project takes no merge", async () => {
    const t = setup();
    const w = await agentWorld(t);
    await createTicket(w.as, w.projectId, { labels: ["a", "b"] });
    await w.as.mutation(api.projects.archive, { commandId: command(), projectId: w.projectId });
    await expect(
      w.agent.mutation(api.board.mergeLabels, {
        commandId: command(),
        projectId: w.projectId,
        from: "a",
        into: "b",
      }),
    ).rejects.toThrow(code("project_archived"));
  });
});

describe("Sessions, read and commanded by an agent", () => {
  test("an agent reads its owner's Sessions and queues commands as the agent Actor", async () => {
    const t = setup();
    const alice = await signIn(t, "alice");
    const seeded = await t.run((ctx) =>
      seedTestWorld(ctx, { ownerUserId: alice.userId, runners: 2 }),
    );
    const runnerId = seeded.runnerIds[0]!;
    const { sessionId, events } = await writeSession({ projectId: seeded.projectId });
    await asRunner(t, runnerId).mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: events.map(wire),
    });
    const agent = asAgent(t, sessionId, { own: alice.userId, rnr: runnerId, gen: 1, tkt: null });

    await expect(agent.query(api.sessions.snapshot, { sessionId })).resolves.toMatchObject({
      session: { id: sessionId },
    });
    await expect(agent.query(api.sessions.history, { sessionId, limit: 2 })).resolves.toBeTruthy();
    const listed = await agent.query(api.sessions.list, {
      projectId: seeded.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(listed.page.map((row) => row.id)).toEqual([sessionId]);
    await expect(agent.query(api.sessions.attention, { sessionId })).resolves.toBeTruthy();

    const commandId = newId("command");
    await agent.mutation(api.sessions.command, {
      sessionId,
      commandId,
      intent: JSON.stringify({ kind: "session.retitle", title: "Renamed by its agent" }),
    });
    const job = await t.run((ctx) =>
      ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", commandId))
        .unique(),
    );
    expect(job).toMatchObject({
      createdBy: { kind: "agent", userId: alice.userId, sessionId, ticketId: null },
    });

    // A clean handoff to the other runner fences the old token at once.
    await t.mutation(internal.sessions.transferClaim, {
      sessionId,
      toRunnerId: seeded.runnerIds[1]!,
      headSequence: events.length,
    });
    await expect(agent.query(api.sessions.snapshot, { sessionId })).rejects.toThrow(code("fenced"));
  });
});
