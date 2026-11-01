/**
 * `volli-runner run`'s composition, booted for real: host-core over a temp
 * data dir, SQLite, the cloud product store, the Session runtime with Pi (only
 * the provider wire scripted), the agent socket, and the runner's connection
 * over the real backend link, gate, presence, inbox and drain. The token
 * exchange goes through the real `/runner/token` client codec over a fake
 * fetch; the Convex WebSocket is an in-memory `BackendConnection` playing the
 * deployment.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { piOwnedModelAccess } from "@volli/agent-runtime";
import { cloudMessageSubmit, decodeSessionEventPayload } from "@volli/shared";
import type { ClaimedJob, JobOutcome, RunnerHeartbeatReply } from "@volli/shared/cloud";

import type { TranscriptReference } from "@volli/shared";

import { scriptedProvider } from "../../../agent-runtime/test-fixtures/scripted-provider";
import type { BackendConnection, ConnectBackend } from "../cloud-runner/backend-link";
import type { ConvexClientLike, ConvexClientModule } from "../cloud-runner/convex-connection";
import type { HeadlessRunnerTarget } from "../cloud-runner/headless-runner";
import type { RunnerLink, RunnerLinkStore } from "../cloud-runner/link";
import { createRunnerPathRegistry } from "../cloud-store/paths";
import { fileSecretKey, SecretStore } from "../secrets";
import { resetRetentionWatcherForTest } from "../testing";
import {
  HeadlessRunnerBootError,
  startHeadlessRunner,
  type HeadlessRunnerStatus,
  type RunningHeadlessRunner,
} from "./compose";
import { RUNNER_OWNER_FILE } from "./owner";

const OWNER = "99999999-8888-4777-8666-555555555555";
const RUNNER = "33333333-2222-4333-8444-555555555555";
const PROJECT = "11111111-2222-4333-8444-555555555555";
const REPO = "22222222-2222-4333-8444-555555555555";
const AUTOMATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SESSION = "55555555-2222-4333-8444-555555555555";
const RUN = "12121212-2222-4333-8444-555555555555";
const JOB = "88888888-2222-4333-8444-555555555555";

const roots: string[] = [];
const running: RunningHeadlessRunner[] = [];
afterEach(async () => {
  for (const runner of running.splice(0)) await runner.stop("test done");
  vi.unstubAllEnvs();
  resetRetentionWatcherForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Volli Test",
      GIT_AUTHOR_EMAIL: "test@volli.local",
      GIT_COMMITTER_NAME: "Volli Test",
      GIT_COMMITTER_EMAIL: "test@volli.local",
    },
  }).trim();
}

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const revokedError = () => Object.assign(new Error("revoked"), { data: { code: "revoked" } });

/** A runner token as the backend signs one: only its `own` claim is read here. */
function runnerToken(own: string, n: number): string {
  return `${part({ alg: "ES256" })}.${part({ sub: RUNNER, own, n })}.signature`;
}

function memoryLinkStore(initial: RunnerLink | null) {
  let link = initial;
  const store: RunnerLinkStore = {
    load: async () => (link === null ? null : { ...link }),
    save: async (next) => {
      link = { ...next };
    },
    clear: async () => {
      link = null;
    },
  };
  return {
    store,
    set: (next: RunnerLink | null) => {
      link = next;
    },
    current: () => link,
  };
}

/** The deployment: the `/runner/token` route and the Convex functions a runner calls. */
function fakeDeployment() {
  const mutations: { name: string; args: Record<string, unknown> }[] = [];
  const queued: ClaimedJob[] = [];
  const completed = new Map<string, JobOutcome>();
  const accepted: { sessionId: string; sequence: number; kind: string }[] = [];
  const states: string[] = [];
  const capabilities: Record<string, unknown>[] = [];
  let exchanges = 0;
  let revoked = false;
  let reachable = true;
  let hangWhenUnreachable = false;
  let wake: ((value: unknown) => void) | undefined;
  const connectionListeners = new Set<(up: boolean) => void>();
  const queries = new Map<string, (args: Record<string, unknown>) => unknown>();
  const reply: RunnerHeartbeatReply = {
    serverTime: Date.now(),
    status: "online",
    targetVersion: "0.3.1",
    minVersion: "0.3.0",
    autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
  };
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!reachable) throw new Error("connect ECONNREFUSED");
    if (!url.endsWith("/runner/token")) return Response.json({}, { status: 404 });
    const body = JSON.parse(String(init?.body)) as { runnerId: string; credential: string };
    if (revoked)
      return Response.json(
        { error: { code: "revoked", message: "This runner was removed." } },
        { status: 401 },
      );
    exchanges += 1;
    const now = Date.now();
    return Response.json({
      token: runnerToken(OWNER, exchanges),
      expiresAt: now + 3_600_000,
      serverTime: now,
      credential: `${body.credential}+`,
      generation: exchanges + 1,
    });
  };
  const connect: ConnectBackend = () => {
    const connection: BackendConnection = {
      async mutation(name, args) {
        mutations.push({ name, args });
        // A dead link: the client queues the call and it never answers.
        if (!reachable && hangWhenUnreachable) return new Promise(() => {});
        if (revoked && name.startsWith("runners:")) throw revokedError();
        switch (name) {
          case "runners:heartbeat":
            return { ...reply, serverTime: Date.now() };
          case "runners:reportState":
            states.push(args.state as string);
            return null;
          case "runners:reportCapabilities":
            capabilities.push(args.report as Record<string, unknown>);
            return null;
          case "runnerJobs:claim":
            return queued.splice(0, args.max as number);
          case "runnerJobs:renew":
            return {
              ok: true,
              lease: { bootId: args.bootId, attempt: args.attempt, expiresAt: Date.now() + 60_000 },
            };
          case "runnerJobs:complete":
            completed.set(args.jobId as string, args.outcome as JobOutcome);
            return { ack: "recorded", status: "done" };
          case "sessions:accept": {
            let through = 0;
            for (const text of args.events as string[]) {
              const event = JSON.parse(text) as {
                sessionId: string;
                sequence: number;
                payload: unknown;
              };
              const payload = decodeSessionEventPayload(event.payload, "in-memory accept");
              accepted.push({
                sessionId: event.sessionId,
                sequence: event.sequence,
                kind: payload.kind,
              });
              through = event.sequence;
            }
            return { acceptedThrough: through, duplicates: 0, quarantined: 0 };
          }
          case "projectCheckouts:report":
            return null;
          case "workingCopies:report":
            return { workingCopyId: "77777777-2222-4333-8444-555555555555" };
          default:
            // Streams, packing and mirrors: accepted and ignored here.
            return null;
        }
      },
      async query(name, args) {
        const answer = queries.get(name);
        if (answer === undefined) throw new Error(`Unexpected query: ${name}`);
        return answer(args);
      },
      onUpdate(name, _args, listener) {
        if (name === "runnerJobs:wake") wake = listener;
        let subscribed = true;
        return () => {
          // As the Convex client does: a second unsubscribe throws.
          if (!subscribed) throw new TypeError("Cannot read properties of undefined");
          subscribed = false;
          if (name === "runnerJobs:wake") wake = undefined;
        };
      },
      isConnected: () => reachable,
      onConnectionChange(listener) {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
      close: async () => {},
    };
    return connection;
  };
  /** `convex/browser`'s client, as the lifecycle drives it, over the in-memory connection. */
  class FakeConvexClient implements ConvexClientLike {
    readonly #connection = connect(async () => null);
    setAuth() {}
    mutation(reference: never, args: never) {
      return this.#connection.mutation(reference as string, args as Record<string, unknown>);
    }
    query(reference: never, args: never) {
      return this.#connection.query!(reference as string, args as Record<string, unknown>);
    }
    onUpdate(reference: never, args: never, callback: (value: never) => void) {
      return this.#connection.onUpdate(
        reference as string,
        args as Record<string, unknown>,
        callback as (value: unknown) => void,
      );
    }
    connectionState() {
      return { isWebSocketConnected: this.#connection.isConnected() };
    }
    subscribeToConnectionState(listener: (state: { isWebSocketConnected: boolean }) => void) {
      return this.#connection.onConnectionChange((up) => listener({ isWebSocketConnected: up }));
    }
    close() {
      return this.#connection.close();
    }
  }
  const convex: ConvexClientModule = {
    ConvexClient: FakeConvexClient,
    makeFunctionReference: (name) => name,
  };
  return {
    convex,
    fetch,
    mutations,
    queued,
    completed,
    accepted,
    states,
    capabilities,
    queries,
    exchanges: () => exchanges,
    enqueue(job: ClaimedJob) {
      queued.push(job);
      wake?.({ ready: queued.length, nextAvailableAt: null });
    },
    revoke() {
      revoked = true;
    },
    hangWhileUnreachable() {
      hangWhenUnreachable = true;
    },
    setReachable(up: boolean) {
      reachable = up;
      for (const listener of connectionListeners) listener(up);
    },
  };
}

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fixture(
  options: { linked?: boolean; replies?: Parameters<typeof scriptedProvider>[0] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "headless-runner-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  git(checkout, ["init", "-b", "main"]);
  writeFileSync(join(checkout, "README.md"), "initial\n");
  git(checkout, ["add", "."]);
  git(checkout, ["commit", "-m", "initial"]);
  const deployment = fakeDeployment();
  const link: RunnerLink = {
    runnerId: RUNNER as RunnerLink["runnerId"],
    name: "hetzner-1",
    credential: "vrc_initial",
    generation: 1,
  };
  const links = memoryLinkStore(options.linked === false ? null : link);
  const script = scriptedProvider(
    options.replies ?? [
      { text: "Headless runner turn complete" },
      { text: "Headless runner turn complete" },
      { text: "Headless runner turn complete" },
    ],
  );
  const statuses: HeadlessRunnerStatus[] = [];
  const targets: HeadlessRunnerTarget[] = [];
  const logs: { level: string; message: string }[] = [];
  const log = (level: string) => (message: string) => void logs.push({ level, message });
  const start = async () => {
    const runner = await startHeadlessRunner({
      dataDir,
      socketPath: join(dataDir, "volli.sock"),
      binDir: join(root, "bin"),
      homeDir: root,
      version: "0.3.0",
      installMode: "user",
      service: true,
      env: { HOME: root, PATH: process.env["PATH"] },
      logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
      secretStore: new SecretStore(
        join(dataDir, "session-secrets.enc"),
        fileSecretKey({ path: join(dataDir, "secret.key") }),
      ),
      linkStore: links.store,
      deployment: () => ({
        url: "http://127.0.0.1:1",
        siteUrl: "https://deployment.example.site",
        convex: deployment.convex,
        fetch: deployment.fetch,
      }),
      signInFile: join(root, "pi", "auth.json"),
      gitCredentialHelper: "!false",
      gitCredentialSocket: join(dataDir, "git-credential.sock"),
      modelAccess: () => ({
        ...piOwnedModelAccess({ agentDir: join(root, "pi") }),
        models: script.models,
      }),
      onStatus: (status) => void statuses.push(status),
      onTarget: (reply) => void targets.push(reply),
      linkPollMs: 25,
      signInPollMs: 25,
    });
    running.push(runner);
    return runner;
  };
  return {
    root,
    dataDir,
    checkout,
    deployment,
    links,
    link,
    script,
    statuses,
    targets,
    logs,
    start,
  };
}

// Real boots on a shared machine: each case gets room beyond the default 5 s.
describe("volli-runner run: the headless composition", { timeout: 30_000 }, () => {
  it("boots unlinked, serves only its status, and boots on once a link is saved", async () => {
    const f = fixture({ linked: false });
    const runner = await f.start();
    expect(runner.status()).toMatchObject({ state: "unlinked", runner: null, backend: null });
    // Nothing opened: no database, no socket, no backend.
    expect(runner.host()).toBeNull();
    expect(existsSync(join(f.dataDir, "volli.sock"))).toBe(false);
    expect(f.deployment.exchanges()).toBe(0);

    f.links.set(f.link);
    await until(() => runner.status().state === "online", "online after linking");
    expect(runner.status().runner).toEqual({ runnerId: RUNNER, name: "hetzner-1" });
  });

  it("links → online: learns and keeps its owner, reports capabilities and surfaces the update target", async () => {
    const f = fixture();
    const runner = await f.start();
    await until(() => runner.status().state === "online", "online");
    expect(f.statuses.map((status) => status.state)).toEqual(
      expect.arrayContaining(["starting", "connecting", "online"]),
    );
    // A boot never passes through a lost link on its way up.
    expect(f.statuses.map((status) => status.state)).not.toContain("unlinked");
    expect(f.statuses.map((status) => status.backend?.state)).not.toContain("revoked");
    // The owner came from the first token's `own` claim and is kept for an offline restart.
    expect(JSON.parse(readFileSync(join(f.dataDir, RUNNER_OWNER_FILE), "utf8"))).toEqual({
      v: 1,
      runnerId: RUNNER,
      ownerUserId: OWNER,
    });
    // The rotated credential was saved before the token was used.
    expect(f.links.current()?.generation).toBeGreaterThan(1);
    const report = await until(() => f.deployment.capabilities[0], "a capability report");
    expect(report).toMatchObject({
      version: "0.3.0",
      installMode: "user",
      capabilities: {
        terminals: "unavailable",
        browser: { state: "unavailable", reason: "headless" },
        power: { source: "ac", alwaysOn: true },
        tools: expect.arrayContaining(["automation.run", "session.start"]),
      },
    });
    await until(() => f.targets.length > 0, "a heartbeat reply");
    expect(runner.status().target).toEqual({ targetVersion: "0.3.1", minVersion: "0.3.0" });
    expect(runner.status().backend).toMatchObject({ state: "online", detail: null });
    // The agent socket and the git credential socket are this user's alone.
    expect(statSync(join(f.dataDir, "volli.sock")).mode & 0o777).toBe(0o600);
    await until(() => existsSync(join(f.dataDir, "git-credential.sock")), "the helper socket");
    expect(statSync(join(f.dataDir, "git-credential.sock")).mode & 0o777).toBe(0o600);
    // Dispatched past readiness: a caller with no project gets the verb's own refusal.
    expect(
      await socketRequest(join(f.dataDir, "volli.sock"), {
        v: 1,
        cmd: "identify",
        args: {},
        ctx: { cwd: f.root, env: {} },
      }),
    ).toMatchObject({ v: 1, ok: false, error: { code: "CONTEXT_REQUIRED" } });
  });

  it("drains on stop: reports draining then stopped, closes the socket and the database", async () => {
    const f = fixture();
    const runner = await f.start();
    await until(() => runner.status().state === "online", "online");
    const host = runner.host()!;
    expect(await runner.stop("SIGTERM")).toBe(true);
    expect(f.deployment.states).toEqual(expect.arrayContaining(["draining", "stopped"]));
    expect(f.deployment.states.indexOf("draining")).toBeLessThan(
      f.deployment.states.indexOf("stopped"),
    );
    expect(runner.status().state).toBe("stopped");
    expect(f.statuses.map((status) => status.state)).toEqual(
      expect.arrayContaining(["draining", "stopping", "stopped"]),
    );
    expect(host.database.db.open).toBe(false);
    expect(existsSync(join(f.dataDir, "volli.sock"))).toBe(false);
    // Idempotent.
    expect(await runner.stop("again")).toBe(true);
  });

  it("revoked: stops claiming and stays up, saying why", async () => {
    const f = fixture();
    const runner = await f.start();
    await until(() => runner.status().state === "online", "online");
    f.deployment.revoke();
    // The next report is refused as revoked (a login re-reports at once).
    signIn(f.root, "openai");
    await until(() => runner.status().state === "revoked", "revoked");
    expect(runner.status().backend?.detail).toMatch(/removed or cut off/);
    const claims = f.deployment.mutations.filter((m) => m.name === "runnerJobs:claim").length;
    f.deployment.enqueue(automationJob());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(f.deployment.mutations.filter((m) => m.name === "runnerJobs:claim").length).toBe(claims);
    // Still up: the stop is clean.
    expect(await runner.stop("SIGTERM")).toBe(true);
  });

  it("restarts offline under the owner it kept, and comes online when Volli Cloud is back", async () => {
    const f = fixture();
    const first = await f.start();
    await until(() => first.status().state === "online", "online");
    expect(await first.stop("restart")).toBe(true);
    const exchanges = f.deployment.exchanges();
    f.deployment.setReachable(false);
    const second = await f.start();
    // The kept owner composes the runtime with no token: the socket answers offline.
    await until(
      () => ["connecting", "offline"].includes(second.status().state),
      "connecting or offline",
    );
    expect(
      await socketRequest(join(f.dataDir, "volli.sock"), {
        v: 1,
        cmd: "identify",
        args: {},
        ctx: { cwd: f.root, env: {} },
      }),
    ).toMatchObject({ v: 1, ok: false, error: { code: "CONTEXT_REQUIRED" } });
    expect(f.deployment.exchanges()).toBe(exchanges);
    f.deployment.setReachable(true);
    // The lifecycle retries on its own backoff (1 s, doubling).
    await until(() => second.status().state === "online", "online again");
  }, 30_000);

  it("a stop while it waits to learn its owner closes what it opened, at once", async () => {
    const f = fixture();
    f.deployment.setReachable(false);
    const runner = await f.start();
    await until(() => runner.status().state === "connecting", "connecting");
    const request = socketRequest(join(f.dataDir, "volli.sock"), {
      v: 1,
      cmd: "identify",
      args: {},
      ctx: { cwd: f.root, env: {} },
    });
    const host = runner.host()!;
    // Let the request reach the socket and wait on readiness.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await runner.stop("SIGTERM")).toBe(true);
    // The waiting request is answered, not abandoned; nothing reached the backend.
    await expect(request).resolves.toMatchObject({ ok: false, error: { code: "APP_UNREACHABLE" } });
    expect(f.deployment.mutations).toEqual([]);
    expect(host.database.db.open).toBe(false);
    expect(f.statuses.at(-1)?.state).toBe("stopped");
    expect(f.statuses.map((status) => status.state)).not.toContain("online");
  });

  it("a stop on a dead link is bounded and still closes cleanly", async () => {
    const f = fixture();
    const runner = await f.start();
    await until(() => runner.status().state === "online", "online");
    f.deployment.hangWhileUnreachable();
    f.deployment.setReachable(false);
    const started = Date.now();
    await runner.stop("SIGTERM");
    // The draining report (2 s) and the stopped report (5 s) are each bounded.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(runner.host()!.database.db.open).toBe(false);
    expect(runner.status().state).toBe("stopped");
  }, 30_000);

  it("a runner revoked before it first connected says so and composes nothing", async () => {
    const f = fixture();
    f.deployment.revoke();
    const runner = await f.start();
    await until(() => runner.status().state === "revoked", "revoked");
    await expect(
      socketRequest(join(f.dataDir, "volli.sock"), {
        v: 1,
        cmd: "identify",
        args: {},
        ctx: { cwd: f.root, env: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "APP_UNREACHABLE" } });
    expect(f.deployment.mutations).toEqual([]);
    expect(await runner.stop("SIGTERM")).toBe(true);
  });

  it("refuses to boot over a database that will not open", async () => {
    const f = fixture();
    writeFileSync(join(f.dataDir, "volli.db"), "this is not a database, it is a sentence");
    await expect(f.start()).rejects.toBeInstanceOf(HeadlessRunnerBootError);
    expect(existsSync(join(f.dataDir, "volli.sock"))).toBe(false);
  });

  it("gives its updater the drain, the resume, the work in flight and a report", async () => {
    const f = fixture();
    const runner = await f.start();
    await until(() => runner.status().state === "online", "online");
    expect(runner.updates.inFlight()).toBe(0);
    await runner.updates.drain();
    await until(() => f.deployment.states.includes("draining"), "draining reported");
    // The status file says so before the agent asks the applier to activate:
    // the applier refuses `not_draining` otherwise.
    expect(runner.status().state).toBe("draining");
    expect(f.statuses.at(-1)?.state).toBe("draining");
    await runner.updates.resume();
    await until(() => f.deployment.states.at(-1) === "online", "online reported");
    expect(runner.status().state).toBe("online");
    await runner.updates.report("runnerUpdateReports:report", { outcomeId: "o-1" });
    expect(f.deployment.mutations).toContainEqual({
      name: "runnerUpdateReports:report",
      args: { outcomeId: "o-1" },
    });
    expect(await runner.stop("SIGTERM")).toBe(true);
    // Stopped: a report is refused, and the agent sends it again next boot.
    await expect(runner.updates.report("runnerUpdateReports:report", {})).rejects.toThrow();
  });

  it("re-reports the providers it can serve when a login lands on the box", async () => {
    const f = fixture();
    const runner = await f.start();
    await until(() => runner.status().state === "online", "online");
    await until(() => f.deployment.capabilities.length > 0, "the first report");
    expect(f.deployment.capabilities.at(-1)?.["localCredentials"]).toEqual([]);
    signIn(f.root, "anthropic");
    await until(
      () =>
        ((f.deployment.capabilities.at(-1)?.["localCredentials"] ?? []) as unknown[]).length > 0,
      "the login re-reported",
    );
    expect(f.deployment.capabilities.at(-1)?.["localCredentials"]).toEqual([
      { providerId: "anthropic", kind: "api_key", expiresAt: null },
    ]);
  });

  it("picks up a person's session.start: born here, a scripted turn, its facts accepted", async () => {
    const f = fixture();
    const runner = await f.start();
    await until(() => runner.status().state === "online", "online");
    registerCheckout(runner, f.checkout);
    const START = "66666666-2222-4333-8444-555555555555";
    // What `sessionStarts.startOn` staged: the canonical first message.
    const first = cloudMessageSubmit({
      sessionId: SESSION,
      commandId: START,
      message: {
        id: "m-1",
        role: "user",
        parts: [{ type: "text", text: "Say hello from the box" }],
      },
    });
    f.deployment.queries.set("sessionStarts:startContext", () => ({
      kind: "ready",
      projectId: PROJECT,
      ticket: null,
      runnerName: "hetzner-1",
      body: first.body,
    }));
    f.deployment.queries.set("runnerContext:forSession", forSession);
    f.deployment.enqueue(sessionStartJob(START, first.reference, MODEL));
    const outcome = await until(() => f.deployment.completed.get(START), "the start's outcome");
    expect(outcome).toEqual({
      status: "done",
      result: { kind: "started", sessionId: SESSION, model: MODEL },
    });
    await until(
      () =>
        f.deployment.accepted.some(
          (event) => event.sessionId === SESSION && event.kind === "turn.completed",
        ),
      "the turn's facts accepted",
    );
    // The first message the model saw is the one the person sent from another device.
    expect(JSON.stringify(f.script.requests)).toContain("Say hello from the box");
  });

  it("starts a Session for a remote-only project in a managed clone, never 'Choose the folder'", async () => {
    const f = fixture();
    // The project's remote: a local bare repository behind the https URL Volli
    // recorded, reached through an `insteadOf` rewrite as BYO-8's tests do.
    const remote = join(f.root, "remote.git");
    git(f.root, ["init", "--bare", "-b", "main", remote]);
    git(f.checkout, ["push", remote, "main"]);
    const REMOTE_URL = "https://git.example.test/acme/app.git";
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", `url.${remote}.insteadOf`);
    vi.stubEnv("GIT_CONFIG_VALUE_0", REMOTE_URL);
    const runner = await f.start();
    await until(() => runner.status().state === "online", "online");
    const START = "88888888-2222-4333-8444-555555555557";
    const first = cloudMessageSubmit({
      sessionId: SESSION,
      commandId: START,
      message: { id: "m-1", role: "user", parts: [{ type: "text", text: "Hello from a clone" }] },
    });
    f.deployment.queries.set("sessionStarts:startContext", () => ({
      kind: "ready",
      projectId: PROJECT,
      ticket: null,
      runnerName: "hetzner-1",
      body: first.body,
    }));
    // No checkout is registered on this box: only the recorded remote.
    f.deployment.queries.set("runnerContext:forSession", (args) => {
      const facts = forSession(args);
      return { ...facts, primaryRepo: { ...facts.primaryRepo, remoteUrl: REMOTE_URL } };
    });
    f.deployment.enqueue(sessionStartJob(START, first.reference, MODEL));
    const outcome = await until(() => f.deployment.completed.get(START), "the start's outcome");
    expect(outcome).toEqual({
      status: "done",
      result: { kind: "started", sessionId: SESSION, model: MODEL },
    });
    await until(
      () =>
        f.deployment.accepted.some(
          (event) => event.sessionId === SESSION && event.kind === "turn.completed",
        ),
      "the turn's facts accepted",
    );
    // The clone lives under the runner's data dir, with the remote's history.
    const clone = join(f.dataDir, "repos", REPO);
    expect(git(clone, ["log", "-1", "--format=%s"])).toBe("initial");
    expect(f.deployment.mutations).toContainEqual(
      expect.objectContaining({
        name: "projectCheckouts:report",
        args: expect.objectContaining({ kind: "managed_clone" }),
      }),
    );
  });

  it("refuses a session.start for a provider this box is not signed in to, saying where to sign in", async () => {
    const f = fixture();
    const runner = await f.start();
    await until(() => runner.status().state === "online", "online");
    registerCheckout(runner, f.checkout);
    const START = "77777777-2222-4333-8444-555555555556";
    const first = cloudMessageSubmit({
      sessionId: SESSION,
      commandId: START,
      message: { id: "m-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
    });
    f.deployment.queries.set("sessionStarts:startContext", () => ({
      kind: "ready",
      projectId: PROJECT,
      ticket: null,
      runnerName: "hetzner-1",
      body: first.body,
    }));
    f.deployment.queries.set("runnerContext:forSession", forSession);
    f.deployment.enqueue(
      sessionStartJob(START, first.reference, {
        providerId: "anthropic",
        modelId: "claude-sonnet-5",
        reasoningLevel: null,
      }),
    );
    const outcome = await until(() => f.deployment.completed.get(START), "the start's outcome");
    expect(JSON.stringify(outcome)).toContain("volli-runner login anthropic");
    expect(f.script.requests).toEqual([]);
  });

  it("runs a claimed job's Session through a scripted model turn and its facts are accepted", async () => {
    const f = fixture();
    const runner = await f.start();
    await until(() => runner.status().state === "online", "online");
    registerCheckout(runner, f.checkout);
    f.deployment.queries.set("automationRunner:runContext", (args) => ({
      kind: "ready",
      payload: automationPayload(),
      projectId: PROJECT,
      automation: {
        id: AUTOMATION,
        projectId: PROJECT,
        name: "Review",
        instructions: "Say hello from the box",
        trigger: { kind: "manual" },
        runtime: null,
        deletedAt: null,
      },
      ticket: null,
      columnArming: null,
      scheduleArming: null,
      previousRunActive: false,
      request: args,
    }));
    f.deployment.queries.set("runnerContext:forSession", forSession);
    f.deployment.enqueue(automationJob());
    const outcome = await until(() => f.deployment.completed.get(JOB), "the job's outcome", 60_000);
    expect(outcome).toMatchObject({
      status: "done",
      result: {
        kind: "started",
        sessionId: SESSION,
        model: { providerId: "scripted-fixture", modelId: "scripted" },
      },
    });
    await until(
      () =>
        f.deployment.accepted.some(
          (event) => event.sessionId === SESSION && event.kind === "turn.completed",
        ),
      "the turn's facts accepted",
      15_000,
    );
    // Every fact up to the turn's end goes up, none missing.
    await until(() => {
      const sequences = new Set(
        f.deployment.accepted
          .filter((event) => event.sessionId === SESSION)
          .map((event) => event.sequence),
      );
      return [...sequences].every((_, index) => sequences.has(index + 1));
    }, "every fact accepted");
    expect(f.script.requests.length).toBeGreaterThan(0);
    // A stop with the Session's facts already up still drains cleanly.
    expect(await runner.stop("SIGTERM")).toBe(true);
    expect(f.deployment.states.at(-1)).toBe("stopped");
  }, 90_000);
});

const MODEL = {
  providerId: "scripted-fixture",
  modelId: "scripted",
  reasoningLevel: "off",
} as const;

/** The project's folder on this box (a managed clone, once BYO-8 lands). */
function registerCheckout(runner: RunningHeadlessRunner, checkout: string): void {
  createRunnerPathRegistry(runner.host()!.database.db, { runnerId: RUNNER }).checkouts.register({
    projectId: PROJECT,
    projectRepoId: REPO,
    absPath: checkout,
    adoptedFromFrozen: false,
  });
}

/** `runnerContext.forSession` for a Board Session of the box's project. */
function forSession(args: Record<string, unknown>) {
  return {
    sessionId: args["sessionId"],
    ownerUserId: OWNER,
    project: { id: PROJECT, name: "Box project" },
    ticketPrefix: "VC",
    primaryRepo: { id: REPO, projectId: PROJECT, baseBranch: "main" },
    ticket: null,
    body: null,
  };
}

function sessionStartJob(
  id: string,
  body: TranscriptReference,
  model: { providerId: string; modelId: string; reasoningLevel: string | null } | null,
): ClaimedJob {
  return {
    job: {
      id,
      kind: "session.start",
      runnerId: RUNNER,
      projectId: PROJECT,
      ticketId: null,
      sessionId: SESSION,
      workingCopyId: null,
      commandId: id,
      payload: {
        format: "volli.session-start.v1",
        projectId: PROJECT,
        ticketId: null,
        title: null,
        firstMessage: { commandId: id, body: { ...body } },
        model,
      },
      priority: "normal",
      createdBy: { kind: "person", userId: OWNER },
      createdAt: 0,
      availableAt: 0,
    },
    lease: { bootId: "boot", attempt: 1, expiresAt: Date.now() + 60_000 },
  } as unknown as ClaimedJob;
}

/** One agent-socket request, as the `volli` CLI sends it: a line, then half-close. */
function socketRequest(path: string, request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    const socket = createConnection(path, () => socket.end(`${JSON.stringify(request)}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      body += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

/** What `volli-runner login --api-key` leaves behind: Pi's own sign-in file. */
function signIn(root: string, providerId: string): void {
  mkdirSync(join(root, "pi"), { recursive: true });
  writeFileSync(
    join(root, "pi", "auth.json"),
    JSON.stringify({ [providerId]: { type: "api_key", key: "sk-test" } }),
    { mode: 0o600 },
  );
}

function automationPayload() {
  return {
    runId: RUN,
    sessionId: SESSION,
    dueAt: Date.now(),
    missedCount: 0,
    attendance: "attended",
    modelOverride: { providerId: "scripted-fixture", modelId: "scripted", reasoningLevel: "off" },
    requestedBySessionId: null,
    trigger: "manual",
    automationId: AUTOMATION,
    ticketId: null,
    armedByUserId: null,
  };
}

function automationJob(): ClaimedJob {
  return {
    job: {
      id: JOB,
      runnerId: RUNNER,
      kind: "automation.run",
      projectId: PROJECT,
      sessionId: null,
      ticketId: null,
      workingCopyId: null,
      commandId: null,
      payload: automationPayload(),
      priority: "normal",
      createdBy: { kind: "volli", reason: "policy" },
      createdAt: 0,
      availableAt: 0,
    },
    lease: { bootId: "boot", expiresAt: Date.now() + 60_000, attempt: 1 },
  } as unknown as ClaimedJob;
}
