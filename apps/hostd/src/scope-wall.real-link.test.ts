/** B1 regression: real enrolled P-256 vdc1 grants at hostd's loopback scope wall. */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createTRPCClient, createWSClient, getUntypedClient, wsLink } from "@trpc/client";
import { createProject } from "@volli/host-core/board";
import { openVolliDb } from "@volli/host-core/db";
import { captureHostLog, sealTestHandlers } from "@volli/host-core/testing";
import {
  assembleDeviceCredential,
  buildHostHello,
  bytesToBase64Url,
  deviceCredentialSigningInput,
  encodeHostHello,
} from "@volli/host-protocol";
import { expectHostError, recordSubscription } from "@volli/host-protocol/testing";
import type { SessionEngine } from "@volli/session-engine";
import type { HostRouter, SessionRouterHandlers } from "@volli/session-rpc";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createEnrolledDeviceVerifier, dataDirDeviceStore, enrollDevice } from "./enrolled-devices";
import { startHostdProtocolListener } from "./host-protocol";

const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const NOW_S = 1_800_000_000;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fixture() {
  const capturedLog = captureHostLog();
  cleanups.push(() => capturedLog.restore());
  const root = mkdtempSync(join(import.meta.dirname, ".hostd-scope-wall-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openVolliDb(join(root, "volli.db"));
  cleanups.push(() => {
    db.close();
  });
  mkdirSync(join(root, "seed"));
  const seed = await createProject(
    { db, detectBaseBranch: async () => null },
    { path: join(root, "seed"), name: "Seed" },
  );
  if (!seed.ok) throw new Error("Seed project failed");
  const workspaceId = seed.project.id;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const store = dataDirDeviceStore(root);
  const device = enrollDevice(
    store,
    {
      publicKey: bytesToBase64Url(publicKey.export({ format: "der", type: "spki" })),
      name: "Scope wall fixture",
      via: "ssh", // Enrollment metadata only: no SSH process or real account.
    },
    { newId: randomUUID, now: () => new Date(NOW_S * 1000) },
  ).device;

  const list = vi.fn(() => ({ workspaces: [], omitted: 0 }));
  const create = vi.fn(() => ({
    ok: true,
    workspace: {
      id: workspaceId,
      name: "Seed",
      path: join(root, "seed"),
      gitRemoteUrl: null,
    },
  }));
  const status = vi.fn(() => ({ providers: [], git: [] }));
  const callback = vi.fn(() => ({ status: 200 }));
  const batch = { entries: [], cursor: "0:fixture:0", gap: false };
  const logs = vi.fn(() => batch);
  const follow = vi.fn<SessionRouterHandlers["logs.follow"]>(async (_input, _call, sink) => {
    await sink.emit(batch);
    return () => {};
  });
  const workspaceHandler = vi.fn(() => {
    throw new Error("Wrong-scope Workspace handler");
  });
  const getSession = vi.fn(async () => null);
  const listener = await startHostdProtocolListener({
    db,
    hostId: HOST,
    version: "scope-wall-test",
    bind: { host: "127.0.0.1", port: 5386 },
    verifier: createEnrolledDeviceVerifier({ store, hostId: HOST, now: () => NOW_S * 1000 }),
    handlers: sealTestHandlers({
      "workspaces.list": list,
      "workspaces.create": create,
      "signIns.status": status,
      "auth.callback.deliver": callback,
      "logs.tail": logs,
      "logs.follow": follow,
      "board.snapshot": workspaceHandler,
      "board.createTicket": workspaceHandler,
      "board.changes": workspaceHandler,
    }),
    sessionEngine: { getSession } as unknown as SessionEngine,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    offerLogs: true,
  });
  cleanups.push(() => listener.close());

  function connect(scope: "host" | "workspace", features: readonly string[]) {
    const common = {
      hostId: HOST,
      deviceId: device.deviceId,
      iat: NOW_S,
      exp: NOW_S + 60,
      jti: randomUUID().replaceAll("-", ""),
    };
    const signingInput = deviceCredentialSigningInput(
      scope === "host" ? { ...common, scope: "host" } : { ...common, workspaceId },
    );
    const credential = assembleDeviceCredential(
      signingInput,
      sign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" }),
    );
    const input = {
      client: { kind: "desktop" as const, version: "scope-wall-test" },
      features,
      credential,
    };
    const hello =
      scope === "host"
        ? buildHostHello({ ...input, scope: "host" })
        : buildHostHello({ ...input, workspaceId, lastSeen: null });
    const socket = createWSClient({ url: listener.url, connectionParams: encodeHostHello(hello) });
    cleanups.push(() => socket.close());
    const client = createTRPCClient<HostRouter>({ links: [wsLink({ client: socket })] });
    return { client, raw: getUntypedClient(client) };
  }
  return {
    connect,
    list,
    create,
    status,
    callback,
    logs,
    follow,
    batch,
    workspaceHandler,
    getSession,
    workspaceId,
    root,
  };
}

describe("hostd's bidirectional scope wall over signed enrolled-device links", () => {
  it("never grants host.workspaces to a Workspace and refuses direct list/create before handlers or malformed input", async () => {
    const f = await fixture();
    const { client, raw } = f.connect("workspace", ["host.workspaces"]);
    expect((await client.protocol.welcome.query()).features).toEqual([]);
    for (const input of [undefined, { unexpected: "invalid" }]) {
      expect(await expectHostError(raw.query("workspaces.list", input))).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
    }
    for (const input of [
      { commandId: randomUUID(), source: { path: join(f.root, "seed") } },
      { commandId: "not-a-uuid", source: null },
    ]) {
      expect(await expectHostError(raw.mutation("workspaces.create", input))).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
    }
    expect(await expectHostError(raw.query("protocol.hostWelcome"))).toMatchObject({
      code: "FORBIDDEN",
      reason: "verb-refused",
    });
    expect(f.list).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each(["host", "workspace"] as const)(
    "retains shared host reads, writes and streams on %s connections",
    async (scope) => {
      const f = await fixture();
      const { client } = f.connect(scope, [
        "host.workspaces",
        "sign-ins",
        "auth.callback",
        "host.logs",
      ]);
      const welcome =
        scope === "host"
          ? await client.protocol.hostWelcome.query()
          : await client.protocol.welcome.query();
      expect(welcome.features.toSorted()).toEqual(
        scope === "host"
          ? ["auth.callback", "host.logs", "host.workspaces", "sign-ins"]
          : ["auth.callback", "host.logs", "sign-ins"],
      );
      expect(await client.signIns.status.query()).toEqual({ providers: [], git: [] });
      expect(
        await client.auth.callback.deliver.mutate({
          flowId: "fixture",
          pathAndQuery: "/callback?code=fixture",
        }),
      ).toEqual({ status: 200 });
      expect(await client.logs.tail.query({})).toEqual(f.batch);
      const stream = recordSubscription((handlers) => client.logs.follow.subscribe({}, handlers));
      try {
        expect(await stream.received(1)).toEqual([{ id: f.batch.cursor, data: f.batch }]);
      } finally {
        stream.unsubscribe();
      }
      expect(f.status).toHaveBeenCalledTimes(1);
      expect(f.callback).toHaveBeenCalledTimes(1);
      expect(f.logs).toHaveBeenCalledTimes(1);
      expect(f.follow).toHaveBeenCalledTimes(1);
      if (scope === "host") {
        await client.workspaces.list.query();
        await client.workspaces.create.mutate({
          commandId: randomUUID(),
          source: { path: join(f.root, "seed") },
        });
        expect(f.list).toHaveBeenCalledTimes(1);
        expect(f.create).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("refuses Workspace queries, mutations and subscriptions on a host connection before parsing or resolution", async () => {
    const f = await fixture();
    const { client, raw } = f.connect("host", ["host.workspaces", "board.read", "board.write"]);
    expect((await client.protocol.hostWelcome.query()).features).toEqual(["host.workspaces"]);
    for (const call of [raw.query("board.snapshot", {}), raw.mutation("board.createTicket", {})]) {
      expect(await expectHostError(call)).toMatchObject({
        code: "FORBIDDEN",
        reason: "workspace-scope-required",
      });
    }
    const stream = recordSubscription((handlers) =>
      raw.subscription("board.changes", {}, handlers),
    );
    try {
      expect(await stream.ended).toMatchObject({
        kind: "error",
        error: { code: "FORBIDDEN", reason: "workspace-scope-required" },
      });
    } finally {
      stream.unsubscribe();
    }
    expect(f.workspaceHandler).not.toHaveBeenCalled();
    expect(f.getSession).not.toHaveBeenCalled();
  });
});
