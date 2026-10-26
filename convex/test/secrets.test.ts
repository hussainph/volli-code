import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  newId,
  parseRunnerSecretSet,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { ROOT_KEYS_VARIABLE } from "../functions/lib/sealing";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

type T = ReturnType<typeof convexTest>;
type Client = ReturnType<T["withIdentity"]>;

const ISSUER = "https://issuer.test";

function rootKey(kid: string): string {
  return `${kid}:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;
}

const K1 = rootKey("k1");
const K2 = rootKey("k2");

beforeEach(() => {
  vi.stubEnv(ROOT_KEYS_VARIABLE, K1);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

async function signIn(t: T, name: string) {
  const client = t.withIdentity({
    subject: `user:${name.toLowerCase()}`,
    issuer: ISSUER,
    name,
    email: `${name.toLowerCase()}@example.com`,
    emailVerified: true,
  });
  await t.mutation(internal.previewAccess.set, {
    kind: "email",
    value: `${name.toLowerCase()}@example.com`,
    enabled: true,
  });
  const { userId } = await client.mutation(api.accounts.ensureViewer, {
    acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  });
  return { client, userId };
}

async function addMember(inviter: Client, invitee: Client, workspaceId: string, role: string) {
  const { token } = await inviter.mutation(api.invites.create, {
    workspaceId,
    email: null,
    role: role as "member",
  });
  await invitee.mutation(api.invites.acceptLink, { token });
}

async function insertProject(t: T, workspaceId: string, createdByUserId: string) {
  const projectId = newId("project");
  await t.run(async (ctx) => {
    await ctx.db.insert("projects", {
      id: projectId,
      workspaceId,
      name: "Web",
      description: "",
      iconKey: null,
      colorIndex: 0,
      ticketPrefix: "WEB",
      origin: "github",
      shipBehaviour: "pr",
      customShipPrompt: null,
      coAuthorDefault: true,
      countsTowardCap: true,
      createdByUserId,
      createdAt: 0,
      updatedAt: 0,
      archivedAt: null,
      deletedAt: null,
      purgeAfter: null,
    });
  });
  return projectId;
}

async function insertRunner(t: T, ownerUserId: string, status: "online" | "revoked" = "online") {
  const runnerId = newId("runner");
  await t.run(async (ctx) => {
    await ctx.db.insert("runners", {
      id: runnerId,
      ownerUserId,
      kind: "mac",
      name: "mac",
      status,
      statusReason: null,
      statusChangedAt: 0,
      version: "0.3.0",
      platform: { os: "darwin", distro: null, kernel: null, arch: "arm64", glibc: null },
      capabilities: {},
      installMode: "app",
      linkedVia: "desktop",
      linkedAt: 0,
      autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
      update: null,
      revokedAt: null,
      createdAt: 0,
    });
  });
  return runnerId;
}

/** A Session owned by `ownerUserId`, claimed by `runnerId`. */
async function insertSession(t: T, projectId: string, ownerUserId: string, runnerId: string) {
  const sessionId = newId("session");
  await t.run(async (ctx) => {
    await ctx.db.insert("sessions", {
      id: sessionId,
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      ownerUserId,
      origin: {},
      title: null,
      visibility: "private",
      visibilityReason: "adhoc",
      sharedAt: null,
      status: "open",
      turnActive: false,
      lastTurnOutcome: null,
      signal: null,
      stopped: null,
      needsUser: false,
      attentionCount: 0,
      placeRunnerId: runnerId,
      model: null,
      usageTotals: {},
      createdAt: 0,
      lastActivityAt: 0,
      deletedAt: null,
      purgeAfter: null,
    });
    await ctx.db.insert("sessionIntake", {
      sessionId,
      claim: { runnerId, generation: 1 },
      acceptedThrough: 0,
      lastEventId: null,
      lastAcceptedAt: null,
      state: "active",
    });
  });
  return sessionId;
}

async function insertJob(
  t: T,
  runnerId: string,
  projectId: string,
  ownerUserId: string,
  status: "leased" | "queued" | "expired" = "leased",
  sessionId: string | null = null,
) {
  const jobId = newId("job");
  await t.run(async (ctx) => {
    await ctx.db.insert("runnerJobs", {
      id: jobId,
      runnerId,
      kind: "environment.run",
      projectId,
      sessionId,
      ticketId: null,
      workingCopyId: null,
      commandId: null,
      payload: {},
      priority: "normal",
      rank: 1,
      status: status === "expired" ? "leased" : status,
      availableAt: 0,
      lease:
        status === "queued"
          ? null
          : {
              bootId: "b",
              expiresAt: Date.now() + (status === "expired" ? -1 : 60_000),
              attempt: 1,
            },
      receipt: null,
      result: null,
      createdBy: { kind: "person", userId: ownerUserId },
      createdAt: 0,
      completedAt: null,
      expiresAt: null,
    });
  });
  return jobId;
}

/**
 * A team Workspace with one person in each position: the owner (Alice), an
 * admin (Bob), a member (Carol), a suspended member (Dave), a removed member
 * (Erin), a signed-in outsider (Olga) and an anonymous caller; one project.
 */
async function team(t: T) {
  const owner = await signIn(t, "Alice");
  const admin = await signIn(t, "Bob");
  const member = await signIn(t, "Carol");
  const suspended = await signIn(t, "Dave");
  const left = await signIn(t, "Erin");
  const outsider = await signIn(t, "Olga");
  const workspaceId = newId("workspace");
  await owner.client.mutation(api.workspaces.create, { workspaceId, name: "Acme" });
  await addMember(owner.client, admin.client, workspaceId, "admin");
  await addMember(owner.client, member.client, workspaceId, "member");
  await addMember(owner.client, suspended.client, workspaceId, "member");
  await addMember(owner.client, left.client, workspaceId, "member");
  await owner.client.mutation(api.members.suspend, { workspaceId, userId: suspended.userId });
  await owner.client.mutation(api.members.remove, { workspaceId, userId: left.userId });
  const projectId = await insertProject(t, workspaceId, owner.userId);
  return { t, workspaceId, projectId, owner, admin, member, suspended, left, outsider };
}

type Team = Awaited<ReturnType<typeof team>>;
type Position = "owner" | "admin" | "member" | "suspended" | "left" | "outsider" | "anonymous";
const POSITIONS: Position[] = [
  "owner",
  "admin",
  "member",
  "suspended",
  "left",
  "outsider",
  "anonymous",
];
const OUTSIDE = {
  suspended: "not_a_member",
  left: "not_a_member",
  outsider: "not_a_member",
  anonymous: "unauthenticated",
} as const;

function caller(world: Team, position: Position): Client | T {
  return position === "anonymous" ? world.t : world[position].client;
}

const SECRET_VALUE = "sk-live-4f2a9c0e7b1d83a6c5e0";

describe("authorization by role", () => {
  test.each(POSITIONS)("%s on Workspace secrets", async (position) => {
    const world = await team(convexTest(schema, modules));
    const c = caller(world, position);
    const target = { scope: "workspace" as const, workspaceId: world.workspaceId };
    const setIt = () =>
      c.action(api.secrets.set, { target, name: "API_KEY", kind: "secret", value: SECRET_VALUE });
    const listIt = () => c.query(api.secrets.listWorkspace, { workspaceId: world.workspaceId });
    if (position === "owner" || position === "admin") {
      await expect(setIt()).resolves.toMatchObject({ created: true, valueVersion: 1 });
      await expect(listIt()).resolves.toHaveLength(1);
    } else if (position === "member") {
      await expect(setIt()).rejects.toThrow(code("forbidden"));
      await expect(listIt()).resolves.toEqual([]);
      // A member reads what an admin set, and cannot change or remove it.
      const { secretId } = await world.admin.client.action(api.secrets.set, {
        target,
        name: "API_KEY",
        kind: "secret",
        value: SECRET_VALUE,
      });
      await expect(listIt()).resolves.toHaveLength(1);
      await expect(
        c.mutation(api.secrets.setExposure, { secretId, exposure: "setup" }),
      ).rejects.toThrow(code("forbidden"));
      await expect(c.mutation(api.secrets.remove, { secretId })).rejects.toThrow(code("forbidden"));
    } else {
      await expect(setIt()).rejects.toThrow(code(OUTSIDE[position]));
      await expect(listIt()).rejects.toThrow(code(OUTSIDE[position]));
    }
  });

  test.each(POSITIONS)("%s on project secrets", async (position) => {
    const world = await team(convexTest(schema, modules));
    const c = caller(world, position);
    const target = { scope: "project" as const, projectId: world.projectId };
    const setIt = () =>
      c.action(api.secrets.set, { target, name: "DATABASE_URL", kind: "secret", value: "pg://x" });
    const listIt = () => c.query(api.secrets.listProject, { projectId: world.projectId });
    if (position === "owner" || position === "admin" || position === "member") {
      const { secretId } = await setIt();
      await expect(listIt()).resolves.toHaveLength(1);
      await expect(
        c.mutation(api.secrets.setExposure, { secretId, exposure: "setup" }),
      ).resolves.toEqual({ changed: true });
      await expect(c.mutation(api.secrets.remove, { secretId })).resolves.toEqual({
        removed: true,
      });
    } else {
      await expect(setIt()).rejects.toThrow(code(OUTSIDE[position]));
      await expect(listIt()).rejects.toThrow(code(OUTSIDE[position]));
    }
  });

  test("personal secrets are the person's alone", async () => {
    const world = await team(convexTest(schema, modules));
    const carol = world.member.client;
    const { secretId } = await carol.action(api.secrets.set, {
      target: { scope: "personal", projectId: null },
      name: "GITHUB_TOKEN",
      kind: "secret",
      value: SECRET_VALUE,
    });
    const here = await carol.action(api.secrets.set, {
      target: { scope: "personal", projectId: world.projectId },
      name: "GITHUB_TOKEN",
      kind: "secret",
      value: `${SECRET_VALUE}-here`,
    });
    await expect(carol.query(api.secrets.listPersonal, {})).resolves.toEqual([
      expect.objectContaining({ secretId, projectId: null }),
      expect.objectContaining({ secretId: here.secretId, projectId: world.projectId }),
    ]);
    await expect(world.owner.client.query(api.secrets.listPersonal, {})).resolves.toEqual([]);
    // The owner's project view never lists a teammate's personal secrets.
    await expect(
      world.owner.client.query(api.secrets.listProject, { projectId: world.projectId }),
    ).resolves.toEqual([]);
    for (const id of [secretId, here.secretId]) {
      await expect(
        world.owner.client.mutation(api.secrets.remove, { secretId: id }),
      ).rejects.toThrow(code("not_found"));
    }
    // Personal-for-a-project needs membership of the project's Workspace.
    await expect(
      world.outsider.client.action(api.secrets.set, {
        target: { scope: "personal", projectId: world.projectId },
        name: "GITHUB_TOKEN",
        kind: "env",
        value: "x",
      }),
    ).rejects.toThrow(code("not_a_member"));
    // A personal secret leaves no row in the Workspace's audit trail.
    const audit = await world.t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("targetKind"), "secret"))
        .collect(),
    );
    expect(audit.map((row) => row.workspaceId)).toEqual([null, null]);
  });

  test("an unknown or deleted project or Workspace is not_found", async () => {
    const world = await team(convexTest(schema, modules));
    const c = world.owner.client;
    await expect(c.query(api.secrets.listProject, { projectId: newId("project") })).rejects.toThrow(
      code("not_found"),
    );
    await expect(
      c.query(api.secrets.listWorkspace, { workspaceId: newId("workspace") }),
    ).rejects.toThrow(code("not_found"));
    await expect(c.mutation(api.secrets.remove, { secretId: newId("secret") })).rejects.toThrow(
      code("not_found"),
    );
    await expect(c.mutation(api.secrets.remove, { secretId: "nope" })).rejects.toThrow(
      code("invalid_argument"),
    );
    await world.t.run(async (ctx) => {
      const ws = await ctx.db
        .query("workspaces")
        .filter((q) => q.eq(q.field("id"), world.workspaceId))
        .unique();
      await ctx.db.patch(ws!._id, { deletedAt: 1 });
    });
    await expect(c.query(api.secrets.listProject, { projectId: world.projectId })).rejects.toThrow(
      code("not_found"),
    );
  });
});

describe("values never come back to a client", () => {
  test("queries return metadata and last4; env vars show their value", async () => {
    const world = await team(convexTest(schema, modules));
    const c = world.owner.client;
    await c.action(api.secrets.set, {
      target: { scope: "project", projectId: world.projectId },
      name: "STRIPE_KEY",
      kind: "secret",
      value: SECRET_VALUE,
    });
    await c.action(api.secrets.set, {
      target: { scope: "project", projectId: world.projectId },
      name: "NODE_ENV",
      kind: "env",
      value: "development",
    });
    const listed = await c.query(api.secrets.listProject, { projectId: world.projectId });
    expect(listed).toEqual([
      expect.objectContaining({ name: "NODE_ENV", kind: "env", value: "development", last4: null }),
      expect.objectContaining({
        name: "STRIPE_KEY",
        kind: "secret",
        value: null,
        last4: "c5e0",
        exposure: "session",
        scope: "project",
        layer: "project",
        createdBy: { kind: "person", userId: world.owner.userId },
        overriddenBy: null,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(SECRET_VALUE);
    for (const key of Object.keys(listed[1]!)) expect(key).not.toMatch(/sealed|cipher|plain/);
    // At rest the value is ciphertext under a data key, which is itself only stored wrapped.
    const [row] = await world.t.run((ctx) =>
      ctx.db
        .query("secrets")
        .filter((q) => q.eq(q.field("name"), "STRIPE_KEY"))
        .collect(),
    );
    expect(row!.plain).toBeNull();
    const ciphertext = Buffer.from(row!.sealed!.ciphertext);
    expect(ciphertext.includes(Buffer.from(SECRET_VALUE))).toBe(false);
    const keys = await world.t.run((ctx) => ctx.db.query("secretKeys").collect());
    expect(keys).toEqual([
      expect.objectContaining({
        id: row!.sealed!.kid,
        owner: `w:${world.workspaceId}`,
        rootKid: "k1",
      }),
    ]);
  });

  test("every change is audited, never with a value", async () => {
    const world = await team(convexTest(schema, modules));
    const c = world.admin.client;
    const target = { scope: "workspace" as const, workspaceId: world.workspaceId };
    const first = await c.action(api.secrets.set, {
      target,
      name: "NPM_TOKEN",
      kind: "secret",
      value: SECRET_VALUE,
      exposure: "setup",
    });
    const second = await c.action(api.secrets.set, {
      target,
      name: "NPM_TOKEN",
      kind: "secret",
      value: `${SECRET_VALUE}-2`,
    });
    expect(second).toEqual({ secretId: first.secretId, valueVersion: 2, created: false });
    await expect(
      c.mutation(api.secrets.setExposure, { secretId: first.secretId, exposure: "setup" }),
    ).resolves.toEqual({ changed: false });
    await c.mutation(api.secrets.setExposure, { secretId: first.secretId, exposure: "session" });
    await c.mutation(api.secrets.remove, { secretId: first.secretId });
    const audit = await world.t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("targetKind"), "secret"))
        .collect(),
    );
    expect(audit.map((row) => [row.kind, row.detail.exposure, row.detail.valueVersion])).toEqual([
      ["secret.created", "setup", 1],
      ["secret.updated", "setup", 2],
      ["secret.exposure_changed", "session", 2],
      ["secret.removed", "session", 2],
    ]);
    for (const row of audit) {
      expect(row).toMatchObject({
        workspaceId: world.workspaceId,
        actor: { kind: "person", userId: world.admin.userId },
        targetId: first.secretId,
      });
      expect(JSON.stringify(row)).not.toContain(SECRET_VALUE);
    }
  });

  test("names and values are checked", async () => {
    const world = await team(convexTest(schema, modules));
    const c = world.owner.client;
    const target = { scope: "project" as const, projectId: world.projectId };
    for (const name of ["PATH", "LD_PRELOAD", "VOLLI_TOKEN", "lower", "1X"]) {
      await expect(
        c.action(api.secrets.set, { target, name, kind: "env", value: "x" }),
      ).rejects.toThrow(code("invalid_argument"));
    }
    for (const value of ["", "a\0b", "x".repeat(32 * 1024 + 1)]) {
      await expect(
        c.action(api.secrets.set, { target, name: "OK", kind: "secret", value }),
      ).rejects.toThrow(code("invalid_argument"));
    }
    await expect(
      c.action(api.secrets.set, {
        target: { scope: "project", projectId: "not-a-uuid" },
        name: "OK",
        kind: "env",
        value: "x",
      }),
    ).rejects.toThrow(code("invalid_argument"));
  });

  test("without a root key, env vars work and sealed secrets are unavailable", async () => {
    const world = await team(convexTest(schema, modules));
    vi.stubEnv(ROOT_KEYS_VARIABLE, "");
    const c = world.owner.client;
    const target = { scope: "project" as const, projectId: world.projectId };
    await expect(
      c.action(api.secrets.set, { target, name: "TOKEN", kind: "secret", value: "x" }),
    ).rejects.toThrow(code("secrets_unavailable"));
    await expect(
      c.action(api.secrets.set, { target, name: "NODE_ENV", kind: "env", value: "test" }),
    ).resolves.toMatchObject({ created: true });
    for (const [variable, problem] of [
      ["k1:c2hvcnQ=", /the key for k1 is not 32 bytes/],
      ["k1:%%%", /the key for k1 is not base64/],
      ["no-colon", /each entry is kid:base64key/],
      ["Bad Kid:c2hvcnQ=", /each entry is kid:base64key/],
      [`${K1},${K1}`, /kid k1 appears twice/],
    ] as const) {
      vi.stubEnv(ROOT_KEYS_VARIABLE, variable);
      const error = await c
        .action(api.secrets.set, { target, name: "TOKEN", kind: "secret", value: "x" })
        .catch((caught: unknown) => caught);
      expect(error).toEqual(code("secrets_unavailable"));
      expect(String((error as { data: { message: string } }).data.message)).toMatch(problem);
      // The message names the problem, never the key.
      expect(JSON.stringify((error as { data: unknown }).data)).not.toContain(K1.slice(3));
    }
  });
});

function setSecret(
  who: Client,
  target:
    | { scope: "workspace"; workspaceId: string }
    | { scope: "project"; projectId: string }
    | { scope: "personal"; projectId: string | null },
  name: string,
  value: string,
  extra: { kind?: "env" | "secret"; exposure?: "setup" | "session" } = {},
) {
  return who.action(api.secrets.set, {
    target,
    name,
    value,
    kind: extra.kind ?? "secret",
    ...(extra.exposure === undefined ? {} : { exposure: extra.exposure }),
  });
}

function values(set: { entries: readonly { name: string; value: string }[] }) {
  return Object.fromEntries(set.entries.map((entry) => [entry.name, entry.value]));
}

describe("delivery to a runner", () => {
  /** Carol's Session on Carol's Mac, with secrets at every level. */
  async function stocked() {
    const world = await team(convexTest(schema, modules));
    const { t, workspaceId, projectId } = world;
    const alice = world.owner.client;
    const carol = world.member.client;
    await setSecret(alice, { scope: "workspace", workspaceId }, "TOKEN", "workspace-token");
    await setSecret(alice, { scope: "workspace", workspaceId }, "REGION", "eu", { kind: "env" });
    await setSecret(alice, { scope: "project", projectId }, "TOKEN", "project-token");
    await setSecret(alice, { scope: "project", projectId }, "NPM_TOKEN", "npm-token", {
      exposure: "setup",
    });
    await setSecret(carol, { scope: "personal", projectId: null }, "TOKEN", "carol-token");
    await setSecret(carol, { scope: "personal", projectId }, "OVERRIDE", "carol-here", {
      exposure: "setup",
    });
    await setSecret(alice, { scope: "project", projectId }, "OVERRIDE", "project-override");
    const runnerId = await insertRunner(t, world.member.userId);
    const sessionId = await insertSession(t, projectId, world.member.userId, runnerId);
    return { ...world, runnerId, sessionId };
  }

  test("precedence personal-for-project > personal > project > workspace, then exposure", async () => {
    const world = await stocked();
    const claim = { kind: "session" as const, sessionId: world.sessionId };
    const session = await world.t.action(internal.secretsDelivery.deliver, {
      runnerId: world.runnerId,
      claim,
      purpose: "session",
    });
    expect(parseRunnerSecretSet(session)).toEqual(session);
    // Carol's setup-only override hides the project's OVERRIDE from her Session's tools.
    expect(values(session)).toEqual({ REGION: "eu", TOKEN: "carol-token" });
    const setup = await world.t.action(internal.secretsDelivery.deliver, {
      runnerId: world.runnerId,
      claim,
      purpose: "setup",
    });
    expect(values(setup)).toEqual({
      NPM_TOKEN: "npm-token",
      OVERRIDE: "carol-here",
      REGION: "eu",
      TOKEN: "carol-token",
    });
    expect(setup.entries.map((entry) => entry.kind)).toEqual(["secret", "secret", "env", "secret"]);
    // The project view tells Carol what overrides what.
    const listed = await world.member.client.query(api.secrets.listProject, {
      projectId: world.projectId,
    });
    expect(listed.map((row) => [row.name, row.layer, row.overriddenBy])).toEqual([
      ["NPM_TOKEN", "project", null],
      ["OVERRIDE", "personal_project", null],
      ["OVERRIDE", "project", "personal_project"],
      ["REGION", "workspace", null],
      ["TOKEN", "personal", null],
      ["TOKEN", "project", "personal"],
      ["TOKEN", "workspace", "personal"],
    ]);
  });

  test("another owner's Session gets the shared levels, never Carol's personal ones", async () => {
    const world = await stocked();
    const bobRunner = await insertRunner(world.t, world.admin.userId);
    const bobSession = await insertSession(world.t, world.projectId, world.admin.userId, bobRunner);
    const set = await world.t.action(internal.secretsDelivery.deliver, {
      runnerId: bobRunner,
      claim: { kind: "session", sessionId: bobSession },
      purpose: "session",
    });
    expect(values(set)).toEqual({
      OVERRIDE: "project-override",
      REGION: "eu",
      TOKEN: "project-token",
    });
  });

  test("records use, at most hourly", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const world = await stocked();
    const deliver = () =>
      world.t.action(internal.secretsDelivery.deliver, {
        runnerId: world.runnerId,
        claim: { kind: "session", sessionId: world.sessionId },
        purpose: "session",
      });
    const usedAt = async () =>
      Object.fromEntries(
        (await world.t.run((ctx) => ctx.db.query("secrets").collect())).map((row) => [
          `${row.scope}:${row.name}`,
          row.lastUsedAt,
        ]),
      );
    await deliver();
    const first = await usedAt();
    expect(first["personal:TOKEN"]).toEqual(expect.any(Number));
    expect(first["project:TOKEN"]).toBeNull();
    vi.advanceTimersByTime(60_000);
    await deliver();
    expect(await usedAt()).toEqual(first);
    vi.advanceTimersByTime(60 * 60 * 1000);
    await deliver();
    expect((await usedAt())["personal:TOKEN"]).toBeGreaterThan(first["personal:TOKEN"]!);
  });

  test("a leased job gets the runner owner's set; a queued one nothing", async () => {
    const world = await stocked();
    const leased = await insertJob(world.t, world.runnerId, world.projectId, world.member.userId);
    const set = await world.t.action(internal.secretsDelivery.deliver, {
      runnerId: world.runnerId,
      claim: { kind: "job", jobId: leased },
      purpose: "setup",
    });
    expect(values(set)).toMatchObject({ TOKEN: "carol-token", NPM_TOKEN: "npm-token" });
    const queued = await insertJob(
      world.t,
      world.runnerId,
      world.projectId,
      world.member.userId,
      "queued",
    );
    await expect(
      world.t.action(internal.secretsDelivery.deliver, {
        runnerId: world.runnerId,
        claim: { kind: "job", jobId: queued },
        purpose: "setup",
      }),
    ).rejects.toThrow(code("not_claimed"));
  });

  test("refuses a runner without the claim, someone else's runner, a revoked runner and a departed owner", async () => {
    const world = await stocked();
    const deliver = (runnerId: string, sessionId = world.sessionId) =>
      world.t.action(internal.secretsDelivery.deliver, {
        runnerId,
        claim: { kind: "session", sessionId },
        purpose: "session",
      });
    const otherCarolRunner = await insertRunner(world.t, world.member.userId);
    await expect(deliver(otherCarolRunner)).rejects.toThrow(code("not_claimed"));
    await expect(deliver(newId("runner"))).rejects.toThrow(code("not_found"));
    await expect(deliver(world.runnerId, newId("session"))).rejects.toThrow(code("not_claimed"));
    // A Session of Carol's claimed by Bob's runner: a runner only runs its owner's work.
    const bobRunner = await insertRunner(world.t, world.admin.userId);
    const misplaced = await insertSession(world.t, world.projectId, world.member.userId, bobRunner);
    await expect(deliver(bobRunner, misplaced)).rejects.toThrow(code("not_your_runner"));
    const revoked = await insertRunner(world.t, world.member.userId, "revoked");
    await expect(deliver(revoked)).rejects.toThrow(code("runner_revoked"));
    await world.owner.client.mutation(api.members.suspend, {
      workspaceId: world.workspaceId,
      userId: world.member.userId,
    });
    await expect(deliver(world.runnerId)).rejects.toThrow(code("not_a_member"));
  });

  test("the owner's opt-out on a runner withholds the whole set", async () => {
    const world = await stocked();
    await world.t.run((ctx) =>
      ctx.db.insert("runnerPrefs", {
        runnerId: world.runnerId,
        runSetup: true,
        injectSecrets: false,
      }),
    );
    const set = await world.t.action(internal.secretsDelivery.deliver, {
      runnerId: world.runnerId,
      claim: { kind: "session", sessionId: world.sessionId },
      purpose: "setup",
    });
    expect(set).toMatchObject({ withheld: "runner_opt_out", entries: [] });
  });

  test("a ciphertext moved onto another row does not open", async () => {
    const world = await stocked();
    await world.t.run(async (ctx) => {
      const rows = await ctx.db.query("secrets").collect();
      const workspaceToken = rows.find((r) => r.scope === "workspace" && r.name === "TOKEN")!;
      const carolToken = rows.find((r) => r.scope === "personal" && r.name === "TOKEN")!;
      // Even under a valid key for the target owner, the binding refuses it.
      await ctx.db.patch(carolToken._id, { sealed: workspaceToken.sealed });
    });
    await expect(
      world.t.action(internal.secretsDelivery.deliver, {
        runnerId: world.runnerId,
        claim: { kind: "session", sessionId: world.sessionId },
        purpose: "session",
      }),
    ).rejects.toThrow(code("secret_unreadable"));
  });

  test("an env-only set needs no root key", async () => {
    const world = await team(convexTest(schema, modules));
    await world.owner.client.action(api.secrets.set, {
      target: { scope: "project", projectId: world.projectId },
      name: "NODE_ENV",
      kind: "env",
      value: "test",
    });
    const runnerId = await insertRunner(world.t, world.owner.userId);
    const sessionId = await insertSession(world.t, world.projectId, world.owner.userId, runnerId);
    vi.stubEnv(ROOT_KEYS_VARIABLE, "");
    const set = await world.t.action(internal.secretsDelivery.deliver, {
      runnerId,
      claim: { kind: "session", sessionId },
      purpose: "session",
    });
    expect(values(set)).toEqual({ NODE_ENV: "test" });
    const empty = await world.t.action(internal.secretsDelivery.deliver, {
      runnerId,
      claim: { kind: "session", sessionId },
      purpose: "session",
    });
    expect(empty.withheld).toBeNull();
  });
});

describe("root key rotation", () => {
  test("rewrap moves every data key to the current root key; values still open", async () => {
    const world = await team(convexTest(schema, modules));
    await world.owner.client.action(api.secrets.set, {
      target: { scope: "project", projectId: world.projectId },
      name: "TOKEN",
      kind: "secret",
      value: SECRET_VALUE,
    });
    await world.owner.client.action(api.secrets.set, {
      target: { scope: "personal", projectId: null },
      name: "MINE",
      kind: "secret",
      value: "mine",
    });
    vi.stubEnv(ROOT_KEYS_VARIABLE, `${K2},${K1}`);
    await expect(world.t.action(internal.secretKeys.rewrap, {})).resolves.toEqual({
      rewrapped: 2,
      more: false,
    });
    const keys = await world.t.run((ctx) => ctx.db.query("secretKeys").collect());
    expect(keys.map((key) => key.rootKid)).toEqual(["k2", "k2"]);
    // The old root key can go now.
    vi.stubEnv(ROOT_KEYS_VARIABLE, K2);
    const runnerId = await insertRunner(world.t, world.owner.userId);
    const sessionId = await insertSession(world.t, world.projectId, world.owner.userId, runnerId);
    const set = await world.t.action(internal.secretsDelivery.deliver, {
      runnerId,
      claim: { kind: "session", sessionId },
      purpose: "session",
    });
    expect(values(set)).toEqual({ MINE: "mine", TOKEN: SECRET_VALUE });
    // A later write reuses the re-wrapped Workspace key.
    await world.owner.client.action(api.secrets.set, {
      target: { scope: "workspace", workspaceId: world.workspaceId },
      name: "OTHER",
      kind: "secret",
      value: "other",
    });
    expect(await world.t.run((ctx) => ctx.db.query("secretKeys").collect())).toHaveLength(2);
    // Without the key a data key was wrapped under, nothing opens.
    vi.stubEnv(ROOT_KEYS_VARIABLE, rootKey("k3"));
    await expect(
      world.t.action(internal.secretsDelivery.deliver, {
        runnerId,
        claim: { kind: "session", sessionId },
        purpose: "session",
      }),
    ).rejects.toThrow(code("secret_unreadable"));
  });
});

describe("the write half refuses a stale plan", () => {
  test("a second data key for one owner, or a row id that changed, is a conflict", async () => {
    const world = await team(convexTest(schema, modules));
    const c = world.owner.client;
    const target = { scope: "project" as const, projectId: world.projectId };
    const { secretId } = await c.action(api.secrets.set, {
      target,
      name: "TOKEN",
      kind: "secret",
      value: "one",
    });
    const [key] = await world.t.run((ctx) => ctx.db.query("secretKeys").collect());
    const base = {
      target,
      name: "TOKEN",
      kind: "secret" as const,
      exposure: null,
      plain: null,
      last4: null,
    };
    const newKeyId = newId("secretKey");
    await expect(
      c.mutation(internal.secrets.write, {
        ...base,
        secretId,
        sealed: { kid: newKeyId, ciphertext: new ArrayBuffer(8) },
        newKey: {
          id: newKeyId,
          owner: `w:${world.workspaceId}`,
          rootKid: "k1",
          wrapped: new ArrayBuffer(8),
        },
      }),
    ).rejects.toThrow(code("conflict"));
    await expect(
      c.mutation(internal.secrets.write, {
        ...base,
        secretId: newId("secret"),
        sealed: { kid: key!.id, ciphertext: new ArrayBuffer(8) },
        newKey: null,
      }),
    ).rejects.toThrow(code("conflict"));
    await expect(
      c.mutation(internal.secrets.write, {
        ...base,
        name: "OTHER",
        secretId,
        sealed: { kid: key!.id, ciphertext: new ArrayBuffer(8) },
        newKey: null,
      }),
    ).rejects.toThrow(code("conflict"));
    // A personal secret cannot be sealed under the Workspace's key.
    await expect(
      c.mutation(internal.secrets.write, {
        ...base,
        target: { scope: "personal", projectId: null },
        secretId: newId("secret"),
        sealed: { kid: key!.id, ciphertext: new ArrayBuffer(8) },
        newKey: null,
      }),
    ).rejects.toThrow(code("conflict"));
  });
});

describe("review follow-ups", () => {
  test("names that steer someone else's processes are refused for team secrets", async () => {
    const world = await team(convexTest(schema, modules));
    const target = { scope: "project" as const, projectId: world.projectId };
    for (const name of ["HTTPS_PROXY", "SSL_CERT_FILE", "GIT_EDITOR", "CC"]) {
      await expect(
        world.member.client.action(api.secrets.set, { target, name, kind: "env", value: "x" }),
      ).rejects.toThrow(code("invalid_argument"));
    }
  });

  test("a scope is bounded in bytes", async () => {
    const world = await team(convexTest(schema, modules));
    const c = world.owner.client;
    const target = { scope: "project" as const, projectId: world.projectId };
    const big = "x".repeat(30 * 1024);
    await c.action(api.secrets.set, { target, name: "A", kind: "secret", value: big });
    await c.action(api.secrets.set, { target, name: "B", kind: "env", value: big });
    await expect(
      c.action(api.secrets.set, { target, name: "C", kind: "secret", value: big }),
    ).rejects.toThrow(code("limit_exceeded"));
    // Replacing a value counts the new one, not both.
    await expect(
      c.action(api.secrets.set, { target, name: "A", kind: "secret", value: `${big}y` }),
    ).resolves.toMatchObject({ valueVersion: 2 });
  });

  test("a scope is bounded in count", async () => {
    const world = await team(convexTest(schema, modules));
    const c = world.owner.client;
    const target = { scope: "project" as const, projectId: world.projectId };
    await world.t.run(async (ctx) => {
      for (let i = 0; i < 100; i += 1) {
        await ctx.db.insert("secrets", {
          id: newId("secret"),
          scope: "project",
          scopeKey: `p:${world.projectId}`,
          name: `K${i}`,
          kind: "env",
          plain: "1",
          sealed: null,
          exposure: "session",
          requestedBySessionId: null,
          last4: null,
          createdBy: { kind: "person", userId: world.owner.userId },
          updatedAt: 0,
          lastUsedAt: null,
          valueVersion: 1,
        });
      }
    });
    await expect(
      c.action(api.secrets.set, { target, name: "ONE_MORE", kind: "env", value: "x" }),
    ).rejects.toThrow(code("limit_exceeded"));
    await expect(
      c.action(api.secrets.set, { target, name: "K1", kind: "env", value: "2" }),
    ).resolves.toMatchObject({ valueVersion: 2 });
  });

  test("a person can still remove their own project secrets after leaving", async () => {
    const world = await team(convexTest(schema, modules));
    const carol = world.member.client;
    const { secretId } = await carol.action(api.secrets.set, {
      target: { scope: "personal", projectId: world.projectId },
      name: "MINE",
      kind: "secret",
      value: "mine",
    });
    await carol.mutation(api.members.leave, { workspaceId: world.workspaceId });
    await expect(carol.query(api.secrets.listPersonal, {})).resolves.toEqual([
      expect.objectContaining({ secretId, projectId: world.projectId }),
    ]);
    await expect(
      carol.mutation(api.secrets.setExposure, { secretId, exposure: "setup" }),
    ).resolves.toEqual({ changed: true });
    await expect(carol.mutation(api.secrets.remove, { secretId })).resolves.toEqual({
      removed: true,
    });
    // Setting one there again needs membership.
    await expect(
      carol.action(api.secrets.set, {
        target: { scope: "personal", projectId: world.projectId },
        name: "MINE",
        kind: "env",
        value: "x",
      }),
    ).rejects.toThrow(code("not_a_member"));
  });

  test("an admin demoted between plan and write cannot write", async () => {
    const world = await team(convexTest(schema, modules));
    await world.owner.client.mutation(api.members.setRole, {
      workspaceId: world.workspaceId,
      userId: world.admin.userId,
      role: "member",
    });
    await expect(
      world.admin.client.mutation(internal.secrets.write, {
        target: { scope: "workspace", workspaceId: world.workspaceId },
        name: "TOKEN",
        kind: "env",
        exposure: null,
        secretId: newId("secret"),
        plain: "x",
        sealed: null,
        last4: null,
        newKey: null,
      }),
    ).rejects.toThrow(code("forbidden"));
  });

  test("a project that moves Workspace keeps its values and takes the new Workspace's level", async () => {
    const world = await team(convexTest(schema, modules));
    const alice = world.owner.client;
    await alice.action(api.secrets.set, {
      target: { scope: "project", projectId: world.projectId },
      name: "TOKEN",
      kind: "secret",
      value: "project-token",
    });
    await alice.action(api.secrets.set, {
      target: { scope: "workspace", workspaceId: world.workspaceId },
      name: "OLD_ONLY",
      kind: "secret",
      value: "old",
    });
    const other = newId("workspace");
    await alice.mutation(api.workspaces.create, { workspaceId: other, name: "Other" });
    await alice.action(api.secrets.set, {
      target: { scope: "workspace", workspaceId: other },
      name: "NEW_ONLY",
      kind: "secret",
      value: "new",
    });
    await world.t.run(async (ctx) => {
      const project = await ctx.db
        .query("projects")
        .filter((q) => q.eq(q.field("id"), world.projectId))
        .unique();
      await ctx.db.patch(project!._id, { workspaceId: other });
    });
    const runnerId = await insertRunner(world.t, world.owner.userId);
    const sessionId = await insertSession(world.t, world.projectId, world.owner.userId, runnerId);
    const set = await world.t.action(internal.secretsDelivery.deliver, {
      runnerId,
      claim: { kind: "session", sessionId },
      purpose: "session",
    });
    expect(values(set)).toEqual({ NEW_ONLY: "new", TOKEN: "project-token" });
    // A new value is sealed under the new Workspace's key.
    await alice.action(api.secrets.set, {
      target: { scope: "project", projectId: world.projectId },
      name: "TOKEN",
      kind: "secret",
      value: "project-token-2",
    });
    const owner = await world.t.run(async (ctx) => {
      const row = await ctx.db
        .query("secrets")
        .filter((q) => q.eq(q.field("scopeKey"), `p:${world.projectId}`))
        .unique();
      const key = await ctx.db
        .query("secretKeys")
        .filter((q) => q.eq(q.field("id"), row!.sealed!.kid))
        .unique();
      return key!.owner;
    });
    expect(owner).toBe(`w:${other}`);
  });

  test("a job carrying a Session needs that Session's owner; an expired lease is no claim", async () => {
    const world = await team(convexTest(schema, modules));
    const carolRunner = await insertRunner(world.t, world.member.userId);
    const bobRunner = await insertRunner(world.t, world.admin.userId);
    const bobSession = await insertSession(world.t, world.projectId, world.admin.userId, bobRunner);
    const deliver = (runnerId: string, jobId: string) =>
      world.t.action(internal.secretsDelivery.deliver, {
        runnerId,
        claim: { kind: "job", jobId },
        purpose: "setup",
      });
    const misplaced = await insertJob(
      world.t,
      carolRunner,
      world.projectId,
      world.member.userId,
      "leased",
      bobSession,
    );
    await expect(deliver(carolRunner, misplaced)).rejects.toThrow(code("not_your_runner"));
    const expired = await insertJob(
      world.t,
      carolRunner,
      world.projectId,
      world.member.userId,
      "expired",
    );
    await expect(deliver(carolRunner, expired)).rejects.toThrow(code("not_claimed"));
    const own = await insertJob(
      world.t,
      bobRunner,
      world.projectId,
      world.admin.userId,
      "leased",
      bobSession,
    );
    await expect(deliver(bobRunner, own)).resolves.toMatchObject({ entries: [] });
  });
});
