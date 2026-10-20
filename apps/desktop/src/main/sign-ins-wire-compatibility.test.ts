// @vitest-environment node
/**
 * Sign-ins on a host (VC-702): committed public-wire recordings, VC-669's
 * ceremony for a newly public feature (HP § N−1 public wire recordings).
 *
 * - `sign-ins-wire-fixtures/current.json` pins what today's host answers on
 *   the wire for the `sign-ins` and `auth.callback` operations: status, a key
 *   sent write-only, a device-code flow, a relayed browser flow, a refusal,
 *   and what an older Client is granted. It is recorded through the real
 *   production listener and the stock tRPC WebSocket client, from a
 *   deterministic host (scripted Pi, fake stores, a fake loopback replay),
 *   never written by hand or read back into the host.
 * - `sign-ins-wire-fixtures/n-minus-one.json` is the bootstrap pre-VC-702
 *   reconstruction, not a distributed release. It offers neither feature,
 *   and preserves what the frozen router (VC-669's peer,
 *   `session-rpc-n-minus-one.test-support.ts`) answers a call to an
 *   operation it never had.
 *
 * When a recorded canary bundle is present, both skew directions replay that
 * release instead. Otherwise the bootstrap cases run: a new Client reads no
 * `sign-ins` off its welcome and hides the rows; an old Client against
 * today's host is granted neither feature and is refused before any input is
 * read. Sign-ins are WebSocket-only, so there is no IPC leg.
 *
 * Refresh `current.json` with `VOLLI_RECORD_SIGN_IN_WIRE=1` and review the
 * diff; never refresh `n-minus-one.json` to make a change pass.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { createTRPCClient, createWSClient, getUntypedClient, wsLink } from "@trpc/client";
import type { PiSignIn, PiSignInSteps } from "@volli/agent-runtime";
import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import { HostSignIns } from "@volli/host-core/session-runtime";
import {
  buildHostHello,
  encodeHostHello,
  hostOffersSignIns,
  readHostError,
  validateWelcome,
  type HostHello,
  type HostWelcome,
} from "@volli/host-protocol";
import { recordSubscription, webSocketContractLink } from "@volli/host-protocol/testing";
import {
  createHostRouter,
  HostProcedureError,
  hostSignInUpdateSchema,
  RpcDiagnosticLog,
  sessionProcedureSchemas,
  type HostRouter,
} from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import type { HostSignInUpdate } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { createOldSessionRouter, loadCanaryPeer } from "./session-rpc-n-minus-one.test-support";

import {
  captureCanaryRecording,
  checkNextHost,
  recordingExchanges,
  replayCanaryPeer,
  peerInput,
} from "../../../../packages/session-rpc/src/canary-peer.test-support";
const canary = process.env.VOLLI_CANARY_CAPTURE_DIR ? null : loadCanaryPeer();

const CURRENT = new URL("./sign-ins-wire-fixtures/current.json", import.meta.url);
const N_MINUS_ONE = new URL("./sign-ins-wire-fixtures/n-minus-one.json", import.meta.url);
const RECORD = process.env["VOLLI_RECORD_SIGN_IN_WIRE"] === "1";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const HOST_ID = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const DEVICE = {
  kind: "device" as const,
  deviceId: "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d",
  workspaceId: WORKSPACE,
};
/** What today's hostd offers, and what today's desktop asks for. */
const OFFERED = [
  "sessions",
  "sessions.queue",
  "sessions.subscribe",
  "sessions.history",
  "session.read",
  "board.read",
  "board.write",
  "sign-ins",
  "auth.callback",
] as const;
const REQUESTED = OFFERED;
/** A placeholder, not a credential: the wire must never carry it back. */
const FIXTURE_KEY = "sk-fixture-WIRE-RECORDING-ONLY";

interface Recording {
  readonly procedure: string;
  readonly input: unknown;
  readonly output: unknown;
}

interface CurrentWire {
  readonly provenance: Record<string, unknown>;
  readonly welcome: { requested: readonly string[]; granted: readonly string[] };
  readonly status: Recording;
  readonly setApiKey: Recording;
  readonly deviceCode: { start: Recording; frames: readonly HostSignInUpdate[] };
  readonly relay: { start: Recording; frames: readonly HostSignInUpdate[]; deliver: Recording };
  readonly refusal: Recording;
  readonly oldClient: {
    requested: readonly string[];
    granted: readonly string[];
    refusal: Recording;
  };
}

interface FrozenWire {
  readonly provenance: Record<string, unknown>;
  readonly hostOffered: readonly string[];
  readonly clientRequested: readonly string[];
  readonly unknownOperation: Recording;
}

function read<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

/** Deterministic: ids from a counter, statuses from fixed rows, the replay a fake answering 200. */
function deterministicHost() {
  let ids = 0;
  const approve = Promise.withResolvers<void>();
  const keyed = new Set<string>();
  const flows: Record<string, (steps: PiSignInSteps, signal: AbortSignal) => Promise<void>> = {
    xai: async (steps) => {
      steps.say({
        kind: "device-code",
        userCode: "WXYZ-1234",
        verificationUri: "https://accounts.x.ai/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      });
      await approve.promise;
    },
    anthropic: async (steps) => {
      steps.say({
        kind: "auth-url",
        url:
          "https://claude.ai/oauth/authorize?code=true&state=pkce&redirect_uri=" +
          encodeURIComponent("http://localhost:53692/callback"),
        instructions: null,
      });
      const withdrawn = new AbortController();
      const pasted = steps.ask(
        {
          promptId: steps.newId(),
          kind: "manual-code",
          message: "Paste the authorization code",
          placeholder: null,
          options: [],
        },
        withdrawn.signal,
      );
      pasted.catch(() => {});
      await delivered.promise;
      withdrawn.abort();
    },
  };
  const delivered = Promise.withResolvers<void>();
  const pi: PiSignIn = {
    offers: (providerId, type) => type === "api-key" || providerId in flows,
    login: (providerId, _type, signal, steps) => flows[providerId]!(steps, signal),
    logout: async () => {},
  };
  const signIns = new HostSignIns({
    pi,
    inspect: async () => ({
      observedAt: 0,
      providers: ["anthropic", "openrouter", "xai"].map((id) => ({
        id,
        label: id === "anthropic" ? "Claude" : id === "xai" ? "xAI" : "OpenRouter",
        state: keyed.has(id) ? ("available" as const) : ("authentication-required" as const),
        accountLabel: null,
        billingSource: "unknown" as const,
        recovery: null,
        signIn:
          id === "openrouter"
            ? [{ type: "api-key" as const, label: "API key", isSubscription: false }]
            : [{ type: "oauth" as const, label: "Subscription", isSubscription: true }],
        hasStoredCredential: keyed.has(id),
      })),
      models: [],
    }),
    keys: {
      models: {
        setApiKey: async (providerId) => {
          keyed.add(providerId);
        },
        stored: async () =>
          [...keyed].map((providerId) => ({
            providerId,
            type: "api-key" as const,
            expiresAt: null,
          })),
      },
      git: {
        hosts: async () => [],
        get: async () => null,
        set: async () => {},
        clear: async () => {},
      },
    },
    replay: async () => {
      delivered.resolve();
      return 200;
    },
    newId: () => `id-${++ids}`,
  });
  const handlers = admittedHandlers(
    createHostHandlers({ events: { publish() {} }, attention: { deliver: () => ({}) } } as never, {
      db: null,
      dataDir: "",
      runtime: null,
      sessions: null,
      modelAccess: null,
      experiments: null,
      automations: { kind: "degraded" } as never,
      busyWorktreeSites: async () => [],
      signIns,
    }),
    ROUTER_POLICY,
  );
  return { handlers, approve };
}

/** Today's host behind the production listener, and a stock client saying `features`. */
async function todaysHost(features: readonly string[]) {
  const host = deterministicHost();
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST_ID, version: "wire-recording" },
    workspace: () => ({ id: WORKSPACE, epoch: 1 }),
    verifier: { verify: async () => ({ actor: DEVICE, current: () => true }) },
    features: OFFERED,
    context: () => ({ handlers: host.handlers, diagnostics: new RpcDiagnosticLog() }),
  });
  const hello = buildHostHello({
    client: { kind: "desktop", version: "wire-recording" },
    workspaceId: WORKSPACE,
    lastSeen: null,
    features,
    credential: "test-only-credential",
  });
  const socket = createWSClient({ url: listener.url, connectionParams: encodeHostHello(hello) });
  const client = createTRPCClient<HostRouter>({ links: [wsLink({ client: socket })] });
  return {
    client,
    raw: getUntypedClient(client),
    approve: host.approve,
    close: async () => {
      await socket.close();
      await listener.close();
    },
  };
}

async function framesOf(
  client: Awaited<ReturnType<typeof todaysHost>>["client"],
  flowId: string,
  untilCount: number,
): Promise<{ frames: HostSignInUpdate[]; stop(): void }> {
  const stream = recordSubscription<HostSignInUpdate>((handlers) =>
    client.signIns.subscribe.subscribe({ flowId }, handlers),
  );
  await stream.received(untilCount);
  return { frames: stream.frames as HostSignInUpdate[], stop: stream.unsubscribe };
}

async function refusalOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return readHostError(error);
  }
  throw new Error("expected a refusal");
}

/** Records what today's host answers, through the real listener and client. */
async function recordCurrent(): Promise<Omit<CurrentWire, "provenance">> {
  const host = await todaysHost(REQUESTED);
  try {
    const welcome = await host.client.protocol.welcome.query();
    const status: Recording = {
      procedure: "signIns.status",
      input: null,
      output: await host.client.signIns.status.query(),
    };
    const setApiKeyInput = peerInput(canary, "sign-ins-websocket", "signIns.setApiKey", {
      providerId: "openrouter",
      key: FIXTURE_KEY,
    });
    const setApiKey: Recording = {
      procedure: "signIns.setApiKey",
      input: setApiKeyInput,
      output: await host.client.signIns.setApiKey.mutate(setApiKeyInput),
    };
    const deviceStart = peerInput(canary, "sign-ins-websocket", "signIns.start", {
      providerId: "xai",
    });
    const deviceFlow = await host.client.signIns.start.mutate(deviceStart);
    const deviceStream = await framesOf(host.client, deviceFlow.flowId, 1);
    host.approve.resolve();
    const deviceFrames = await waitForEnd(deviceStream);
    const relayStart = peerInput(
      canary,
      "sign-ins-websocket",
      "signIns.start",
      { providerId: "anthropic" },
      1,
    );
    const relayFlow = await host.client.signIns.start.mutate(relayStart);
    const relayStream = await framesOf(host.client, relayFlow.flowId, 3);
    const deliverInput = peerInput(canary, "sign-ins-websocket", "auth.callback.deliver", {
      flowId: relayFlow.flowId,
      pathAndQuery: "/callback?code=fixture-code&state=pkce",
    });
    const deliverOutput = await host.client.auth.callback.deliver.mutate(deliverInput);
    const relayFrames = await waitForEnd(relayStream);
    const refusalInput = peerInput(canary, "sign-ins-websocket", "signIns.cancel", {
      flowId: "another-connections-flow",
    });
    const old = await todaysHost(N_MINUS_ONE_CLIENT_REQUEST());
    let oldClient: CurrentWire["oldClient"];
    try {
      oldClient = {
        requested: N_MINUS_ONE_CLIENT_REQUEST(),
        granted: (await old.client.protocol.welcome.query()).features,
        refusal: {
          procedure: "signIns.status",
          input: null,
          output: await refusalOf(old.raw.query("signIns.status", undefined)),
        },
      };
    } finally {
      await old.close();
    }
    return {
      welcome: { requested: REQUESTED, granted: welcome.features },
      status,
      setApiKey,
      deviceCode: {
        start: { procedure: "signIns.start", input: deviceStart, output: deviceFlow },
        frames: deviceFrames,
      },
      relay: {
        start: { procedure: "signIns.start", input: relayStart, output: relayFlow },
        frames: relayFrames,
        deliver: { procedure: "auth.callback.deliver", input: deliverInput, output: deliverOutput },
      },
      refusal: {
        procedure: "signIns.cancel",
        input: refusalInput,
        output: await refusalOf(host.client.signIns.cancel.mutate(refusalInput)),
      },
      oldClient,
    };
  } finally {
    await host.close();
  }
}

async function waitForEnd(stream: { frames: HostSignInUpdate[]; stop(): void }) {
  for (let tries = 0; tries < 200; tries++) {
    const last = stream.frames.at(-1);
    if (last !== undefined && ["done", "failed", "cancelled"].includes(last.kind)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  stream.stop();
  return [...stream.frames];
}

function N_MINUS_ONE_CLIENT_REQUEST(): readonly string[] {
  return read<FrozenWire>(N_MINUS_ONE).clientRequested;
}

describe("sign-ins on the public wire (VC-702)", () => {
  it("today's host answers exactly the committed recordings", async () => {
    const recorded = await recordCurrent();
    const exchanges = recordingExchanges(recorded);
    captureCanaryRecording("sign-ins-websocket", "websocket", recorded, exchanges);
    if (canary) checkNextHost(canary, "sign-ins-websocket", recorded);
    if (RECORD) {
      const provenance = read<CurrentWire>(CURRENT).provenance;
      writeFileSync(CURRENT, `${JSON.stringify({ provenance, ...recorded }, null, 2)}\n`);
    }
    const { provenance: _provenance, ...committed } = read<CurrentWire>(CURRENT);
    expect(recorded).toEqual(committed);
    // Values travel in, never out: the key is in the request it was sent in, and nowhere else.
    const { setApiKey, ...answers } = committed;
    expect(JSON.stringify([setApiKey.output, answers])).not.toContain(FIXTURE_KEY);
  });

  it("every recorded answer parses with today's published schemas", () => {
    const wire = read<CurrentWire>(CURRENT);
    const schemas = sessionProcedureSchemas();
    for (const recording of [
      wire.status,
      wire.setApiKey,
      wire.deviceCode.start,
      wire.relay.start,
      wire.relay.deliver,
    ]) {
      expect(schemas[recording.procedure]!.input.safeParse(recording.input).success).toBe(true);
      expect(schemas[recording.procedure]!.output.safeParse(recording.output).success).toBe(true);
    }
    for (const frame of [...wire.deviceCode.frames, ...wire.relay.frames]) {
      expect(hostSignInUpdateSchema.safeParse(frame).success).toBe(true);
    }
    expect(wire.relay.frames[0]).toMatchObject({ kind: "auth-callback" });
  });

  it.runIf(!canary)(
    "a new Client hides sign-ins for the older host, which never had them",
    async () => {
      const frozen = read<FrozenWire>(N_MINUS_ONE);
      // The older host's welcome, judged by today's Client against today's hello.
      const hello: HostHello = buildHostHello({
        client: { kind: "desktop", version: "new" },
        workspaceId: WORKSPACE,
        lastSeen: null,
        features: REQUESTED,
        credential: "test-only-credential",
      });
      const welcome: HostWelcome = {
        protocolVersion: 1,
        host: { id: HOST_ID, version: "n-minus-one" },
        workspace: { id: WORKSPACE, epoch: 1 },
        actor: DEVICE,
        features: REQUESTED.filter((feature) => frozen.hostOffered.includes(feature)),
        proof: null,
      };
      expect(validateWelcome(welcome, hello, {})).toMatchObject({ ok: true });
      expect(hostOffersSignIns(welcome)).toBe(false);
      // A call anyway reaches the frozen peer's router, which has no such operation.
      const frozenHost = webSocketContractLink<null, HostRouter>({
        router: createOldSessionRouter(HostProcedureError) as unknown as HostRouter,
        createContext: () => ({}) as never,
      });
      const connection = await frozenHost.open(null);
      try {
        const answer = await refusalOf(
          getUntypedClient(connection.client).query("signIns.status", undefined),
        );
        expect({ procedure: "signIns.status", input: null, output: answer }).toEqual(
          frozen.unknownOperation,
        );
      } finally {
        await connection.close();
      }
    },
  );

  it.runIf(!canary)(
    "an older Client is granted neither feature by today's host, and refused before input",
    () => {
      const wire = read<CurrentWire>(CURRENT);
      expect(wire.oldClient.granted).not.toContain("sign-ins");
      expect(wire.oldClient.granted).not.toContain("auth.callback");
      expect(wire.oldClient.refusal.output).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
    },
  );
});

it.runIf(!!canary)(
  "next Client reads the actual canary sign-ins over the WebSocket adapter",
  async () => {
    await replayCanaryPeer(canary!, "sign-ins-websocket", sessionProcedureSchemas());
  },
);
