/**
 * Sign-ins on a host (VC-702), against a scripted Pi and fake stores: who may
 * drive a flow, what its stream says, the relay's single-use grant, and that
 * no read or event ever carries a value a person sent.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { PiSignIn, PiSignInSteps } from "@volli/agent-runtime";
import {
  expiredHostSignIns,
  isSignInRefused,
  type HandlerCall,
  type HostSignInUpdate,
  type ModelAccessProvider,
  type ModelAccessSignInType,
  type ModelAccessSnapshot,
} from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { GitCredential, HostSignInKeyProvider, StoredModelCredential } from "./ports";
import { HostSignIns, MAX_FLOWS_PER_CONNECTION } from "./service";

const API_KEY = "sk-ant-api03-THIS-IS-THE-SENT-KEY-0123456789";
const GIT_TOKEN = "ghp_THISISTHESENTPUSHTOKEN0123456789";
const PASTED = "http://localhost:53692/callback?code=PASTED-CODE-0123456789&state=s";

type Flow = (steps: PiSignInSteps, signal: AbortSignal) => Promise<void>;

function provider(id: string, overrides: Partial<ModelAccessProvider> = {}): ModelAccessProvider {
  return {
    id,
    label: id,
    state: "authentication-required",
    accountLabel: null,
    billingSource: "unknown",
    recovery: null,
    signIn: [
      { type: "api-key", label: "API key", isSubscription: false },
      { type: "oauth", label: "Subscription", isSubscription: true },
    ],
    hasStoredCredential: false,
    ...overrides,
  };
}

function fakeKeys() {
  const stored = new Map<string, StoredModelCredential>();
  const apiKeys = new Map<string, string>();
  const git = new Map<string, GitCredential>();
  const keys: HostSignInKeyProvider = {
    models: {
      setApiKey: vi.fn(async (providerId: string, key: string) => {
        apiKeys.set(providerId, key);
        stored.set(providerId, { providerId, type: "api-key", expiresAt: null });
      }),
      stored: async () => [...stored.values()],
    },
    git: {
      hosts: async () => [...git.keys()].toSorted(),
      get: async (host) => git.get(host) ?? null,
      set: async (host, credential) => {
        git.set(host, credential);
      },
      clear: async (host) => {
        git.delete(host);
      },
    },
  };
  return { keys, stored, apiKeys, git };
}

function harness(
  options: {
    flows?: Record<string, Flow>;
    providers?: ModelAccessProvider[];
    replay?: (url: string, signal: AbortSignal) => Promise<number>;
    now?: () => number;
  } = {},
) {
  const flows = options.flows ?? {};
  let ids = 0;
  const pi: PiSignIn = {
    offers: (providerId: string, type: ModelAccessSignInType) =>
      type === "api-key" ? providerId !== "ambient-only" : providerId in flows,
    login: (providerId, _type, signal, steps) => flows[providerId]!(steps, signal),
    logout: vi.fn(async () => {}),
  };
  const store = fakeKeys();
  const snapshot = (): ModelAccessSnapshot => ({
    observedAt: 0,
    providers: options.providers ?? [provider("anthropic"), provider("xai")],
    models: [],
  });
  const signIns = new HostSignIns({
    pi,
    inspect: async () => snapshot(),
    keys: store.keys,
    newId: () => `id-${++ids}`,
    ...(options.replay === undefined ? {} : { replay: options.replay }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { signIns, pi, ...store };
}

function connection(id: string, features: readonly string[] = ["sign-ins", "auth.callback"]) {
  const closed = new AbortController();
  const call: HandlerCall = {
    actor: { kind: "user" },
    connection: { id, closed: closed.signal, features },
  };
  return { call, close: () => closed.abort() };
}

function record(signIns: HostSignIns, flowId: string, call: HandlerCall) {
  const updates: HostSignInUpdate[] = [];
  const opened = signIns.subscribe({ flowId }, call, {
    emit: (update) => {
      updates.push(update);
    },
    fail: (error) => {
      throw error;
    },
  });
  return { updates, opened };
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

async function refusal(run: () => unknown): Promise<{ reason: string; message: string }> {
  try {
    await run();
  } catch (error) {
    if (isSignInRefused(error)) return { reason: error.reason, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A Pi-like browser flow: a loopback listener raced against a pasted code. */
function loopbackFlow(port: () => number, path = "/callback"): Flow {
  return async (steps, signal) => {
    const raced = new AbortController();
    steps.say({
      kind: "auth-url",
      url: `https://claude.ai/oauth/authorize?client_id=c&redirect_uri=${encodeURIComponent(
        `http://localhost:${port()}${path}`,
      )}&state=s`,
      instructions: null,
    });
    const pasted = steps.ask(
      {
        promptId: steps.newId(),
        kind: "manual-code",
        message: "Paste the redirect URL",
        placeholder: null,
        options: [],
      },
      raced.signal,
    );
    const answer = await Promise.race([pasted.then((value) => ({ value })), callbackOnce()]);
    raced.abort();
    signal.throwIfAborted();
    if ("value" in answer && !answer.value.includes("code=")) throw new Error("bad paste");
  };
}

let callbackOnce: () => Promise<{ code: string }> = () => new Promise(() => {});
let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  servers = [];
  callbackOnce = () => new Promise(() => {});
});

describe("status", () => {
  it("names availability per provider and git host, never a value", async () => {
    const h = harness({
      providers: [
        provider("anthropic"),
        provider("openai", { state: "available" }),
        provider("ambient-env", { state: "available", signIn: [] }),
        provider("xai"),
        provider("expired-oauth", { state: "unavailable" }),
        provider("needs-sign-in-again"),
      ],
      now: () => 10_000,
    });
    h.stored.set("expired-oauth", {
      providerId: "expired-oauth",
      type: "oauth",
      expiresAt: 5_000,
    });
    h.stored.set("needs-sign-in-again", {
      providerId: "needs-sign-in-again",
      type: "oauth",
      expiresAt: 50_000,
    });
    await h.signIns.setApiKey({ providerId: "openai", key: API_KEY });
    const status = await h.signIns.setGitCredential({
      host: "GitHub.com",
      username: "x-access-token",
      password: GIT_TOKEN,
    });
    expect(h.apiKeys.get("openai")).toBe(API_KEY);
    expect(h.git.get("github.com")).toEqual({ username: "x-access-token", password: GIT_TOKEN });
    expect(status.git).toEqual([{ host: "github.com", state: "signed-in", kind: "git" }]);
    expect(
      Object.fromEntries(status.providers.map((row) => [row.providerId, [row.state, row.kind]])),
    ).toEqual({
      anthropic: ["missing", null],
      openai: ["signed-in", "api-key"],
      xai: ["missing", null],
      // A stored OAuth sign-in whose token lapsed and no longer authenticates.
      "expired-oauth": ["expired", "subscription"],
      "needs-sign-in-again": ["expired", "subscription"],
    });
    // An ambient-only provider offers no sign-in and stores nothing: not a row.
    expect(status.providers.some((row) => row.providerId === "ambient-env")).toBe(false);
    // The host-chip badge's read, in `HostRecord.expiredSignIns`'s shape (VC-576).
    expect(expiredHostSignIns(status)).toStrictEqual([
      { providerId: "expired-oauth", name: "expired-oauth" },
      { providerId: "needs-sign-in-again", name: "needs-sign-in-again" },
    ]);
    const wire = JSON.stringify([status, await h.signIns.status()]);
    expect(wire).not.toContain(API_KEY);
    expect(wire).not.toContain(GIT_TOKEN);
    expect(wire).not.toContain("x-access-token");
  });

  it("refuses a provider that takes no key and a git host it cannot key, quoting nothing", async () => {
    const h = harness();
    expect(
      await refusal(() => h.signIns.setApiKey({ providerId: "ambient-only", key: API_KEY })),
    ).toMatchObject({ reason: "sign-in-unsupported" });
    const badHost = await refusal(() =>
      h.signIns.setGitCredential({
        host: "https://user@github.com/repo",
        username: "x",
        password: GIT_TOKEN,
      }),
    );
    expect(badHost.reason).toBe("sign-in-unsupported");
    expect(badHost.message).not.toContain(GIT_TOKEN);
    const twoLines = await refusal(() =>
      h.signIns.setGitCredential({
        host: "github.com",
        username: "x",
        password: `a\n${GIT_TOKEN}`,
      }),
    );
    expect(twoLines.message).not.toContain(GIT_TOKEN);
  });

  it("never repeats a store's own failure, which might quote the key", async () => {
    const h = harness();
    vi.mocked(h.keys.models.setApiKey).mockRejectedValueOnce(
      new Error(`EACCES writing {"key":"${API_KEY}"}`),
    );
    await expect(h.signIns.setApiKey({ providerId: "openai", key: API_KEY })).rejects.toThrow(
      "This host could not store the API key.",
    );
  });

  it("clears a git host and signs a provider out", async () => {
    const h = harness();
    await h.signIns.setGitCredential({ host: "github.com", username: "x", password: GIT_TOKEN });
    expect((await h.signIns.clearGitCredential({ host: "github.com" })).git).toEqual([]);
    await h.signIns.signOut({ providerId: "anthropic" });
    expect(h.pi.logout).toHaveBeenCalledWith("anthropic");
  });
});

describe("subscription sign-in on the host", () => {
  it("streams a device code to the asking connection and turns signed-in by itself", async () => {
    const approved = Promise.withResolvers<void>();
    const h = harness({
      flows: {
        xai: async (steps) => {
          steps.say({
            kind: "device-code",
            userCode: "ABCD-EFGH",
            verificationUri: "https://accounts.x.ai/device",
            intervalSeconds: 5,
            expiresInSeconds: 900,
          });
          await approved.promise;
          steps.say({ kind: "progress", message: "Signed in" });
        },
      },
    });
    const mac = connection("mac");
    const { flowId } = h.signIns.start({ providerId: "xai" }, mac.call);
    // A repeat from the same connection answers the same flow (natural).
    expect(h.signIns.start({ providerId: "xai" }, mac.call)).toEqual({ flowId });
    const stream = record(h.signIns, flowId, mac.call);
    await stream.opened;
    await until(() => stream.updates.length === 1);
    expect(stream.updates[0]).toMatchObject({ kind: "device-code", userCode: "ABCD-EFGH" });
    approved.resolve();
    await until(() => stream.updates.at(-1)?.kind === "done");
    expect(stream.updates.map((update) => update.kind)).toEqual([
      "device-code",
      "progress",
      "done",
    ]);
    // A subscription after the end replays the whole flow, end included.
    const late = record(h.signIns, flowId, mac.call);
    await late.opened;
    expect(late.updates).toEqual(stream.updates);
  });

  it("refuses another connection's flow exactly as an absent one", async () => {
    const h = harness({ flows: { xai: () => new Promise(() => {}) } });
    const mac = connection("mac");
    const phone = connection("phone");
    const { flowId } = h.signIns.start({ providerId: "xai" }, mac.call);
    const absent = await refusal(() =>
      h.signIns.subscribe({ flowId: "no-such-flow" }, phone.call, { emit() {}, fail() {} }),
    );
    expect(absent.reason).toBe("sign-in-unknown");
    for (const attempt of [
      () => h.signIns.subscribe({ flowId }, phone.call, { emit() {}, fail() {} }),
      () => h.signIns.answer({ flowId, promptId: "p", value: PASTED }, phone.call),
      () => h.signIns.cancel({ flowId }, phone.call),
      () => h.signIns.deliverCallback({ flowId, pathAndQuery: "/callback?code=c" }, phone.call),
    ]) {
      expect(await refusal(attempt)).toEqual(absent);
    }
    // The provider's one attempt slot stays the owner's.
    expect(await refusal(() => h.signIns.start({ providerId: "xai" }, phone.call))).toMatchObject({
      reason: "sign-in-conflict",
    });
    // The desktop's in-process window has no connection to own a flow.
    await expect(
      Promise.resolve().then(() =>
        h.signIns.start({ providerId: "xai" }, { actor: { kind: "user" } }),
      ),
    ).rejects.toThrow("network connection");
  });

  it("cancels and forgets a connection's flows when it ends", async () => {
    let aborted = false;
    const h = harness({
      flows: {
        xai: (_steps, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason as Error);
            }),
          ),
      },
    });
    const mac = connection("mac");
    h.signIns.start({ providerId: "xai" }, mac.call);
    expect(h.signIns.flowCount).toBe(1);
    mac.close();
    await until(() => aborted);
    expect(h.signIns.flowCount).toBe(0);
    // The slot is free for the next connection.
    expect(h.signIns.start({ providerId: "xai" }, connection("next").call).flowId).toBeTruthy();
  });

  it("takes the pasted redirect, and redacts it out of a failure", async () => {
    const h = harness({
      flows: {
        anthropic: async (steps) => {
          const value = await steps.ask(
            {
              promptId: steps.newId(),
              kind: "manual-code",
              message: "Paste",
              placeholder: null,
              options: [],
            },
            undefined,
          );
          throw new Error(`invalid_grant for ${value}`);
        },
      },
    });
    const mac = connection("mac", ["sign-ins"]);
    const { flowId } = h.signIns.start({ providerId: "anthropic" }, mac.call);
    const stream = record(h.signIns, flowId, mac.call);
    await stream.opened;
    const prompt = stream.updates.find((update) => update.kind === "prompt");
    expect(prompt).toBeDefined();
    h.signIns.answer(
      {
        flowId,
        promptId: (prompt as { prompt: { promptId: string } }).prompt.promptId,
        value: PASTED,
      },
      mac.call,
    );
    await until(() => stream.updates.at(-1)?.kind === "failed");
    expect(JSON.stringify(stream.updates)).not.toContain(PASTED);
    expect(stream.updates.at(-1)).toEqual({
      kind: "failed",
      message: "invalid_grant for [redacted]",
    });
    // A step that already took its answer is not answered twice.
    expect(
      await refusal(() => h.signIns.answer({ flowId, promptId: "gone", value: "x" }, mac.call)),
    ).toMatchObject({ reason: "sign-in-conflict" });
  });

  it("keeps a connection to its flow budget", async () => {
    const providers: Record<string, Flow> = {};
    for (let index = 0; index <= MAX_FLOWS_PER_CONNECTION; index++) {
      providers[`p${index}`] = () => new Promise(() => {});
    }
    const h = harness({ flows: providers });
    const mac = connection("mac");
    for (let index = 0; index < MAX_FLOWS_PER_CONNECTION; index++) {
      h.signIns.start({ providerId: `p${index}` }, mac.call);
    }
    expect(
      await refusal(() =>
        h.signIns.start({ providerId: `p${MAX_FLOWS_PER_CONNECTION}` }, mac.call),
      ),
    ).toMatchObject({ reason: "sign-in-conflict" });
  });
});

describe("the auth-callback relay", () => {
  it("grants a relaying connection one delivery, before the URL, to the flow's own path", async () => {
    const replay = vi.fn(async () => 200);
    const h = harness({ flows: { anthropic: loopbackFlow(() => 53692) }, replay });
    const mac = connection("mac");
    const { flowId } = h.signIns.start({ providerId: "anthropic" }, mac.call);
    const stream = record(h.signIns, flowId, mac.call);
    await stream.opened;
    expect(stream.updates.slice(0, 2)).toEqual([
      { kind: "auth-callback", flowId, redirectUri: "http://localhost:53692/callback" },
      expect.objectContaining({ kind: "auth-url" }),
    ]);
    // Not its path: refused, and the grant is not spent.
    expect(
      await refusal(() =>
        h.signIns.deliverCallback({ flowId, pathAndQuery: "/elsewhere?code=c" }, mac.call),
      ),
    ).toMatchObject({ reason: "sign-in-conflict" });
    expect(replay).not.toHaveBeenCalled();
    expect(
      await h.signIns.deliverCallback(
        { flowId, pathAndQuery: "/callback?code=c&state=s" },
        mac.call,
      ),
    ).toEqual({ status: 200 });
    // To the listener's own loopback, whatever name the redirect used.
    expect(replay).toHaveBeenCalledWith(
      "http://127.0.0.1:53692/callback?code=c&state=s",
      expect.any(AbortSignal),
    );
    // Single use.
    expect(
      await refusal(() =>
        h.signIns.deliverCallback({ flowId, pathAndQuery: "/callback?code=c&state=s" }, mac.call),
      ),
    ).toMatchObject({ reason: "sign-in-conflict" });
    expect(replay).toHaveBeenCalledOnce();
  });

  it("revokes the grant as soon as cancel returns, whatever Pi's unwinding takes", async () => {
    // A Pi whose login takes its time to unwind after the abort.
    const unwound = Promise.withResolvers<void>();
    const replay = vi.fn(async () => 200);
    const h = harness({
      flows: {
        anthropic: async (steps, signal) => {
          steps.say({
            kind: "auth-url",
            url: "https://provider.invalid/oauth?redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback",
            instructions: null,
          });
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          await unwound.promise;
          throw new Error("cancelled");
        },
      },
      replay,
    });
    const mac = connection("mac");
    const { flowId } = h.signIns.start({ providerId: "anthropic" }, mac.call);
    h.signIns.cancel({ flowId }, mac.call);
    expect(
      await refusal(() =>
        h.signIns.deliverCallback({ flowId, pathAndQuery: "/callback?code=c&state=s" }, mac.call),
      ),
    ).toMatchObject({ reason: "sign-in-conflict" });
    expect(
      await refusal(() => h.signIns.answer({ flowId, promptId: "p", value: PASTED }, mac.call)),
    ).toMatchObject({ reason: "sign-in-conflict" });
    unwound.resolve();
    expect(replay).not.toHaveBeenCalled();
  });

  it("abandons a replay still running when the flow is cancelled, and never reports it delivered", async () => {
    const answered = Promise.withResolvers<number>();
    let seen: AbortSignal | undefined;
    const replay = vi.fn((_url: string, signal: AbortSignal) => {
      seen = signal;
      return answered.promise;
    });
    const h = harness({ flows: { anthropic: loopbackFlow(() => 53692) }, replay });
    const mac = connection("mac");
    const { flowId } = h.signIns.start({ providerId: "anthropic" }, mac.call);
    const delivering = refusal(() =>
      h.signIns.deliverCallback({ flowId, pathAndQuery: "/callback?code=c&state=s" }, mac.call),
    );
    await until(() => seen !== undefined);
    expect(seen!.aborted).toBe(false);
    h.signIns.cancel({ flowId }, mac.call);
    expect(seen!.aborted).toBe(true);
    answered.resolve(200);
    expect(await delivering).toMatchObject({ reason: "sign-in-conflict" });
  });

  it("sends no grant to a connection that cannot relay; it pastes instead", async () => {
    const replay = vi.fn(async () => 200);
    const h = harness({ flows: { anthropic: loopbackFlow(() => 53692) }, replay });
    const phone = connection("phone", ["sign-ins"]);
    const { flowId } = h.signIns.start({ providerId: "anthropic" }, phone.call);
    const stream = record(h.signIns, flowId, phone.call);
    await stream.opened;
    expect(stream.updates.map((update) => update.kind)).toEqual(["auth-url", "prompt"]);
    expect(
      await refusal(() =>
        h.signIns.deliverCallback({ flowId, pathAndQuery: "/callback?code=c" }, phone.call),
      ),
    ).toMatchObject({ reason: "sign-in-conflict" });
    expect(replay).not.toHaveBeenCalled();
  });

  it("relays to a real loopback listener: the host exchanges the code, the Client sees a status", async () => {
    const received: string[] = [];
    const callback = Promise.withResolvers<{ code: string }>();
    // Pi's callback listener: the path, then `state`, then the exchange.
    const server = createServer((request, response) => {
      received.push(request.url ?? "");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== "s") {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" }).end("Signed in");
      callback.resolve({ code: url.searchParams.get("code")! });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    callbackOnce = () => callback.promise;
    const h = harness({ flows: { anthropic: loopbackFlow(() => port) } });
    const mac = connection("mac");
    const { flowId } = h.signIns.start({ providerId: "anthropic" }, mac.call);
    const stream = record(h.signIns, flowId, mac.call);
    await stream.opened;
    const grant = stream.updates.find((update) => update.kind === "auth-callback");
    expect(grant).toEqual({
      kind: "auth-callback",
      flowId,
      redirectUri: `http://localhost:${port}/callback`,
    });
    expect(
      await h.signIns.deliverCallback(
        { flowId, pathAndQuery: "/callback?code=REAL-CODE&state=s" },
        mac.call,
      ),
    ).toEqual({ status: 200 });
    await until(() => stream.updates.at(-1)?.kind === "done");
    expect(received).toEqual(["/callback?code=REAL-CODE&state=s"]);
    // The race's paste prompt was withdrawn when the callback won.
    expect(stream.updates.map((update) => update.kind)).toEqual([
      "auth-callback",
      "auth-url",
      "prompt",
      "prompt-withdrawn",
      "done",
    ]);
    expect(JSON.stringify(stream.updates)).not.toContain("REAL-CODE");
  });
});
