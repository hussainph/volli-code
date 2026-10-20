// @vitest-environment node
/**
 * Sign-ins on a host over the host protocol (VC-702), one set of cases on
 * both WebSocket links (`@volli/host-protocol/testing`): the stock tRPC
 * adapter with a door-built context, and the production listener's real
 * handshake. Both reach the host's real handler map and the real
 * `HostSignIns`, over a scripted Pi (no provider is ever reached), fake
 * stores, and a fake provider loopback for the relay.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { TRPCClient } from "@trpc/client";
import type { PiSignIn, PiSignInSteps } from "@volli/agent-runtime";
import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import { HostSignIns, type HostSignInKeyProvider } from "@volli/host-core/session-runtime";
import {
  buildHostHello,
  encodeHostHello,
  hostOffersSignIns,
  operationsGrantedBy,
  type HostActor,
  type HostV1Feature,
  type HostWelcome,
} from "@volli/host-protocol";
import {
  describeContract,
  expectHostError,
  recordSubscription,
  servedWebSocketContractLink,
  webSocketContractLink,
} from "@volli/host-protocol/testing";
import { createSessionRouter, RpcDiagnosticLog, type AppRouter } from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import type { HostSignInUpdate, ModelAccessProvider } from "@volli/shared";
import { afterEach, expect, it } from "vite-plus/test";

import { HOSTD_FEATURES } from "./host-protocol";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const HOST_ID = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const DEVICE: HostActor = {
  kind: "device",
  deviceId: "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d",
  workspaceId: WORKSPACE,
};
const SESSION_ACTOR: HostActor = {
  kind: "session",
  sessionId: "9b0c1d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e",
  workspaceId: WORKSPACE,
};
const API_KEY = "sk-ant-api03-SENT-FROM-THIS-MAC-0123456789";
const GIT_TOKEN = "ghp_SENTFROMTHISMACPUSHTOKEN012345";
const CODE = "AUTHCODE-FROM-THE-BROWSER-0123456789";

/** The features a Client of this build asks for. */
const CLIENT_FEATURES: readonly HostV1Feature[] = ["sessions", "sign-ins", "auth.callback"];

interface Fixture {
  readonly signIns: HostSignIns;
  /** What each connection asks for; a case changes it before it connects. */
  features: readonly string[];
  actor: HostActor;
  /** What the host offers: a test of an older host narrows it. */
  offered: readonly HostV1Feature[];
  /** The fake provider's loopback port, once it listens. */
  port: number;
  readonly approve: PromiseWithResolvers<void>;
  readonly callbacks: string[];
  /** The router's route diagnostics, on every connection to this host. */
  readonly diagnostics: RpcDiagnosticLog;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

function provider(id: string): ModelAccessProvider {
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
  };
}

/**
 * A scripted Pi: xAI is a device-code flow; Anthropic a browser flow whose
 * loopback listener races a pasted code, exactly as pi-ai's is.
 */
function scriptedPi(fixture: () => Fixture): PiSignIn {
  const flows: Record<string, (steps: PiSignInSteps, signal: AbortSignal) => Promise<void>> = {
    xai: async (steps) => {
      steps.say({
        kind: "device-code",
        userCode: "WXYZ-1234",
        verificationUri: "https://accounts.x.ai/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      });
      await fixture().approve.promise;
    },
    // pi-ai's GitHub Copilot: an optional enterprise domain first, where
    // blank is the ordinary answer (github.com), then a device code.
    "github-copilot": async (steps) => {
      const domain = await steps.ask(
        {
          promptId: steps.newId(),
          kind: "text",
          message: "GitHub Enterprise URL/domain (blank for github.com)",
          placeholder: "company.ghe.com",
          options: [],
        },
        undefined,
      );
      steps.say({
        kind: "device-code",
        userCode: "GHUB-0000",
        verificationUri: `https://${domain === "" ? "github.com" : domain}/login/device`,
        intervalSeconds: 5,
        expiresInSeconds: 900,
      });
      await fixture().approve.promise;
    },
    anthropic: async (steps, signal) => {
      const callback = Promise.withResolvers<string>();
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        fixture().callbacks.push(request.url ?? "");
        if (url.pathname !== "/callback" || url.searchParams.get("state") !== "pkce") {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(200).end("Signed in");
        callback.resolve(url.searchParams.get("code")!);
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      fixture().port = (server.address() as AddressInfo).port;
      steps.say({
        kind: "auth-url",
        url:
          "https://claude.ai/oauth/authorize?state=pkce&redirect_uri=" +
          encodeURIComponent(`http://localhost:${fixture().port}/callback`),
        instructions: null,
      });
      const raced = new AbortController();
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
      const code = await Promise.race([
        callback.promise,
        pasted.then((value) => new URL(value).searchParams.get("code")!),
      ]);
      raced.abort();
      signal.throwIfAborted();
      if (code !== CODE) throw new Error(`invalid_grant: ${code}`);
    },
  };
  return {
    offers: (providerId, type) => type === "api-key" || providerId in flows,
    login: (providerId, _type, signal, steps) => flows[providerId]!(steps, signal),
    logout: async () => {},
  };
}

function fakeKeys(models: Set<string>): HostSignInKeyProvider {
  const git = new Map<string, { username: string; password: string }>();
  return {
    models: {
      setApiKey: async (providerId) => {
        models.add(providerId);
      },
      stored: async () =>
        [...models].map((providerId) => ({
          providerId,
          type: "api-key" as const,
          expiresAt: null,
        })),
    },
    git: {
      hosts: async () => [...git.keys()],
      get: async (host) => git.get(host) ?? null,
      set: async (host, credential) => {
        git.set(host, credential);
      },
      clear: async (host) => {
        git.delete(host);
      },
    },
  };
}

function hostFixture(): Fixture {
  const keyed = new Set<string>();
  const fixture: Fixture = {
    signIns: new HostSignIns({
      pi: scriptedPi(() => fixture),
      // A stored key authenticates, as Pi's probe would find.
      inspect: async () => ({
        observedAt: 0,
        providers: ["anthropic", "xai"].map((id) => {
          const row = provider(id);
          if (keyed.has(id)) {
            row.state = "available";
            row.hasStoredCredential = true;
          }
          return row;
        }),
        models: [],
      }),
      keys: fakeKeys(keyed),
    }),
    features: CLIENT_FEATURES,
    actor: DEVICE,
    // A complete subset of what hostd offers: these cases serve the Session
    // router's family, where the sign-ins are.
    offered: ["sessions", "sign-ins", "auth.callback"],
    port: 0,
    approve: Promise.withResolvers<void>(),
    callbacks: [],
    diagnostics: new RpcDiagnosticLog(),
  };
  return fixture;
}

/** The host's one handler map, as hostd composes it, projected through the router's policy. */
function handlersFor(fixture: Fixture) {
  return admittedHandlers(
    createHostHandlers({ events: { publish() {} }, attention: { deliver: () => ({}) } } as never, {
      db: null,
      dataDir: "",
      runtime: null,
      sessions: null,
      modelAccess: null,
      experiments: null,
      automations: { kind: "degraded" } as never,
      busyWorktreeSites: async () => [],
      signIns: fixture.signIns,
    }),
    ROUTER_POLICY,
  );
}

/** The stock adapter: a door-built context, with the connection a door mints. */
const stockLink = {
  ...webSocketContractLink<Fixture, AppRouter>({
    router: createSessionRouter(),
    createContext: (fixture) => {
      const granted = fixture.features.filter((feature) =>
        (fixture.offered as readonly string[]).includes(feature),
      );
      const welcome: HostWelcome = {
        protocolVersion: 1,
        host: { id: HOST_ID, version: "test" },
        workspace: { id: WORKSPACE, epoch: 1 },
        actor: fixture.actor,
        features: granted,
        proof: null,
      };
      return {
        caller: { actor: fixture.actor, current: () => true },
        transport: "websocket" as const,
        operations: operationsGrantedBy(granted),
        welcome,
        connectionId: randomUUID(),
        admission: {
          signal: new AbortController().signal,
          openStream: () => true,
          closeStream: () => {},
        },
        handlers: handlersFor(fixture),
        diagnostics: fixture.diagnostics,
      };
    },
  }),
  name: "the stock adapter",
};

/** The production listener: its own handshake, verifier port and context. */
const listenerLink = {
  ...servedWebSocketContractLink<Fixture, AppRouter>({
    serve: async (fixture) => {
      const listener = await startHostProtocolListener({
        router: createSessionRouter(),
        bind: { host: "127.0.0.1", port: 0 },
        host: { id: HOST_ID, version: "test" },
        workspace: () => ({ id: WORKSPACE, epoch: 1 }),
        verifier: { verify: async () => ({ actor: fixture.actor, current: () => true }) },
        features: fixture.offered,
        context: () => ({ handlers: handlersFor(fixture), diagnostics: fixture.diagnostics }),
      });
      return { url: listener.url, close: () => listener.close() };
    },
    connectionParams: (fixture) =>
      encodeHostHello(
        buildHostHello({
          client: { kind: "desktop", version: "test" },
          workspaceId: WORKSPACE,
          lastSeen: null,
          features: fixture.features,
          credential: "test-only-credential",
        }),
      ),
  }),
  name: "the production listener",
};

function follow(client: TRPCClient<AppRouter>, flowId: string) {
  return recordSubscription<HostSignInUpdate>((handlers) =>
    client.signIns.subscribe.subscribe({ flowId }, handlers),
  );
}

describeContract<Fixture, AppRouter>(
  "Sign-ins on a host",
  [stockLink, listenerLink],
  ({ connect }) => {
    it("takes a key and a push token write-only: no answer or diagnostic carries either", async () => {
      const host = hostFixture();
      const client = await connect(host);
      const keyed = await client.signIns.setApiKey.mutate({
        providerId: "anthropic",
        key: API_KEY,
      });
      expect(keyed.providers.find((row) => row.providerId === "anthropic")).toMatchObject({
        state: "signed-in",
        kind: "api-key",
      });
      const pushed = await client.signIns.setGitCredential.mutate({
        host: "github.com",
        username: "x-access-token",
        password: GIT_TOKEN,
      });
      expect(pushed.git).toEqual([{ host: "github.com", state: "signed-in", kind: "git" }]);
      const status = await client.signIns.status.query();
      expect(status).toEqual(pushed);
      const wire = JSON.stringify([keyed, pushed, status]);
      expect(wire).not.toContain(API_KEY);
      expect(wire).not.toContain(GIT_TOKEN);
      // An over-long key is refused at the door, and the refusal quotes nothing.
      const refused = await expectHostError(
        client.signIns.setApiKey.mutate({ providerId: "anthropic", key: API_KEY.repeat(1000) }),
      );
      expect(refused.code).toBe("BAD_REQUEST");
      expect(JSON.stringify(refused)).not.toContain(API_KEY);
      // The router's diagnostics record routes, and the refusal, never a value.
      const diagnostics = JSON.stringify(host.diagnostics.list());
      expect(diagnostics).toContain("signIns.setApiKey");
      expect(diagnostics).not.toContain(API_KEY);
      expect(diagnostics).not.toContain(GIT_TOKEN);
    });

    it("runs a device-code login on the host and turns signed-in by itself", async () => {
      const host = hostFixture();
      const client = await connect(host);
      const { flowId } = await client.signIns.start.mutate({ providerId: "xai" });
      const stream = follow(client, flowId);
      const [code] = await stream.received(1);
      expect(code).toMatchObject({ kind: "device-code", userCode: "WXYZ-1234" });
      host.approve.resolve();
      expect(await stream.ended).toEqual({ kind: "complete" });
      expect(stream.frames.map((update) => update.kind)).toEqual(["device-code", "done"]);
    });

    it("relays the browser's redirect once, through a fake provider loopback", async () => {
      const host = hostFixture();
      const client = await connect(host);
      const { flowId } = await client.signIns.start.mutate({ providerId: "anthropic" });
      const stream = follow(client, flowId);
      const [grant, url] = await stream.received(2);
      expect(grant).toEqual({
        kind: "auth-callback",
        flowId,
        redirectUri: `http://localhost:${host.port}/callback`,
      });
      expect(url).toMatchObject({ kind: "auth-url" });
      // What the Client's one-request listener received, delivered once.
      const pathAndQuery = `/callback?code=${CODE}&state=pkce`;
      expect(await client.auth.callback.deliver.mutate({ flowId, pathAndQuery })).toEqual({
        status: 200,
      });
      expect(await stream.ended).toEqual({ kind: "complete" });
      expect(stream.frames.at(-1)).toEqual({ kind: "done" });
      expect(host.callbacks).toEqual([pathAndQuery]);
      expect(
        await expectHostError(client.auth.callback.deliver.mutate({ flowId, pathAndQuery })),
      ).toMatchObject({ code: "CONFLICT", reason: "sign-in-conflict" });
      // The code reached the host's listener, never a frame on the wire.
      expect(JSON.stringify(stream.frames)).not.toContain(CODE);
    });

    it("falls back to the pasted redirect for a Client that cannot relay", async () => {
      const host = hostFixture();
      host.features = ["sign-ins"];
      const client = await connect(host);
      const { flowId } = await client.signIns.start.mutate({ providerId: "anthropic" });
      const stream = follow(client, flowId);
      const [first, prompt] = await stream.received(2);
      expect(first).toMatchObject({ kind: "auth-url" });
      expect(prompt).toMatchObject({ kind: "prompt", prompt: { kind: "manual-code" } });
      // No relay grant without `auth.callback`, and no way to deliver one.
      expect(
        await expectHostError(
          client.auth.callback.deliver.mutate({ flowId, pathAndQuery: "/callback?code=x" }),
        ),
      ).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
      await client.signIns.answer.mutate({
        flowId,
        promptId: (prompt as Extract<HostSignInUpdate, { kind: "prompt" }>).prompt.promptId,
        value: `http://localhost:${host.port}/callback?code=${CODE}&state=pkce`,
      });
      expect(await stream.ended).toEqual({ kind: "complete" });
      expect(stream.frames.map((update) => update.kind)).toEqual(["auth-url", "prompt", "done"]);
      expect(JSON.stringify(stream.frames)).not.toContain(CODE);
    });

    it("takes a blank answer: GitHub Copilot's enterprise domain, blank for github.com", async () => {
      const host = hostFixture();
      const client = await connect(host);
      const { flowId } = await client.signIns.start.mutate({ providerId: "github-copilot" });
      const stream = follow(client, flowId);
      const [prompt] = await stream.received(1);
      expect(prompt).toMatchObject({ kind: "prompt", prompt: { kind: "text" } });
      await client.signIns.answer.mutate({
        flowId,
        promptId: (prompt as Extract<HostSignInUpdate, { kind: "prompt" }>).prompt.promptId,
        value: "",
      });
      const [, code] = await stream.received(2);
      expect(code).toMatchObject({
        kind: "device-code",
        verificationUri: "https://github.com/login/device",
      });
      host.approve.resolve();
      expect(await stream.ended).toEqual({ kind: "complete" });
    });

    it("refuses another connection's flow exactly as an absent one", async () => {
      const host = hostFixture();
      const owner = await connect(host);
      const other = await connect(host);
      const { flowId } = await owner.signIns.start.mutate({ providerId: "xai" });
      const absent = await expectHostError(other.signIns.cancel.mutate({ flowId: "no-such-flow" }));
      expect(absent).toMatchObject({ code: "NOT_FOUND", reason: "sign-in-unknown" });
      expect(await expectHostError(other.signIns.cancel.mutate({ flowId }))).toEqual(absent);
      expect(
        await expectHostError(
          other.signIns.answer.mutate({ flowId, promptId: "p", value: "hijack" }),
        ),
      ).toEqual(absent);
      expect(
        await expectHostError(
          other.auth.callback.deliver.mutate({ flowId, pathAndQuery: "/callback?code=x" }),
        ),
      ).toEqual(absent);
      const hijack = follow(other, flowId);
      expect(await hijack.ended).toEqual({ kind: "error", error: absent });
      // The owner's flow is untouched.
      const mine = follow(owner, flowId);
      expect((await mine.received(1))[0]).toMatchObject({ kind: "device-code" });
      host.approve.resolve();
      expect(await mine.ended).toEqual({ kind: "complete" });
    });

    it("is the person's alone: a Session is refused before anything is read", async () => {
      const host = hostFixture();
      host.actor = SESSION_ACTOR;
      const client = await connect(host);
      expect(await expectHostError(client.signIns.status.query())).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
      expect(
        await expectHostError(
          client.signIns.setApiKey.mutate({ providerId: "anthropic", key: API_KEY }),
        ),
      ).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
    });

    it("an older host offers no sign-ins, so the Client hides them (N−1)", async () => {
      const host = hostFixture();
      // What a host before VC-702 offers: nothing of these.
      host.offered = ["sessions"];
      const client = await connect(host);
      const welcome = await client.protocol.welcome.query().catch(() => null);
      if (welcome !== null) {
        // The production listener's welcome: what the Client branches on.
        expect(welcome.features).not.toContain("sign-ins");
        expect(hostOffersSignIns(welcome)).toBe(false);
      }
      expect(await expectHostError(client.signIns.status.query())).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
    });
  },
);

it("the Client reads sign-ins off a current host's welcome", () => {
  expect(hostOffersSignIns({ features: HOSTD_FEATURES })).toBe(true);
  expect(hostOffersSignIns({ features: ["sessions", "session.read"] })).toBe(false);
});
