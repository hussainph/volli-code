/**
 * Git on a runner with no folder of the person's: the remote a Mac's checkout
 * reports, the remote `runnerContext` hands a runner, and
 * `POST /runner/github-token` against a fake GitHub (`github-fake.ts`).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { newId, RUNNER_GITHUB_TOKEN_PATH } from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { seedTestRunner } from "../functions/lib/testWorld";
import { identity, seedSession, type Tester } from "./board-helpers";
import { installFakeGithub, SITE, type FakeGithub } from "./github-fake";
import { asRunner, clearMembership, runnerWorld } from "./runnerContextFixtures";

let github: FakeGithub;

beforeEach(async () => {
  github = await installFakeGithub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const DANA = { id: 501, login: "dana", name: "Dana Doe" };

type World = Awaited<ReturnType<typeof runnerWorld>>;

/** Connects `as` to the fake GitHub account through the real browser round trip. */
async function connectGithub(t: Tester, as: ReturnType<Tester["withIdentity"]>) {
  if (!github.users.has(DANA.id)) github.addUser(DANA);
  const { url } = await as.action(api.github.beginConnect, { flowId: newId("githubFlow") });
  const { code, state } = github.authorize(url, DANA.id);
  await t.fetch(`/github/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`);
  const confirmed = await t.fetch("/github/oauth/callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE },
    body: new URLSearchParams({ code, state }).toString(),
  });
  expect(confirmed.status).toBeLessThan(400);
}

function askToken(
  caller: Pick<Tester, "fetch">,
  body: unknown,
  contentType = "application/json",
): Promise<Response> {
  return caller.fetch(RUNNER_GITHUB_TOKEN_PATH, {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

async function refusal(response: Response) {
  return { status: response.status, ...((await response.json()) as { error: object }).error };
}

/** A Session of alice's on the world's ticket, claimed by a fresh runner of alice's. */
async function claimedSession(world: World, intake: "active" | "released" | null = "active") {
  const { sessionId, runnerId } = await seedSession(
    world.t,
    { ticketId: world.ticketId, projectId: world.projectId },
    world.alice.userId,
    { intake },
  );
  return { sessionId, runnerId, runner: asRunner(world.t, runnerId) };
}

async function seedJob(
  world: World,
  fields: {
    runnerId: string;
    sessionId?: string | null;
    status?: "queued" | "leased";
    expiresAt?: number;
    projectId?: string;
  },
) {
  const id = newId("job");
  await world.t.run(async (ctx) => {
    await ctx.db.insert("runnerJobs", {
      id,
      runnerId: fields.runnerId,
      kind: "workingCopy.materialize",
      projectId: fields.projectId ?? world.projectId,
      sessionId: fields.sessionId ?? null,
      ticketId: world.ticketId,
      workingCopyId: null,
      commandId: null,
      payload: { ticketId: world.ticketId },
      priority: "normal",
      rank: 1,
      status: fields.status ?? "leased",
      availableAt: 0,
      lease:
        (fields.status ?? "leased") === "leased"
          ? { bootId: "boot", expiresAt: fields.expiresAt ?? Date.now() + 60_000, attempt: 1 }
          : null,
      receipt: null,
      result: null,
      createdBy: { kind: "person", userId: world.alice.userId },
      createdAt: 0,
      completedAt: null,
      expiresAt: null,
    });
  });
  return id;
}

const report = (world: World, fields: Record<string, unknown>) =>
  world.runner.mutation(api.projectCheckouts.report, {
    projectId: world.projectId,
    projectRepoId: world.projectRepoId,
    kind: "main" as const,
    headBranch: "main",
    headSha: "a".repeat(40),
    ...fields,
  });
const remote = async (world: World) =>
  (await world.runner.query(api.runnerContext.forProject, { projectId: world.projectId }))
    .primaryRepo.remoteUrl;

describe("the recorded remote", () => {
  test("a main checkout's origin becomes the folder repository's remote, normalized", async () => {
    const world = await runnerWorld({ repo: false });
    expect(await remote(world)).toBeNull();
    // The deployment's GitHub host (GITHUB_WEB_URL) takes the canonical https form.
    await report(world, { remoteUrl: "git@github.test:acme/app.git" });
    expect(await remote(world)).toBe("https://github.test/acme/app.git");
    // The first remote stays: a member's fork origin re-points nobody's runner.
    await world.memberRunner.mutation(api.projectCheckouts.report, {
      projectId: world.projectId,
      projectRepoId: world.projectRepoId,
      kind: "main",
      headBranch: "main",
      remoteUrl: "https://github.test/bob/app-fork.git",
    });
    expect(await remote(world)).toBe("https://github.test/acme/app.git");
    const rows = await world.t.run((ctx) => ctx.db.query("projectRepos").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.remoteUrl).toBe("https://github.test/acme/app.git");
    const context = await world.runner.query(api.runnerContext.forSession, {
      sessionId: newId("session"),
      projectId: world.projectId,
      ticketId: world.ticketId,
    });
    expect(context.primaryRepo.remoteUrl).toBe("https://github.test/acme/app.git");
  });

  test("absent, null, unclonable and managed-clone remotes record nothing", async () => {
    const world = await runnerWorld();
    for (const fields of [
      {},
      { remoteUrl: null },
      { remoteUrl: "/Users/alice/src/app.git" },
      { remoteUrl: "file:///srv/app.git" },
      { remoteUrl: "ext::sh -c id" },
      { remoteUrl: "http://169.254.169.254/latest" },
      { kind: "managed_clone", remoteUrl: "https://elsewhere.example.com/x.git" },
    ]) {
      await report(world, fields);
      expect(await remote(world)).toBeNull();
    }
    await report(world, { remoteUrl: "https://alice:hunter2@git.example.com/acme/app.git" });
    expect(await remote(world)).toBe("https://git.example.com/acme/app.git");
  });

  test("a GitHub repository's remote derives from its owner and name, never a report", async () => {
    const world = await runnerWorld();
    await world.t.run(async (ctx) => {
      const row = await ctx.db
        .query("projectRepos")
        .withIndex("by_uuid", (q) => q.eq("id", world.projectRepoId))
        .unique();
      await ctx.db.patch(row!._id, { provider: "github", owner: "acme", name: "app" });
    });
    await report(world, { remoteUrl: "https://git.example.com/other.git" });
    expect(await remote(world)).toBe("https://github.test/acme/app.git");
    const rows = await world.t.run((ctx) => ctx.db.query("projectRepos").collect());
    expect(rows[0]!.remoteUrl).toBeUndefined();
  });
});

describe("POST /runner/github-token", () => {
  test("a claimed Session's runner gets its owner's token, host and identity, never a refresh token", async () => {
    const world = await runnerWorld();
    await connectGithub(world.t, world.alice.as);
    const { sessionId, runner } = await claimedSession(world);
    const response = await askToken(runner, { sessionId, projectRepoId: world.projectRepoId });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const grant = (await response.json()) as Record<string, unknown>;
    expect(grant).toEqual({
      token: github.tokensOf(DANA.id)[0],
      useUntil: expect.any(Number),
      host: "github.test",
      login: "dana",
      identity: { name: "Dana Doe", email: "501+dana@users.noreply.github.com" },
    });
    expect(Object.keys(grant).toSorted()).toEqual(
      ["host", "identity", "login", "token", "useUntil"].toSorted(),
    );
  });

  test("a leased job's runner gets the token; the default folder repository is accepted", async () => {
    const world = await runnerWorld({ repo: false });
    await connectGithub(world.t, world.alice.as);
    const jobId = await seedJob(world, { runnerId: world.runnerId });
    const response = await askToken(world.runner, { jobId, projectRepoId: world.projectId });
    expect(response.status).toBe(200);
  });

  test("a Session this runner is starting under a leased job, not yet accepted, is claimed", async () => {
    const world = await runnerWorld();
    await connectGithub(world.t, world.alice.as);
    const sessionId = newId("session");
    const body = { sessionId, projectRepoId: world.projectRepoId };
    expect(await refusal(await askToken(world.runner, body))).toMatchObject({
      status: 403,
      code: "not_claimed",
    });
    await seedJob(world, { runnerId: world.runnerId, sessionId });
    expect((await askToken(world.runner, body)).status).toBe(200);
    // Another runner of the same owner holds no lease for it.
    expect((await askToken(world.nextRunner, body)).status).toBe(403);
  });

  test("a claim this runner does not hold is refused", async () => {
    const world = await runnerWorld();
    await connectGithub(world.t, world.alice.as);
    const held = await claimedSession(world);
    const body = { sessionId: held.sessionId, projectRepoId: world.projectRepoId };
    expect(await refusal(await askToken(world.runner, body))).toMatchObject({
      status: 403,
      code: "not_claimed",
    });
    const released = await claimedSession(world, "released");
    expect(
      (await askToken(released.runner, { ...body, sessionId: released.sessionId })).status,
    ).toBe(403);
    for (const job of [
      { status: "queued" as const },
      { expiresAt: Date.now() - 1 },
      { runnerId: world.runnerIds[1]! },
    ]) {
      const jobId = await seedJob(world, { runnerId: world.runnerId, ...job });
      expect(
        await refusal(await askToken(world.runner, { jobId, projectRepoId: world.projectRepoId })),
      ).toMatchObject({ status: 403, code: "not_claimed" });
    }
    expect(
      (await askToken(world.runner, { jobId: newId("job"), projectRepoId: world.projectRepoId }))
        .status,
    ).toBe(403);
  });

  test("another owner's Session is refused even when this runner holds its claim", async () => {
    const world = await runnerWorld();
    await connectGithub(world.t, world.alice.as);
    const { sessionId } = await seedSession(
      world.t,
      { ticketId: world.ticketId, projectId: world.projectId },
      world.bob.userId,
    );
    await world.t.run(async (ctx) => {
      const intake = await ctx.db
        .query("sessionIntake")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique();
      await ctx.db.patch(intake!._id, { claim: { runnerId: world.runnerId, generation: 1 } });
    });
    expect(
      await refusal(
        await askToken(world.runner, { sessionId, projectRepoId: world.projectRepoId }),
      ),
    ).toMatchObject({ status: 403, code: "not_your_runner" });
  });

  test("a job whose Session is deleted or in another project is refused", async () => {
    const world = await runnerWorld();
    await connectGithub(world.t, world.alice.as);
    const { sessionId } = await claimedSession(world);
    const otherProject = await seedJob(world, {
      runnerId: world.runnerId,
      sessionId,
      projectId: newId("project"),
    });
    expect(
      await refusal(
        await askToken(world.runner, { jobId: otherProject, projectRepoId: world.projectRepoId }),
      ),
    ).toMatchObject({ code: "not_claimed" });
    const jobId = await seedJob(world, { runnerId: world.runnerId, sessionId });
    await world.t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", sessionId))
        .unique();
      await ctx.db.patch(row!._id, { deletedAt: 1 });
    });
    expect(
      await refusal(await askToken(world.runner, { jobId, projectRepoId: world.projectRepoId })),
    ).toMatchObject({ status: 404, code: "not_found" });
  });

  test("a repository outside the project, and a lapsed membership, are refused", async () => {
    const world = await runnerWorld();
    await connectGithub(world.t, world.alice.as);
    const { sessionId, runner } = await claimedSession(world);
    expect(
      await refusal(await askToken(runner, { sessionId, projectRepoId: newId("projectRepo") })),
    ).toMatchObject({ status: 400, code: "invalid_repo" });
    await clearMembership(world.t, world.workspaceId, world.alice.userId);
    expect(
      await refusal(await askToken(runner, { sessionId, projectRepoId: world.projectRepoId })),
    ).toMatchObject({ status: 404, code: "not_found" });
  });

  test("no GitHub connection, or one needing a reconnect, says so", async () => {
    const world = await runnerWorld();
    const { sessionId, runner } = await claimedSession(world);
    const body = { sessionId, projectRepoId: world.projectRepoId };
    expect(await refusal(await askToken(runner, body))).toMatchObject({
      status: 409,
      code: "github_not_connected",
      resetAt: null,
    });
    await connectGithub(world.t, world.alice.as);
    await world.t.run(async (ctx) => {
      const row = await ctx.db.query("githubConnections").first();
      await ctx.db.patch(row!._id, { status: "needs_reconnect" });
    });
    expect(await refusal(await askToken(runner, body))).toMatchObject({
      status: 409,
      code: "github_needs_reconnect",
    });
  });

  test("a due token is refreshed once; GitHub down during it is unavailable", async () => {
    const world = await runnerWorld();
    await connectGithub(world.t, world.alice.as);
    const { sessionId, runner } = await claimedSession(world);
    const body = { sessionId, projectRepoId: world.projectRepoId };
    await world.t.run(async (ctx) => {
      const row = await ctx.db.query("githubConnections").first();
      await ctx.db.patch(row!._id, { accessExpiresAt: Date.now() + 60_000 });
    });
    github.down = /login\/oauth\/access_token/u;
    expect(await refusal(await askToken(runner, body))).toMatchObject({
      status: 503,
      code: "github_unavailable",
    });
    github.down = null;
    const response = await askToken(runner, body);
    expect(response.status).toBe(200);
    expect(github.refreshCalls).toBe(1);
    expect(((await response.json()) as { token: string }).token).toBe(github.tokensOf(DANA.id)[0]);
  });

  test("only a runner, with a JSON body naming one claim, is answered", async () => {
    const world = await runnerWorld();
    const { sessionId } = await claimedSession(world);
    const body = { sessionId, projectRepoId: world.projectRepoId };
    expect(await refusal(await askToken(world.t, body))).toMatchObject({
      status: 401,
      code: "unauthenticated",
    });
    expect(
      await refusal(await askToken(world.t.withIdentity(identity("alice")), body)),
    ).toMatchObject({ status: 403, code: "not_a_runner" });
    expect(
      await refusal(await askToken(world.runner, { projectRepoId: world.projectRepoId })),
    ).toMatchObject({ status: 400, code: "invalid_request" });
    expect((await askToken(world.runner, body, "text/plain")).status).toBe(400);
    const revoked = await world.t.run((ctx) => seedTestRunner(ctx, world.alice.userId, "gone"));
    await world.t.run(async (ctx) => {
      const row = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", revoked))
        .unique();
      await ctx.db.patch(row!._id, { revokedAt: 1 });
    });
    expect(await refusal(await askToken(asRunner(world.t, revoked), body))).toMatchObject({
      status: 403,
      code: "revoked",
    });
  });
});
