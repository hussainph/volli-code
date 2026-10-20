// @vitest-environment node
/**
 * Actual host-scope canary exchanges (VC-727), captured through the production
 * listener and the stock tRPC WebSocket client. No IPC exposure: these public
 * operations belong to a host-scoped connection, not the desktop's IPC tier.
 *
 * In capture mode the deterministic handlers produce the release's answers.
 * Otherwise the selected artifact supplies the OLD requests, while today's
 * real listener produces fresh answers for its frozen decoder/semantics.
 * The reverse direction replays that same artifact over a real WebSocket and
 * applies today's published decoders, never today's router as the old peer.
 */
import { createTRPCClient, createWSClient, getUntypedClient, wsLink } from "@trpc/client";
import {
  buildHostHello,
  encodeHostHello,
  type HostConnectionCredentialPresentation,
} from "@volli/host-protocol";
import type {
  HostWorkspace,
  HostWorkspaceCreateInput,
  HostWorkspaceCreateResult,
} from "@volli/shared";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { fakeBoard } from "./board-host.test-support";
import {
  captureCanaryRecording,
  checkNextHost,
  loadCanaryPeer,
  peerInput,
  recordingExchanges,
  replayCanaryPeer,
  type PeerExchange,
} from "./canary-peer.test-support";
import { createHostRouter, type HostRouter } from "./host-router";
import { RpcDiagnosticLog, sessionProcedureSchemas, type ProcedureSchema } from "./index";
import { sessionHandlersFrom } from "./session-handlers.test-support";
import { startHostProtocolListener } from "./websocket-server";
import { workspacesProcedureSchemas, type WorkspaceHandlers } from "./workspaces-router";

const NAME = "host-scope-websocket";
const canary = process.env.VOLLI_CANARY_CAPTURE_DIR ? null : loadCanaryPeer();
const HOST = "7b026a53-4c3f-45cb-a11a-e7b1649f9f92";
const DEVICE = "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d";
const FEATURES = ["host.workspaces"];
const EXISTING: HostWorkspace = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  name: "Existing project",
  path: "/work/existing-project",
  gitRemoteUrl: "https://example.test/existing-project.git",
};
const CREATED_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const CREATE: HostWorkspaceCreateInput = {
  commandId: "c239ee5b-2ca0-4e30-b69e-73e63f7f54ba",
  source: { path: "/work/recorded-project" },
  name: "Recorded project",
};

interface Recording {
  welcome: PeerExchange;
  initialList: PeerExchange;
  create: PeerExchange;
  retry: PeerExchange;
  listAfterCreate: PeerExchange;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** In-memory registration/command deduplication only; no filesystem or host services. */
function fixture() {
  const rows: HostWorkspace[] = [structuredClone(EXISTING)];
  const commands = new Map<string, HostWorkspaceCreateResult>();
  const effects: string[] = [];
  const list: WorkspaceHandlers["workspaces.list"] = vi.fn((_input, call) => {
    expect(call.actor).toStrictEqual({ kind: "user" });
    return { workspaces: structuredClone(rows), omitted: 0 };
  });
  const create: WorkspaceHandlers["workspaces.create"] = vi.fn((input, call) => {
    expect(call.actor).toStrictEqual({ kind: "user" });
    const prior = commands.get(input.commandId);
    if (prior) return structuredClone(prior);
    const workspace: HostWorkspace = {
      id: CREATED_ID,
      name: input.name ?? "Recorded project",
      path: "path" in input.source ? input.source.path : "/work/recorded-project",
      gitRemoteUrl: "gitUrl" in input.source ? input.source.gitUrl : null,
    };
    const result: HostWorkspaceCreateResult = { ok: true, workspace };
    commands.set(input.commandId, structuredClone(result));
    rows.push(workspace);
    effects.push(input.commandId);
    return result;
  });
  return { handlers: { "workspaces.list": list, "workspaces.create": create }, effects };
}

async function observe(): Promise<Recording> {
  const host = fixture();
  const workspace = vi.fn(() => {
    throw new Error("Host scope must not look up a Workspace");
  });
  const verifier = vi.fn((presentation: HostConnectionCredentialPresentation) => {
    expect(presentation).toMatchObject({ scope: "host", credential: "test-only-host-token" });
    expect(presentation).not.toHaveProperty("workspaceId");
    return {
      actor: { kind: "device" as const, deviceId: DEVICE, scope: "host" as const },
      current: () => true,
    };
  });
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST, version: "host-scope-wire" },
    features: FEATURES,
    hostFeatures: FEATURES,
    workspace,
    verifier: { verify: verifier },
    context: () => ({
      handlers: {
        ...sessionHandlersFrom({ runtime: {} }),
        ...fakeBoard().handlers,
        ...host.handlers,
      },
      diagnostics: new RpcDiagnosticLog(),
    }),
  });
  cleanups.push(() => listener.close());
  const socket = createWSClient({
    url: listener.url,
    connectionParams: encodeHostHello(
      buildHostHello({
        scope: "host",
        client: { kind: "desktop", version: "host-scope-wire" },
        features: FEATURES,
        credential: "test-only-host-token",
      }),
    ),
  });
  cleanups.push(() => socket.close());
  const client = getUntypedClient(
    createTRPCClient<HostRouter>({ links: [wsLink({ client: socket })] }),
  );

  // Each occurrence comes from the artifact, including the retry and second
  // list. Never silently replace a missing frozen exchange with a new request.
  const welcomeInput = peerInput(canary, NAME, "protocol.hostWelcome", null);
  const welcome = await client.query("protocol.hostWelcome", welcomeInput);
  const listInput = peerInput(canary, NAME, "workspaces.list", null);
  const initialList = await client.query("workspaces.list", listInput);
  const createInput = peerInput(canary, NAME, "workspaces.create", CREATE);
  const created = await client.mutation("workspaces.create", createInput);
  const retryInput = peerInput(canary, NAME, "workspaces.create", CREATE, 1);
  const retried = await client.mutation("workspaces.create", retryInput);
  const afterInput = peerInput(canary, NAME, "workspaces.list", null, 1);
  const after = await client.query("workspaces.list", afterInput);

  expect(welcome).toMatchObject({
    scope: "host",
    protocolVersion: 1,
    host: { id: HOST, version: "host-scope-wire" },
    actor: { kind: "device", deviceId: DEVICE, scope: "host" },
    features: FEATURES,
    proof: null,
  });
  expect(welcome).not.toHaveProperty("workspace");
  expect(initialList).toStrictEqual({ workspaces: [EXISTING], omitted: 0 });
  expect(created).toMatchObject({ ok: true, workspace: { id: CREATED_ID } });
  expect(retryInput).toStrictEqual(createInput);
  expect(retried).toStrictEqual(created);
  expect(after).toStrictEqual({
    workspaces: [EXISTING, (created as { workspace: HostWorkspace }).workspace],
    omitted: 0,
  });
  expect(host.effects).toStrictEqual([createInput.commandId]);
  expect(host.handlers["workspaces.create"]).toHaveBeenCalledTimes(2);
  expect(host.handlers["workspaces.list"]).toHaveBeenCalledTimes(2);
  expect(verifier).toHaveBeenCalledTimes(1);
  expect(workspace).not.toHaveBeenCalled();

  return {
    welcome: { procedure: "protocol.hostWelcome", input: welcomeInput, output: welcome },
    initialList: { procedure: "workspaces.list", input: listInput, output: initialList },
    create: { procedure: "workspaces.create", input: createInput, output: created },
    retry: { procedure: "workspaces.create", input: retryInput, output: retried },
    listAfterCreate: { procedure: "workspaces.list", input: afterInput, output: after },
  };
}

it("captures host scope over the production listener and replays the canary in both directions", async () => {
  const observed = await observe();
  const schemas: Record<string, ProcedureSchema> = {
    "protocol.hostWelcome": sessionProcedureSchemas()["protocol.hostWelcome"]!,
    ...workspacesProcedureSchemas(),
  };
  const exchanges = recordingExchanges(observed);
  expect(exchanges.map(({ procedure }) => procedure)).toStrictEqual([
    "protocol.hostWelcome",
    "workspaces.list",
    "workspaces.create",
    "workspaces.create",
    "workspaces.list",
  ]);
  for (const exchange of exchanges) {
    const schema = schemas[exchange.procedure]!;
    if (!schema.noInput) expect(schema.input.parse(exchange.input)).toStrictEqual(exchange.input);
    expect(schema.output.parse(exchange.output)).toStrictEqual(exchange.output);
  }
  captureCanaryRecording(NAME, "websocket", observed, exchanges);
  if (canary) {
    checkNextHost(canary, NAME, observed);
    await replayCanaryPeer(canary, NAME, schemas);
  }
});
