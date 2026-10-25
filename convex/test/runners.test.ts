import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  RUNNER_HTTP_PATHS,
  RUNNER_INSTALL_TOKEN_TTL_MS,
  RUNNER_LINK_REQUEST_TTL_MS,
  RUNNER_OFFLINE_AFTER_MS,
  RUNNER_TOKEN_AUDIENCE,
  RUNNER_TOKEN_ISSUER,
  newId,
  parseRunnerDeviceLinkPoll,
  parseRunnerDeviceLinkStart,
  parseRunnerLinkGrant,
  parseRunnerTokenGrant,
  readRunnerHttpError,
  runnerSubject,
  secretHash,
  type RunnerCapabilityReport,
  type RunnerHostFacts,
  type RunnerId,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import {
  EXPIRED_LINK_ROW_RETENTION_MS,
  LINK_ATTEMPT_MAX_FAILURES,
  LINK_ATTEMPT_WINDOW_MS,
  RUNNER_EVENT_RETENTION_MS,
  SWEEP_PAGE_SIZE,
} from "../functions/runners";
import { mintUserCode } from "../functions/lib/runnerSecrets";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

const ALICE = { subject: "user:alice", issuer: "https://issuer.test" };
const BOB = { subject: "user:bob", issuer: "https://issuer.test" };

const LINUX_HOST: RunnerHostFacts = {
  hostname: "hetzner-1.example.com",
  platform: { os: "linux", distro: "debian 12", kernel: "6.1.0", arch: "x64", glibc: "2.36" },
  installMode: "system",
};
const MAC_HOST: RunnerHostFacts = {
  hostname: "Alices-MacBook-Pro.local",
  platform: { os: "darwin", distro: null, kernel: "24.1.0", arch: "arm64", glibc: null },
  installMode: "app",
};

const REPORT: RunnerCapabilityReport = {
  version: "0.3.0",
  platform: LINUX_HOST.platform,
  installMode: "system",
  capabilities: {
    v: 1,
    nodeVersion: "24.18.0",
    cpuCount: 8,
    memTotalMb: 16_384,
    git: { version: "2.43.0" },
    docker: false,
    terminals: "available",
    browser: { state: "unavailable", reason: "not installed" },
    maxConcurrentSessions: 4,
    tools: [],
  },
  localCredentials: [{ providerId: "anthropic", kind: "subscription", expiresAt: null }],
};

const LOAD = {
  activeSessions: 0,
  activeTurns: 0,
  queueDepth: 0,
  freeDiskMb: 10_000,
  freeMemMb: 8_000,
};

function setup() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

async function signIn(t: T, identity = ALICE): Promise<string> {
  return (await t.withIdentity(identity).mutation(api.accounts.ensureViewer, {})).userId;
}

function asRunner(t: T, runnerId: string, gen: number | null = 1) {
  return t.withIdentity({
    issuer: RUNNER_TOKEN_ISSUER,
    subject: runnerSubject(runnerId as RunnerId),
    ...(gen === null ? {} : { gen }),
  });
}

async function post(
  t: Pick<T, "fetch">,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function linkLinux(t: T, identity = ALICE, name: string | null = null) {
  const { installToken } = await t
    .withIdentity(identity)
    .action(api.runners.createInstallToken, { nameHint: null, defaultWorkspaceId: null });
  const { status, body } = await post(t, RUNNER_HTTP_PATHS.link, {
    installToken,
    host: LINUX_HOST,
    name,
  });
  expect(status).toBe(200);
  return parseRunnerLinkGrant(body);
}

async function rows(t: T, runnerId: string) {
  return t.run(async (ctx) => ({
    runner: await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", runnerId))
      .unique(),
    credentials: await ctx.db
      .query("runnerCredentials")
      .withIndex("by_runner", (q) => q.eq("runnerId", runnerId))
      .unique(),
    presence: await ctx.db
      .query("runnerPresence")
      .withIndex("by_runner", (q) => q.eq("runnerId", runnerId))
      .unique(),
    events: await ctx.db
      .query("runnerEvents")
      .withIndex("by_runner", (q) => q.eq("runnerId", runnerId))
      .collect(),
    localCredentials: await ctx.db
      .query("runnerLocalCredentials")
      .withIndex("by_runner", (q) => q.eq("runnerId", runnerId))
      .collect(),
  }));
}

function issuerKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    signingKey: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "k1" }),
    publicKey,
  };
}

function decodeJwt(jwt: string, publicKey: ReturnType<typeof createPublicKey>) {
  const [header, body, signature] = jwt.split(".");
  const valid = verify(
    "sha256",
    Buffer.from(`${header}.${body}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature!, "base64url"),
  );
  return {
    valid,
    header: JSON.parse(Buffer.from(header!, "base64url").toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(body!, "base64url").toString()) as Record<string, unknown>,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("install-token linking", () => {
  test("a token minted in Settings links one box, once, as its creator's runner", async () => {
    const t = setup();
    const alice = await signIn(t);
    const asAlice = t.withIdentity(ALICE);
    const minted = await asAlice.action(api.runners.createInstallToken, {
      nameHint: "Build Box",
      defaultWorkspaceId: null,
    });
    expect(minted.installToken).toMatch(/^vrt_[A-Za-z0-9_-]{43}$/);
    await expect(
      asAlice.query(api.runners.installTokenStatus, { installTokenId: minted.installTokenId }),
    ).resolves.toEqual({ state: "waiting", expiresAt: minted.expiresAt, runner: null });

    const stored = await t.run((ctx) => ctx.db.query("runnerInstallTokens").collect());
    expect(stored).toEqual([
      expect.objectContaining({
        tokenHash: secretHash(minted.installToken),
        createdByUserId: alice,
        nameHint: "build-box",
      }),
    ]);
    expect(JSON.stringify(stored)).not.toContain(minted.installToken);

    const linked = await post(t, RUNNER_HTTP_PATHS.link, {
      installToken: minted.installToken,
      host: LINUX_HOST,
      name: null,
    });
    expect(linked.status).toBe(200);
    const grant = parseRunnerLinkGrant(linked.body);
    expect(grant).toMatchObject({ name: "build-box", generation: 1 });
    expect(grant.credential).toMatch(/^vrc_/);

    const { runner, credentials, events } = await rows(t, grant.runnerId);
    expect(runner).toMatchObject({
      ownerUserId: alice,
      kind: "linux",
      status: "offline",
      linkedVia: "install_token",
      installMode: "system",
      platform: LINUX_HOST.platform,
    });
    expect(credentials).toMatchObject({
      currentHash: secretHash(grant.credential),
      previousHash: null,
      generation: 1,
    });
    expect(events.map((event) => event.kind)).toEqual(["linked"]);
    await expect(
      asAlice.query(api.runners.installTokenStatus, { installTokenId: minted.installTokenId }),
    ).resolves.toEqual({
      state: "used",
      expiresAt: minted.expiresAt,
      runner: { id: grant.runnerId, name: "build-box", status: "offline" },
    });

    const again = await post(t, RUNNER_HTTP_PATHS.link, {
      installToken: minted.installToken,
      host: LINUX_HOST,
      name: null,
    });
    expect(again.status).toBe(401);
    expect(readRunnerHttpError(again.body)?.code).toBe("invalid_install_token");
  });

  test("expired, revoked and unknown tokens, and tokens of a deleted account, link nothing", async () => {
    const t = setup();
    const asAlice = t.withIdentity(ALICE);
    const alice = await signIn(t);
    const mint = () =>
      asAlice.action(api.runners.createInstallToken, { nameHint: null, defaultWorkspaceId: null });
    const tryLink = (installToken: string) =>
      post(t, RUNNER_HTTP_PATHS.link, { installToken, host: LINUX_HOST, name: null });

    const revoked = await mint();
    await asAlice.mutation(api.runners.revokeInstallToken, {
      installTokenId: revoked.installTokenId,
    });
    await asAlice.mutation(api.runners.revokeInstallToken, {
      installTokenId: revoked.installTokenId,
    });
    expect((await tryLink(revoked.installToken)).status).toBe(401);
    await expect(
      asAlice.query(api.runners.installTokenStatus, { installTokenId: revoked.installTokenId }),
    ).resolves.toMatchObject({ state: "revoked" });

    expect((await tryLink("vrt_nope")).status).toBe(401);

    vi.useFakeTimers();
    const expired = await mint();
    vi.advanceTimersByTime(RUNNER_INSTALL_TOKEN_TTL_MS + 1);
    await expect(
      asAlice.query(api.runners.installTokenStatus, { installTokenId: expired.installTokenId }),
    ).resolves.toMatchObject({ state: "expired" });
    expect((await tryLink(expired.installToken)).status).toBe(401);
    vi.useRealTimers();

    const orphaned = await mint();
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_uuid", (q) => q.eq("id", alice))
        .unique();
      await ctx.db.patch(user!._id, { status: "deletion_pending" });
    });
    expect((await tryLink(orphaned.installToken)).status).toBe(401);
  });

  test("another person's install token reads as missing, and cannot be revoked by them", async () => {
    const t = setup();
    await signIn(t);
    await signIn(t, BOB);
    const minted = await t
      .withIdentity(ALICE)
      .action(api.runners.createInstallToken, { nameHint: null, defaultWorkspaceId: null });
    const asBob = t.withIdentity(BOB);
    await expect(
      asBob.query(api.runners.installTokenStatus, { installTokenId: minted.installTokenId }),
    ).rejects.toThrow(code("not_found"));
    await expect(
      asBob.mutation(api.runners.revokeInstallToken, { installTokenId: minted.installTokenId }),
    ).rejects.toThrow(code("not_found"));
  });

  test("a bad body is invalid_request, never a 500, and only JSON is read", async () => {
    const t = setup();
    const plain = await post(
      t,
      RUNNER_HTTP_PATHS.link,
      { installToken: "vrt_x" },
      { "content-type": "text/plain" },
    );
    expect(plain.status).toBe(400);
    expect(readRunnerHttpError(plain.body)?.code).toBe("invalid_request");
    for (const body of [
      "{not json",
      { installToken: "vrt_x" },
      { installToken: "vrt_x", host: {} },
    ]) {
      const result = await post(t, RUNNER_HTTP_PATHS.link, body);
      expect(result.status).toBe(400);
      expect(readRunnerHttpError(result.body)?.code).toBe("invalid_request");
    }
  });

  test("names come from --name, then the token's hint, then the hostname, unique per owner", async () => {
    const t = setup();
    await signIn(t);
    await signIn(t, BOB);
    expect((await linkLinux(t)).name).toBe("hetzner-1");
    expect((await linkLinux(t)).name).toBe("hetzner-1-2");
    expect((await linkLinux(t, ALICE, "Lab Box")).name).toBe("lab-box");
    // Names are per owner.
    expect((await linkLinux(t, BOB)).name).toBe("hetzner-1");
  });
});

describe("the desktop's own Mac", () => {
  test("registerThisMac links the caller's machine as a mac runner", async () => {
    const t = setup();
    const alice = await signIn(t);
    const grant = await t
      .withIdentity(ALICE)
      .action(api.runners.registerThisMac, { host: MAC_HOST, name: null });
    expect(grant).toMatchObject({ name: "alices-macbook-pro", generation: 1 });
    const { runner, credentials } = await rows(t, grant.runnerId);
    expect(runner).toMatchObject({
      ownerUserId: alice,
      kind: "mac",
      linkedVia: "desktop",
      installMode: "app",
    });
    expect(credentials?.currentHash).toBe(secretHash(grant.credential));
  });

  test("needs a signed-in person, never a runner", async () => {
    const t = setup();
    await expect(
      t.action(api.runners.registerThisMac, { host: MAC_HOST, name: null }),
    ).rejects.toThrow(code("unauthenticated"));
    await expect(
      asRunner(t, newId("runner")).action(api.runners.registerThisMac, {
        host: MAC_HOST,
        name: null,
      }),
    ).rejects.toThrow(code("no_viewer"));
  });
});

describe("device-code linking", () => {
  async function start(t: T, ip?: string) {
    const result = await post(
      ip === undefined ? t : t.withRequestMetadata({ ip }),
      RUNNER_HTTP_PATHS.linkStart,
      { host: LINUX_HOST },
      // A header the caller sets is never the address shown to the person.
      { "x-forwarded-for": "198.51.100.66", "cf-connecting-ip": "198.51.100.66" },
    );
    expect(result.status).toBe(200);
    return parseRunnerDeviceLinkStart(result.body);
  }
  const poll = (t: T, requestId: string, pollSecret: string) =>
    post(t, RUNNER_HTTP_PATHS.linkPoll, { requestId, pollSecret });

  test("the box prints a code, the person sees which machine and approves, the next poll links it once", async () => {
    const t = setup();
    const alice = await signIn(t);
    const started = await start(t, "203.0.113.7");
    expect(started.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.intervalMs).toBe(5_000);

    expect(
      parseRunnerDeviceLinkPoll((await poll(t, started.requestId, started.pollSecret)).body),
    ).toEqual({
      status: "pending",
    });

    const asAlice = t.withIdentity(ALICE);
    const typed = ` ${started.userCode.toLowerCase().replace("-", " ")} `;
    await expect(
      asAlice.mutation(api.runners.previewLink, { userCode: typed }),
    ).resolves.toMatchObject({
      ok: true,
      requestId: started.requestId,
      hostname: LINUX_HOST.hostname,
      os: "linux",
      distro: "debian 12",
      arch: "x64",
      ip: "203.0.113.7",
    });
    await expect(
      asAlice.mutation(api.runners.decideLink, {
        requestId: started.requestId,
        userCode: started.userCode,
        decision: "approve",
      }),
    ).resolves.toEqual({ ok: true, requestId: started.requestId });
    // A second click on Approve is the same decision, not a failed attempt.
    await expect(
      asAlice.mutation(api.runners.decideLink, {
        requestId: started.requestId,
        userCode: started.userCode,
        decision: "approve",
      }),
    ).resolves.toEqual({ ok: true, requestId: started.requestId });
    // A decision names the request the person previewed, not just a code.
    await expect(
      asAlice.mutation(api.runners.decideLink, {
        requestId: newId("runner"),
        userCode: started.userCode,
        decision: "deny",
      }),
    ).resolves.toEqual({ ok: false, code: "not_found" });

    const linked = parseRunnerDeviceLinkPoll(
      (await poll(t, started.requestId, started.pollSecret)).body,
    );
    expect(linked.status).toBe("linked");
    if (linked.status !== "linked") throw new Error("unreachable");
    const { runner, credentials } = await rows(t, linked.grant.runnerId);
    expect(runner).toMatchObject({
      ownerUserId: alice,
      kind: "linux",
      name: "hetzner-1",
      linkedVia: "device_code",
      installMode: "system",
    });
    expect(credentials?.currentHash).toBe(secretHash(linked.grant.credential));

    // Answered once: the credential is never handed out a second time.
    const replay = await poll(t, started.requestId, started.pollSecret);
    expect(replay.status).toBe(404);
    expect(readRunnerHttpError(replay.body)?.code).toBe("invalid_link_request");
    // And the code is spent.
    await expect(
      asAlice.mutation(api.runners.previewLink, { userCode: started.userCode }),
    ).resolves.toEqual({ ok: false, code: "not_found" });
  });

  test("a denied code tells the box so; a wrong poll secret learns nothing", async () => {
    const t = setup();
    await signIn(t);
    const started = await start(t);
    expect((await poll(t, started.requestId, "vrp_wrong")).status).toBe(404);
    const other = await start(t);
    expect((await poll(t, other.requestId, started.pollSecret)).status).toBe(404);
    await t.withIdentity(ALICE).mutation(api.runners.decideLink, {
      requestId: started.requestId,
      userCode: started.userCode,
      decision: "deny",
    });
    expect(
      parseRunnerDeviceLinkPoll((await poll(t, started.requestId, started.pollSecret)).body),
    ).toEqual({
      status: "denied",
    });
  });

  test("a code expires after ten minutes, for the box and for the person", async () => {
    vi.useFakeTimers();
    const t = setup();
    await signIn(t);
    const first = await start(t);
    const second = await start(t);
    vi.advanceTimersByTime(RUNNER_LINK_REQUEST_TTL_MS + 1);
    expect(
      parseRunnerDeviceLinkPoll((await poll(t, first.requestId, first.pollSecret)).body),
    ).toEqual({
      status: "expired",
    });
    expect(
      parseRunnerDeviceLinkPoll((await poll(t, first.requestId, first.pollSecret)).body),
    ).toEqual({
      status: "expired",
    });
    await expect(
      t.withIdentity(ALICE).mutation(api.runners.previewLink, { userCode: second.userCode }),
    ).resolves.toEqual({ ok: false, code: "not_found" });
    const stored = await t.run((ctx) => ctx.db.query("runnerLinkRequests").collect());
    expect(stored.map((row) => row.status)).toEqual(["expired", "expired"]);
  });

  test("an approval by an account that is then deleted links nothing", async () => {
    const t = setup();
    const alice = await signIn(t);
    const started = await start(t);
    await t.withIdentity(ALICE).mutation(api.runners.decideLink, {
      requestId: started.requestId,
      userCode: started.userCode,
      decision: "approve",
    });
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_uuid", (q) => q.eq("id", alice))
        .unique();
      await ctx.db.patch(user!._id, { status: "deleted" });
    });
    expect(
      parseRunnerDeviceLinkPoll((await poll(t, started.requestId, started.pollSecret)).body),
    ).toEqual({
      status: "denied",
    });
  });

  test("guessing codes is rate-limited per person, and the window resets", async () => {
    vi.useFakeTimers();
    const t = setup();
    await signIn(t);
    const started = await start(t);
    const asAlice = t.withIdentity(ALICE);
    for (let miss = 0; miss < LINK_ATTEMPT_MAX_FAILURES; miss += 1) {
      await expect(
        asAlice.mutation(api.runners.previewLink, {
          userCode: miss % 2 === 0 ? "BBBB-BBBB" : "not a code",
        }),
      ).resolves.toEqual({ ok: false, code: "not_found" });
    }
    // Even the right code is refused while limited.
    await expect(
      asAlice.mutation(api.runners.previewLink, { userCode: started.userCode }),
    ).resolves.toEqual({
      ok: false,
      code: "rate_limited",
    });
    await expect(
      asAlice.mutation(api.runners.decideLink, {
        requestId: started.requestId,
        userCode: started.userCode,
        decision: "approve",
      }),
    ).resolves.toEqual({ ok: false, code: "rate_limited" });
    // Convex's clock runs a hair ahead of the test's; a second covers it.
    vi.advanceTimersByTime(LINK_ATTEMPT_WINDOW_MS + 1_000);
    await expect(
      asAlice.mutation(api.runners.previewLink, { userCode: "BBBB-BBBB" }),
    ).resolves.toEqual({
      ok: false,
      code: "not_found",
    });
    // (The first code has expired with the window; a fresh one goes through.)
    const fresh = await start(t);
    await expect(
      asAlice.mutation(api.runners.previewLink, { userCode: fresh.userCode }),
    ).resolves.toMatchObject({
      ok: true,
    });
  });

  test("a code that collides with a pending one is re-drawn", async () => {
    const t = setup();
    const userCode = mintUserCode();
    const first = await t.mutation(internal.runners.startDeviceLink, {
      requestId: newId("runner"),
      userCodeHash: secretHash(userCode),
      pollSecretHash: "a",
      host: LINUX_HOST,
      ip: null,
    });
    expect(first.ok).toBe(true);
    await expect(
      t.mutation(internal.runners.startDeviceLink, {
        requestId: newId("runner"),
        userCodeHash: secretHash(userCode),
        pollSecretHash: "b",
        host: LINUX_HOST,
        ip: null,
      }),
    ).resolves.toEqual({ ok: false, code: "collision" });
  });
});

describe("the token exchange", () => {
  let keys: ReturnType<typeof issuerKeys>;
  beforeEach(() => {
    keys = issuerKeys();
    vi.stubEnv("VOLLI_RUNNER_SIGNING_KEY", keys.signingKey);
  });
  const exchange = (t: T, runnerId: string, credential: string) =>
    post(t.withRequestMetadata({ ip: "198.51.100.4" }), RUNNER_HTTP_PATHS.token, {
      runnerId,
      credential,
    });

  test("a credential becomes a signed 15-minute runner token and its own successor", async () => {
    const t = setup();
    const alice = await signIn(t);
    const grant = await linkLinux(t);
    const result = await exchange(t, grant.runnerId, grant.credential);
    expect(result.status).toBe(200);
    const token = parseRunnerTokenGrant(result.body);
    expect(token.generation).toBe(2);
    expect(token.credential).not.toBe(grant.credential);
    expect(token.expiresAt - token.serverTime).toBe(15 * 60_000);

    const jwt = decodeJwt(token.token, keys.publicKey);
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ alg: "ES256", typ: "JWT", kid: "k1" });
    expect(jwt.claims).toMatchObject({
      iss: RUNNER_TOKEN_ISSUER,
      aud: RUNNER_TOKEN_AUDIENCE,
      sub: `runner:${grant.runnerId}`,
      own: alice,
      gen: 2,
      kind: "linux",
    });

    const { credentials } = await rows(t, grant.runnerId);
    expect(credentials).toMatchObject({
      currentHash: secretHash(token.credential),
      previousHash: secretHash(grant.credential),
      currentFirstUsedAt: null,
      generation: 2,
      lastUsedIp: "198.51.100.4",
    });
  });

  test("a lost reply is survivable: the old credential works again until the new one is used", async () => {
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    const lost = parseRunnerTokenGrant((await exchange(t, grant.runnerId, grant.credential)).body);
    // The box never saw `lost`; it presents its old credential again.
    const retried = await exchange(t, grant.runnerId, grant.credential);
    expect(retried.status).toBe(200);
    const kept = parseRunnerTokenGrant(retried.body);
    expect(kept.generation).toBe(3);
    // The reply nobody received is dead.
    expect((await exchange(t, grant.runnerId, lost.credential)).status).toBe(401);
    // The one the box kept carries on.
    expect((await exchange(t, grant.runnerId, kept.credential)).status).toBe(200);
  });

  test("a copied credential presented after its successor was used cuts the runner off", async () => {
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    const next = parseRunnerTokenGrant((await exchange(t, grant.runnerId, grant.credential)).body);
    // The box uses its new token: the old credential's grace ends.
    await asRunner(t, grant.runnerId, next.generation).mutation(api.runners.heartbeat, {
      bootId: "b1",
      load: LOAD,
    });
    const copied = await exchange(t, grant.runnerId, grant.credential);
    expect(copied.status).toBe(403);
    expect(readRunnerHttpError(copied.body)?.code).toBe("revoked");

    const { runner, credentials, events } = await rows(t, grant.runnerId);
    expect(runner).toMatchObject({ status: "revoked", statusReason: "credential_reuse" });
    expect(runner?.revokedAt).toEqual(expect.any(Number));
    expect(credentials).toBeNull();
    expect(events.map((event) => event.kind)).toEqual(["linked", "token_reuse"]);
    // The legitimate box is refused too, and its live token stops at once.
    expect((await exchange(t, grant.runnerId, next.credential)).status).toBe(403);
    await expect(
      asRunner(t, grant.runnerId, next.generation).mutation(api.runners.heartbeat, {
        bootId: "b1",
        load: LOAD,
      }),
    ).rejects.toThrow(code("revoked"));
    // The owner still sees it, so the cut-off can be explained.
    const listed = await t.withIdentity(ALICE).query(api.runners.list, {});
    expect(listed).toEqual([expect.objectContaining({ id: grant.runnerId, status: "revoked" })]);
  });

  test("a credential that matches nothing changes nothing: knowing a runner id is not enough to revoke it", async () => {
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    const wrong = await exchange(t, grant.runnerId, "vrc_guess");
    expect(wrong.status).toBe(401);
    expect(readRunnerHttpError(wrong.body)?.code).toBe("invalid_credential");
    expect((await rows(t, grant.runnerId)).runner?.status).toBe("offline");
    expect((await exchange(t, grant.runnerId, grant.credential)).status).toBe(200);
    // An unknown runner reads like a wrong credential: an id alone reveals nothing.
    const unknown = await exchange(t, newId("runner"), grant.credential);
    expect(readRunnerHttpError(unknown.body)?.code).toBe("invalid_credential");
  });

  test("without a signing key the deployment says so and spends no credential", async () => {
    vi.stubEnv("VOLLI_RUNNER_SIGNING_KEY", "");
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    const result = await exchange(t, grant.runnerId, grant.credential);
    expect(result.status).toBe(503);
    expect(readRunnerHttpError(result.body)?.code).toBe("issuer_unconfigured");
    expect((await rows(t, grant.runnerId)).credentials?.generation).toBe(1);
  });

  test("a signing key without a kid is a configuration error", async () => {
    vi.stubEnv("VOLLI_RUNNER_SIGNING_KEY", JSON.stringify({ kty: "EC" }));
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    await expect(exchange(t, grant.runnerId, grant.credential)).rejects.toThrow(/kid/);
  });

  test("a malformed exchange is invalid_request", async () => {
    const t = setup();
    const result = await post(t, RUNNER_HTTP_PATHS.token, { runnerId: "nope", credential: "x" });
    expect(result.status).toBe(400);
  });
});

describe("the runner's own calls", () => {
  test("only a runner token may call them, and a person's token is not one", async () => {
    const t = setup();
    await signIn(t);
    await expect(t.mutation(api.runners.heartbeat, { bootId: "b", load: LOAD })).rejects.toThrow(
      code("unauthenticated"),
    );
    await expect(
      t.withIdentity(ALICE).mutation(api.runners.heartbeat, { bootId: "b", load: LOAD }),
    ).rejects.toThrow(code("not_a_runner"));
    // A person's issuer with a runner-shaped subject is still a person.
    const grant = await linkLinux(t);
    await expect(
      t
        .withIdentity({ issuer: ALICE.issuer, subject: runnerSubject(grant.runnerId) })
        .mutation(api.runners.heartbeat, { bootId: "b", load: LOAD }),
    ).rejects.toThrow(code("not_a_runner"));
    await expect(
      asRunner(t, newId("runner")).mutation(api.runners.heartbeat, { bootId: "b", load: LOAD }),
    ).rejects.toThrow(code("revoked"));
  });

  test("a runner token cannot become a person", async () => {
    const t = setup();
    await expect(
      asRunner(t, newId("runner")).mutation(api.accounts.ensureViewer, {}),
    ).rejects.toThrow(code("not_a_person"));
  });

  test("the first heartbeat brings a runner online and writes presence only", async () => {
    vi.useFakeTimers();
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    const runner = asRunner(t, grant.runnerId);
    const reply = await runner.mutation(api.runners.heartbeat, { bootId: "boot-1", load: LOAD });
    expect(reply).toEqual({
      serverTime: expect.any(Number),
      status: "online",
      targetVersion: null,
      minVersion: null,
      autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
    });
    const first = await rows(t, grant.runnerId);
    expect(first.presence).toMatchObject({
      bootId: "boot-1",
      load: LOAD,
      lastHeartbeatAt: reply.serverTime,
    });
    // A generation-1 token is the link's own credential: its first use is recorded.
    expect(first.credentials?.currentFirstUsedAt).toBe(reply.serverTime);

    vi.advanceTimersByTime(30_000);
    const later = await runner.mutation(api.runners.heartbeat, {
      bootId: "boot-1",
      load: { ...LOAD, activeTurns: 2 },
    });
    const second = await rows(t, grant.runnerId);
    // The runner row a client subscribes to did not change; presence did.
    expect(second.runner).toEqual(first.runner);
    expect(second.presence?.load.activeTurns).toBe(2);
    expect(second.presence?.lastHeartbeatAt).toBe(later.serverTime);
  });

  test("a token of another generation, or with none, does not end the current credential's grace", async () => {
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    await asRunner(t, grant.runnerId, 7).mutation(api.runners.heartbeat, {
      bootId: "b",
      load: LOAD,
    });
    await asRunner(t, grant.runnerId, null).mutation(api.runners.heartbeat, {
      bootId: "b",
      load: LOAD,
    });
    expect((await rows(t, grant.runnerId)).credentials?.currentFirstUsedAt).toBeNull();
  });

  test("the heartbeat answers with the runner's channel, or its pin", async () => {
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("releaseChannels", {
        channel: "stable",
        version: "0.3.4",
        minVersion: "0.3.0",
        manifestUrl: "https://dl.example/stable.json",
        publishedAt: 0,
      });
    });
    const runner = asRunner(t, grant.runnerId);
    await expect(
      runner.mutation(api.runners.heartbeat, { bootId: "b", load: LOAD }),
    ).resolves.toMatchObject({
      targetVersion: "0.3.4",
      minVersion: "0.3.0",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", grant.runnerId))
        .unique();
      await ctx.db.patch(row!._id, {
        autoUpdate: { enabled: false, channel: "stable", pinnedVersion: "0.3.1" },
      });
    });
    await expect(
      runner.mutation(api.runners.heartbeat, { bootId: "b", load: LOAD }),
    ).resolves.toMatchObject({
      targetVersion: "0.3.1",
    });
  });

  test("reported states are transitions; a stopped runner comes back online with its next heartbeat", async () => {
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    const runner = asRunner(t, grant.runnerId);
    await expect(
      runner.mutation(api.runners.reportState, { state: "degraded", reason: "disk-low" }),
    ).resolves.toEqual({ status: "degraded" });
    expect((await rows(t, grant.runnerId)).runner).toMatchObject({
      status: "degraded",
      statusReason: "disk-low",
    });
    // A heartbeat does not clear a reported state.
    await expect(
      runner.mutation(api.runners.heartbeat, { bootId: "b", load: LOAD }),
    ).resolves.toMatchObject({
      status: "degraded",
    });
    await runner.mutation(api.runners.reportState, { state: "stopped", reason: null });
    await expect(
      runner.mutation(api.runners.heartbeat, { bootId: "b2", load: LOAD }),
    ).resolves.toMatchObject({
      status: "online",
    });
    const before = (await rows(t, grant.runnerId)).runner;
    await runner.mutation(api.runners.reportState, { state: "online", reason: null });
    expect((await rows(t, grant.runnerId)).runner).toEqual(before);
  });

  test("capabilities are written on change only, and local credentials replaced wholesale", async () => {
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    const runner = asRunner(t, grant.runnerId);
    await expect(
      runner.mutation(api.runners.reportCapabilities, { report: REPORT }),
    ).resolves.toEqual({
      changed: true,
    });
    const first = await rows(t, grant.runnerId);
    expect(first.runner).toMatchObject({ version: "0.3.0", capabilities: REPORT.capabilities });
    expect(first.localCredentials).toEqual([
      expect.objectContaining({ providerId: "anthropic", kind: "subscription", expiresAt: null }),
    ]);

    await expect(
      runner.mutation(api.runners.reportCapabilities, { report: REPORT }),
    ).resolves.toEqual({
      changed: false,
    });
    expect((await rows(t, grant.runnerId)).runner).toEqual(first.runner);

    await expect(
      runner.mutation(api.runners.reportCapabilities, {
        report: {
          ...REPORT,
          localCredentials: [
            { providerId: "openai", kind: "api_key", expiresAt: 5 },
            { providerId: "anthropic", kind: "subscription", expiresAt: null },
          ],
        },
      }),
    ).resolves.toEqual({ changed: true });
    expect((await rows(t, grant.runnerId)).runner).toEqual(first.runner);
    expect(
      (await rows(t, grant.runnerId)).localCredentials.map((row) => row.providerId).toSorted(),
    ).toEqual(["anthropic", "openai"]);

    await expect(
      runner.mutation(api.runners.reportCapabilities, {
        report: { ...REPORT, capabilities: { v: 2 } },
      }),
    ).rejects.toThrow(code("invalid_request"));
  });
});

describe("the offline sweep", () => {
  async function online(t: T) {
    const grant = await linkLinux(t);
    await asRunner(t, grant.runnerId).mutation(api.runners.heartbeat, { bootId: "b", load: LOAD });
    return grant.runnerId;
  }

  test("marks a live runner offline after 90 s of silence, and leaves the rest alone", async () => {
    vi.useFakeTimers();
    const t = setup();
    await signIn(t);
    const quiet = await online(t);
    const draining = await online(t);
    await asRunner(t, draining).mutation(api.runners.reportState, {
      state: "draining",
      reason: null,
    });
    const stopped = await online(t);
    await asRunner(t, stopped).mutation(api.runners.reportState, {
      state: "stopped",
      reason: null,
    });
    vi.advanceTimersByTime(RUNNER_OFFLINE_AFTER_MS / 2);
    const chatty = await online(t);
    vi.advanceTimersByTime(RUNNER_OFFLINE_AFTER_MS / 2 + 1_000);

    await t.mutation(internal.runners.sweepOffline, { statusIndex: 0, cursor: null });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    expect((await rows(t, quiet)).runner).toMatchObject({
      status: "offline",
      statusReason: "heartbeat_lost",
    });
    expect((await rows(t, draining)).runner).toMatchObject({ status: "offline" });
    expect((await rows(t, stopped)).runner).toMatchObject({ status: "stopped" });
    expect((await rows(t, chatty)).runner).toMatchObject({ status: "online" });
    // Offline is a status like any other: the next heartbeat brings it back.
    await expect(
      asRunner(t, quiet).mutation(api.runners.heartbeat, { bootId: "b", load: LOAD }),
    ).resolves.toMatchObject({ status: "online" });
  });

  test("a runner with no presence at all is judged by when its status last changed", async () => {
    vi.useFakeTimers();
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    await asRunner(t, grant.runnerId).mutation(api.runners.reportState, {
      state: "online",
      reason: null,
    });
    vi.advanceTimersByTime(RUNNER_OFFLINE_AFTER_MS + 1_000);
    await expect(
      t.mutation(internal.runners.sweepOffline, { statusIndex: 0, cursor: null }),
    ).resolves.toEqual({
      marked: 1,
    });
  });

  test("pages through more live runners than one run reads", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.run(async (ctx) => {
      for (let n = 0; n <= SWEEP_PAGE_SIZE; n += 1) {
        await ctx.db.insert("runners", {
          id: newId("runner"),
          ownerUserId: newId("user"),
          kind: "linux",
          name: `r${n}`,
          status: "online",
          statusReason: null,
          statusChangedAt: 0,
          version: "0.3.0",
          platform: LINUX_HOST.platform,
          capabilities: null,
          installMode: "user",
          linkedVia: "install_token",
          linkedAt: 0,
          autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
          update: null,
          revokedAt: null,
          createdAt: 0,
        });
      }
    });
    vi.advanceTimersByTime(RUNNER_OFFLINE_AFTER_MS + 1_000);
    await expect(
      t.mutation(internal.runners.sweepOffline, { statusIndex: 0, cursor: null }),
    ).resolves.toEqual({
      marked: SWEEP_PAGE_SIZE,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const statuses = await t.run((ctx) => ctx.db.query("runners").collect());
    expect(statuses.every((runner) => runner.status === "offline")).toBe(true);
    await expect(
      t.mutation(internal.runners.sweepOffline, { statusIndex: 99, cursor: null }),
    ).resolves.toEqual({
      marked: 0,
    });
  });
});

describe("the expiry cleanup", () => {
  test("deletes link rows a day past expiry and audit events past 90 days", async () => {
    vi.useFakeTimers();
    const t = setup();
    await signIn(t);
    await linkLinux(t);
    await post(t, RUNNER_HTTP_PATHS.linkStart, { host: LINUX_HOST });
    const fresh = await t
      .withIdentity(ALICE)
      .action(api.runners.createInstallToken, { nameHint: null, defaultWorkspaceId: null });
    vi.advanceTimersByTime(RUNNER_INSTALL_TOKEN_TTL_MS + EXPIRED_LINK_ROW_RETENTION_MS + 1_000);
    await t
      .withIdentity(ALICE)
      .action(api.runners.createInstallToken, { nameHint: null, defaultWorkspaceId: null });
    await expect(t.mutation(internal.runners.sweepExpired, {})).resolves.toEqual({ deleted: 3 });
    const tokens = await t.run((ctx) => ctx.db.query("runnerInstallTokens").collect());
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.id).not.toBe(fresh.installTokenId);

    vi.advanceTimersByTime(RUNNER_EVENT_RETENTION_MS);
    await t.mutation(internal.runners.sweepExpired, {});
    await expect(t.run((ctx) => ctx.db.query("runnerEvents").collect())).resolves.toEqual([]);
  });

  test("a full page schedules the next one", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.run(async (ctx) => {
      for (let n = 0; n <= SWEEP_PAGE_SIZE; n += 1) {
        await ctx.db.insert("runnerEvents", {
          runnerId: newId("runner"),
          kind: "linked",
          at: 0,
          detail: null,
        });
      }
    });
    vi.advanceTimersByTime(RUNNER_EVENT_RETENTION_MS + 1_000);
    await expect(t.mutation(internal.runners.sweepExpired, {})).resolves.toEqual({
      deleted: SWEEP_PAGE_SIZE,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    await expect(t.run((ctx) => ctx.db.query("runnerEvents").collect())).resolves.toEqual([]);
  });
});

describe("Settings → Runners", () => {
  test("lists the caller's own runners by name, never anyone else's", async () => {
    const t = setup();
    await signIn(t);
    await signIn(t, BOB);
    const zed = await linkLinux(t, ALICE, "zed");
    const alpha = await linkLinux(t, ALICE, "alpha");
    await linkLinux(t, BOB);
    const listed = await t.withIdentity(ALICE).query(api.runners.list, {});
    expect(listed.map((runner) => [runner.id, runner.name])).toEqual([
      [alpha.runnerId, "alpha"],
      [zed.runnerId, "zed"],
    ]);
    expect(listed[0]).toEqual({
      id: alpha.runnerId,
      name: "alpha",
      kind: "linux",
      status: "offline",
      statusReason: null,
      statusChangedAt: expect.any(Number),
      version: "unknown",
      platform: LINUX_HOST.platform,
      capabilities: null,
      installMode: "system",
      linkedVia: "install_token",
      linkedAt: expect.any(Number),
    });
    await expect(t.query(api.runners.list, {})).rejects.toThrow(code("unauthenticated"));
  });

  test("rename keeps names unique per owner and slugged", async () => {
    const t = setup();
    await signIn(t);
    await signIn(t, BOB);
    const one = await linkLinux(t, ALICE, "one");
    await linkLinux(t, ALICE, "two");
    const asAlice = t.withIdentity(ALICE);
    await expect(
      asAlice.mutation(api.runners.rename, { runnerId: one.runnerId, name: "Build Box!" }),
    ).resolves.toEqual({ name: "build-box" });
    await expect(
      asAlice.mutation(api.runners.rename, { runnerId: one.runnerId, name: "build-box" }),
    ).resolves.toEqual({ name: "build-box" });
    await expect(
      asAlice.mutation(api.runners.rename, { runnerId: one.runnerId, name: "two" }),
    ).rejects.toThrow(code("forbidden"));
    await expect(
      asAlice.mutation(api.runners.rename, { runnerId: one.runnerId, name: "!!" }),
    ).rejects.toThrow(code("forbidden"));
    await expect(
      t.withIdentity(BOB).mutation(api.runners.rename, { runnerId: one.runnerId, name: "mine" }),
    ).rejects.toThrow(code("not_found"));
  });

  test("remove cuts the runner off at once, hides it, and frees its name", async () => {
    vi.stubEnv("VOLLI_RUNNER_SIGNING_KEY", issuerKeys().signingKey);
    const t = setup();
    await signIn(t);
    await signIn(t, BOB);
    const grant = await linkLinux(t);
    const asAlice = t.withIdentity(ALICE);
    await expect(
      t.withIdentity(BOB).mutation(api.runners.remove, { runnerId: grant.runnerId }),
    ).rejects.toThrow(code("not_found"));

    await asAlice.mutation(api.runners.remove, { runnerId: grant.runnerId });
    await asAlice.mutation(api.runners.remove, { runnerId: grant.runnerId });
    const { runner, credentials, events } = await rows(t, grant.runnerId);
    expect(runner).toMatchObject({ status: "revoked", statusReason: "removed" });
    expect(credentials).toBeNull();
    expect(events.map((event) => event.kind)).toEqual(["linked", "revoked"]);
    await expect(asAlice.query(api.runners.list, {})).resolves.toEqual([]);
    await expect(
      asRunner(t, grant.runnerId).mutation(api.runners.heartbeat, { bootId: "b", load: LOAD }),
    ).rejects.toThrow(code("revoked"));
    expect(
      (
        await post(t, RUNNER_HTTP_PATHS.token, {
          runnerId: grant.runnerId,
          credential: grant.credential,
        })
      ).status,
    ).toBe(403);
    await expect(
      asAlice.mutation(api.runners.rename, { runnerId: grant.runnerId, name: "back" }),
    ).rejects.toThrow(code("not_found"));
    // Linking the box again reuses its name.
    expect((await linkLinux(t)).name).toBe("hetzner-1");
  });
});

async function setOwnerStatus(
  t: T,
  userId: string,
  status: "active" | "deletion_pending" | "deleted",
) {
  await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_uuid", (q) => q.eq("id", userId))
      .unique();
    await ctx.db.patch(user!._id, { status });
  });
}

describe("review hardening", () => {
  beforeEach(() => {
    vi.stubEnv("VOLLI_RUNNER_SIGNING_KEY", issuerKeys().signingKey);
  });

  test("any runner write with the new generation ends the old credential's grace", async () => {
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    const exchanged = await post(t, RUNNER_HTTP_PATHS.token, {
      runnerId: grant.runnerId,
      credential: grant.credential,
    });
    const next = parseRunnerTokenGrant(exchanged.body);
    await asRunner(t, grant.runnerId, next.generation).mutation(api.runners.reportState, {
      state: "online",
      reason: null,
    });
    const copied = await post(t, RUNNER_HTTP_PATHS.token, {
      runnerId: grant.runnerId,
      credential: grant.credential,
    });
    expect(readRunnerHttpError(copied.body)?.code).toBe("revoked");
    expect((await rows(t, grant.runnerId)).runner?.statusReason).toBe("credential_reuse");
  });

  test("a runner serves an active owner only", async () => {
    const t = setup();
    const alice = await signIn(t);
    const grant = await linkLinux(t);
    await setOwnerStatus(t, alice, "deletion_pending");
    await expect(
      asRunner(t, grant.runnerId).mutation(api.runners.heartbeat, { bootId: "b", load: LOAD }),
    ).rejects.toThrow(code("revoked"));
    const exchanged = await post(t, RUNNER_HTTP_PATHS.token, {
      runnerId: grant.runnerId,
      credential: grant.credential,
    });
    expect(readRunnerHttpError(exchanged.body)?.code).toBe("revoked");
    await expect(
      t.withIdentity(ALICE).action(api.runners.registerThisMac, { host: MAC_HOST, name: null }),
    ).rejects.toThrow(code("account_deletion_pending"));
  });

  test("the heartbeat records the address Convex saw", async () => {
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    await asRunner(t, grant.runnerId)
      .withRequestMetadata({ ip: "192.0.2.9" })
      .mutation(api.runners.heartbeat, { bootId: "b", load: LOAD });
    expect((await rows(t, grant.runnerId)).presence?.lastIp).toBe("192.0.2.9");
  });

  test("a runner cannot clear upgrade_required by saying it is online", async () => {
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", grant.runnerId))
        .unique();
      await ctx.db.patch(row!._id, { status: "upgrade_required" });
    });
    const runner = asRunner(t, grant.runnerId);
    await expect(
      runner.mutation(api.runners.reportState, { state: "online", reason: null }),
    ).resolves.toEqual({
      status: "upgrade_required",
    });
    await expect(
      runner.mutation(api.runners.reportState, { state: "updating", reason: null }),
    ).resolves.toEqual({ status: "updating" });
  });

  test("removing a runner deletes its live state", async () => {
    const t = setup();
    await signIn(t);
    const grant = await linkLinux(t);
    const runner = asRunner(t, grant.runnerId);
    await runner.mutation(api.runners.heartbeat, { bootId: "b", load: LOAD });
    await runner.mutation(api.runners.reportCapabilities, { report: REPORT });
    await t.withIdentity(ALICE).mutation(api.runners.remove, { runnerId: grant.runnerId });
    const after = await rows(t, grant.runnerId);
    expect(after.presence).toBeNull();
    expect(after.localCredentials).toEqual([]);
  });

  test("a malformed desktop registration is invalid_request", async () => {
    const t = setup();
    await signIn(t);
    await expect(
      t
        .withIdentity(ALICE)
        .action(api.runners.registerThisMac, { host: { hostname: "x" }, name: null }),
    ).rejects.toThrow(code("invalid_request"));
  });
});
