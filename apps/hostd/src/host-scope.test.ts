/** Real P-256 credentials and hostd's loopback door; handlers record the service boundary only. */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTRPCClient, createWSClient, getUntypedClient, wsLink } from "@trpc/client";
import { listProjects, openVolliDb } from "@volli/host-core/db";
import { captureHostLog, sealTestHandlers } from "@volli/host-core/testing";
import {
  assembleDeviceCredential,
  buildHostHello,
  bytesToBase64Url,
  deviceCredentialSigningInput,
  encodeHostHello,
  HOST_FEATURE_OPERATIONS,
  HOST_V1_FEATURES,
  validateWelcome,
  type HostConnectionActor,
  type HostCredentialVerifier,
} from "@volli/host-protocol";
import { expectHostError, recordSubscription } from "@volli/host-protocol/testing";
import type { SessionEngine } from "@volli/session-engine";
import type { HostRouter } from "@volli/session-rpc";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createEnrolledDeviceVerifier,
  dataDirDeviceStore,
  enrollDevice,
  revokeDevice,
} from "./enrolled-devices";
import { servedWorkspace, startHostdProtocolListener } from "./host-protocol";

const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const WORKSPACE = "2f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const NOW_S = 1_800_000_000;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fixture(
  options: {
    grantedActor?: (deviceId: string) => HostConnectionActor;
    offerLogs?: boolean;
  } = {},
) {
  const capturedLog = captureHostLog();
  cleanups.push(() => capturedLog.restore());
  const root = mkdtempSync(join(tmpdir(), "hostd-host-scope-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openVolliDb(join(root, "volli.db"));
  cleanups.push(() => {
    db.close();
  });
  expect(listProjects(db)).toEqual([]);
  expect(servedWorkspace(db, WORKSPACE)).toBeNull();
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const store = dataDirDeviceStore(root);
  const device = enrollDevice(
    store,
    {
      publicKey: bytesToBase64Url(publicKey.export({ format: "der", type: "spki" })),
      name: "Fixture Mac",
      via: "ssh",
    },
    { now: () => new Date(NOW_S * 1000), newId: randomUUID },
  ).device;
  const realVerifier = createEnrolledDeviceVerifier({
    store,
    hostId: HOST,
    now: () => NOW_S * 1000,
  });
  // Wrong-scope grants deliberately exercise the listener's independent recheck,
  // but only after the real verifier authenticated the real signed credential.
  const verifier: HostCredentialVerifier =
    options.grantedActor === undefined
      ? realVerifier
      : {
          async verify(presentation) {
            const grant = await realVerifier.verify(presentation);
            return grant === null
              ? null
              : { ...grant, actor: options.grantedActor!(device.deviceId) };
          },
        };
  const list = vi.fn(() => ({ workspaces: [], omitted: 0 }));
  const create = vi.fn(() => ({
    ok: true,
    workspace: { id: WORKSPACE, name: "Fixture", path: "/fixture/project", gitRemoteUrl: null },
  }));
  const status = vi.fn(() => ({ providers: [], git: [] }));
  const callback = vi.fn(() => ({ status: 200 }));
  const logs = vi.fn(() => ({ entries: [], cursor: "0:fixture:0", gap: false }));
  const workspaceHandler = vi.fn(() => {
    throw new Error("Host scope reached a Workspace handler");
  });
  const handlers = sealTestHandlers({
    "workspaces.list": list,
    "workspaces.create": create,
    "signIns.status": status,
    "auth.callback.deliver": callback,
    "logs.tail": logs,
    "board.snapshot": workspaceHandler,
    "board.createTicket": workspaceHandler,
    "board.changes": workspaceHandler,
    "session.list": workspaceHandler,
    "sessions.create": workspaceHandler,
    "session.subscribe": workspaceHandler,
  });
  const getSession = vi.fn(async () => null);
  const listener = await startHostdProtocolListener({
    db,
    hostId: HOST,
    version: "host-scope-test",
    bind: { host: "127.0.0.1", port: 0 },
    verifier,
    handlers,
    // Only the resource-resolution port is used; no executor/sign-in/helper starts.
    sessionEngine: { getSession } as unknown as SessionEngine,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    offerLogs: options.offerLogs ?? true,
  });
  cleanups.push(() => listener.close());

  function credential(scope: "host" | "workspace" = "host", hostId = HOST) {
    const common = {
      hostId,
      deviceId: device.deviceId,
      iat: NOW_S,
      exp: NOW_S + 60,
      jti: randomUUID().replaceAll("-", ""),
    };
    const input = deviceCredentialSigningInput(
      scope === "host" ? { ...common, scope: "host" } : { ...common, workspaceId: WORKSPACE },
    );
    return assembleDeviceCredential(
      input,
      sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }),
    );
  }

  function connect(
    text = credential(),
    scope: "host" | "workspace" = "host",
    features: readonly string[] = HOST_V1_FEATURES,
  ) {
    const common = {
      client: { kind: "desktop" as const, version: "host-scope-test" },
      features,
      credential: text,
    };
    const hello =
      scope === "host"
        ? buildHostHello({ ...common, scope: "host" })
        : buildHostHello({ ...common, workspaceId: WORKSPACE, lastSeen: null });
    const socket = createWSClient({ url: listener.url, connectionParams: encodeHostHello(hello) });
    cleanups.push(() => socket.close());
    const client = createTRPCClient<HostRouter>({ links: [wsLink({ client: socket })] });
    return { client, raw: getUntypedClient(client), hello };
  }
  return {
    connect,
    credential,
    device,
    store,
    list,
    create,
    status,
    callback,
    logs,
    workspaceHandler,
    getSession,
  };
}

describe("host scope at hostd's enrolled-device loopback door", () => {
  it("welcomes an SSH-enrolled device before any project, filtering to host-only features", async () => {
    const f = await fixture();
    const { client, hello } = f.connect();
    expect(hello).toMatchObject({ scope: "host" });
    expect(hello).not.toHaveProperty("workspaceId");
    expect(hello).not.toHaveProperty("lastSeen");
    const welcome = await client.protocol.hostWelcome.query();
    expect(welcome).toMatchObject({
      scope: "host",
      host: { id: HOST },
      actor: { kind: "device", deviceId: f.device.deviceId, scope: "host" },
    });
    expect(welcome.features.toSorted()).toEqual([
      "auth.callback",
      "host.logs",
      "host.workspaces",
      "sign-ins",
    ]);
    expect(welcome).not.toHaveProperty("workspace");
    expect(welcome).not.toHaveProperty("lastSeen");
    expect(validateWelcome(welcome, hello)).toEqual({ ok: true, welcome });
    expect(await client.workspaces.list.query()).toEqual({ workspaces: [], omitted: 0 });
    expect(await client.signIns.status.query()).toEqual({ providers: [], git: [] });
    expect(await client.logs.tail.query({})).toEqual({
      entries: [],
      cursor: "0:fixture:0",
      gap: false,
    });
    expect(
      await client.auth.callback.deliver.mutate({
        flowId: "fixture",
        pathAndQuery: "/callback?code=fixture",
      }),
    ).toEqual({ status: 200 });
    const commandId = randomUUID();
    await client.workspaces.create.mutate({
      commandId,
      source: { path: "/fixture/project" },
      name: "Fixture",
    });
    expect(f.list).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ actor: { kind: "user" } }),
    );
    expect(f.create).toHaveBeenCalledWith(
      { commandId, source: { path: "/fixture/project" }, name: "Fixture" },
      expect.objectContaining({ actor: { kind: "user" } }),
    );
    expect(f.workspaceHandler).not.toHaveBeenCalled();
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("intersects requested and offered features and refuses unnegotiated host calls before input", async () => {
    const f = await fixture({ offerLogs: false });
    const { client, raw } = f.connect(undefined, "host", [
      "sign-ins",
      "host.logs",
      "sessions",
      "unknown.future",
    ]);
    expect((await client.protocol.hostWelcome.query()).features).toEqual(["sign-ins"]);
    for (const call of [
      raw.query("logs.tail", { limit: "bad" }),
      raw.query("workspaces.list"),
      raw.mutation("workspaces.create", {}),
    ]) {
      expect(await expectHostError(call)).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
    }
    expect(f.logs).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("refuses Workspace reads, writes and streams before malformed inputs, resource reads or handlers", async () => {
    const f = await fixture();
    const { client, raw } = f.connect();
    await client.protocol.hostWelcome.query();
    for (const path of ["board.snapshot", "session.list", "session.snapshot", "session.history"]) {
      expect(await expectHostError(raw.query(path, {}))).toMatchObject({
        code: "FORBIDDEN",
        reason: "workspace-scope-required",
      });
    }
    for (const path of ["sessions.create", "board.createTicket", "session.command"]) {
      expect(await expectHostError(raw.mutation(path, {}))).toMatchObject({
        code: "FORBIDDEN",
        reason: "workspace-scope-required",
      });
    }
    for (const path of ["board.changes", "session.subscribe"]) {
      const stream = recordSubscription((handlers) => raw.subscription(path, {}, handlers));
      try {
        expect(await stream.ended).toMatchObject({
          kind: "error",
          error: { code: "FORBIDDEN", reason: "workspace-scope-required" },
        });
      } finally {
        stream.unsubscribe();
      }
    }
    // The legacy bootstrap keeps its Workspace-only schema; it is not aliased.
    expect(await expectHostError(client.protocol.welcome.query())).toMatchObject({
      code: "FORBIDDEN",
      reason: "verb-refused",
    });
    expect(f.workspaceHandler).not.toHaveBeenCalled();
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("refuses signed credentials for the other scope or another host", async () => {
    const f = await fixture();
    for (const [text, scope] of [
      [f.credential("workspace"), "host"],
      [f.credential(), "workspace"],
      [f.credential("host", randomUUID()), "host"],
    ] as const) {
      const { raw } = f.connect(text, scope);
      expect(await expectHostError(raw.query("protocol.hostWelcome"))).toMatchObject({
        code: "UNAUTHORIZED",
        reason: "credential-invalid",
      });
    }
    expect(f.list).not.toHaveBeenCalled();
  });

  it("independently refuses a Session or Workspace device grant for a host hello", async () => {
    for (const grantedActor of [
      (deviceId: string): HostConnectionActor => ({
        kind: "device",
        deviceId,
        workspaceId: WORKSPACE,
      }),
      (): HostConnectionActor => ({
        kind: "session",
        sessionId: "fixture-session",
        workspaceId: WORKSPACE,
      }),
    ]) {
      const f = await fixture({ grantedActor });
      const { client } = f.connect();
      expect(await expectHostError(client.protocol.hostWelcome.query())).toMatchObject({
        code: "UNAUTHORIZED",
        reason: "credential-invalid",
      });
      expect(f.list).not.toHaveBeenCalled();
    }
  });

  it("rejects a replay with a fresh hello nonce, and revoked devices on existing and new links", async () => {
    const f = await fixture();
    const text = f.credential();
    const first = f.connect(text);
    await first.client.protocol.hostWelcome.query();
    const replay = f.connect(text);
    expect(replay.hello.nonce).not.toBe(first.hello.nonce);
    expect(await expectHostError(replay.client.protocol.hostWelcome.query())).toMatchObject({
      code: "UNAUTHORIZED",
      reason: "credential-invalid",
    });
    revokeDevice(f.store, f.device.deviceId, () => new Date((NOW_S + 1) * 1000));
    expect(await expectHostError(first.client.workspaces.list.query())).toMatchObject({
      code: "UNAUTHORIZED",
      reason: "credential-invalid",
    });
    const revoked = f.connect();
    expect(await expectHostError(revoked.client.protocol.hostWelcome.query())).toMatchObject({
      code: "UNAUTHORIZED",
      reason: "credential-invalid",
    });
    expect(f.list).not.toHaveBeenCalled();
  });

  it("pins the host-scope feature operation sets without widening existing features", () => {
    expect(HOST_FEATURE_OPERATIONS["host.workspaces"]).toEqual([
      "workspaces.list",
      "workspaces.create",
    ]);
    expect(HOST_FEATURE_OPERATIONS["auth.callback"]).toEqual(["auth.callback.deliver"]);
  });
});
