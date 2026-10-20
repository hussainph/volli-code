/** VC-729: production Model Access handlers, SQLite, listener and real host links.
 * Provider data is scripted; no credentials, provider requests or sign-ins occur.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  assembleDeviceCredential,
  bytesToBase64Url,
  deviceCredentialSigningInput,
} from "@volli/host-protocol";
import { createEnrolledDeviceVerifier, dataDirDeviceStore, enrollDevice } from "./enrolled-devices";
import { join } from "node:path";
import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import { openVolliDb, insertProject } from "@volli/host-core/db";
import { captureHostLog, testProject } from "@volli/host-core/testing";
import {
  createHostLink,
  createHostScopeLink,
  type HostLinkCalls,
} from "@volli/host-protocol/client-link";
import { expectHostError } from "@volli/host-protocol/testing";
import type { HostConnectionActor } from "@volli/host-protocol";
import { createHostRouter, RpcDiagnosticLog, sessionProcedureSchemas } from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import type { ModelAccessSnapshot } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { startHostdProtocolListener } from "./host-protocol";
import type { SessionEngine } from "@volli/session-engine";

const HOST = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const DEVICE = "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d";
const FEATURE = "host.model-defaults";
const SELECTION = { providerId: "fixture", modelId: "ready", reasoningLevel: "off" } as const;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function snapshot(): ModelAccessSnapshot {
  return {
    observedAt: 0,
    providers: [
      {
        id: "fixture",
        label: "Fixture",
        state: "available",
        accountLabel: null,
        billingSource: "api-key",
        recovery: null,
        signIn: [],
        hasStoredCredential: true,
      },
    ],
    models: ["ready", "unsigned"].map((modelId) => ({
      providerId: "fixture",
      modelId,
      label: modelId,
      state: modelId === "ready" ? "available" : "authentication-required",
      reasoningLevels: ["off"],
      acceptsImageInput: true,
    })),
  };
}

async function ready(
  link: ReturnType<typeof createHostLink> | ReturnType<typeof createHostScopeLink>,
) {
  if (link.getState().status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(new Error("Link did not become ready"));
    }, 3000);
    const stop = link.subscribeState((state) => {
      if (state.status !== "ready") return;
      clearTimeout(timeout);
      stop();
      resolve();
    });
  });
}

async function fixture(
  options: { actor?: HostConnectionActor; offered?: readonly string[]; operator?: boolean } = {},
) {
  const capture = captureHostLog();
  cleanups.push(() => capture.restore());
  const root = mkdtempSync(join(import.meta.dirname, ".host-models-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openVolliDb(join(root, "volli.db"));
  cleanups.push(() => db.close());
  insertProject(db, testProject({ id: WORKSPACE, name: "Seed", path: root }));
  const inspect = vi.fn(async () => snapshot());
  const map = createHostHandlers(
    { events: { publish() {} }, attention: { deliver: () => ({}) } } as never,
    {
      db,
      dataDir: root,
      runtime: null,
      sessions: null,
      modelAccess: { inspectModelAccess: inspect },
      experiments: null,
      automations: { kind: "degraded" } as never,
      busyWorktreeSites: async () => [],
    },
  );
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const store = dataDirDeviceStore(root);
  const device = enrollDevice(
    store,
    {
      publicKey: bytesToBase64Url(publicKey.export({ format: "der", type: "spki" })),
      name: "Model fixture",
      via: "ssh",
    },
    { newId: randomUUID, now: () => new Date() },
  ).device;
  // Agent-policy probes inject a verified agent, since enrolled devices cannot
  // issue agent credentials. Ordinary reads/writes and operator refusal use
  // the production enrolled-device verifier and actual P-256 vdc1 statements.
  const verifier =
    options.actor === undefined
      ? createEnrolledDeviceVerifier({ store, hostId: HOST })
      : { verify: async () => ({ actor: options.actor!, current: () => true }) };
  // Ordinary cases exercise hostd's production feature offer and scope filtering.
  const listener =
    options.offered === undefined
      ? await startHostdProtocolListener({
          db,
          hostId: HOST,
          version: "models-real-link",
          bind: { host: "127.0.0.1", port: 0 },
          verifier,
          handlers: map,
          sessionEngine: { getSession: async () => null } as unknown as SessionEngine,
          logger: { debug() {}, info() {}, warn() {}, error() {} },
        })
      : await startHostProtocolListener({
          router: createHostRouter(),
          bind: { host: "127.0.0.1", port: 0 },
          host: { id: HOST, version: "models-real-link" },
          features: options.offered,
          hostFeatures: options.offered,
          verifier,
          workspace: () => ({ id: WORKSPACE, epoch: 0 }),
          context: () => ({
            handlers: admittedHandlers(map, ROUTER_POLICY),
            diagnostics: new RpcDiagnosticLog(),
          }),
        });
  cleanups.push(() => listener.close());
  function connect(scope: "host" | "workspace" = "host") {
    const input = {
      url: listener.url,
      client: { kind: "desktop" as const, version: "models-real-link" },
      features: [FEATURE],
      credential: () => {
        if (options.operator) return "test-only-operator-token";
        const now = Math.floor(Date.now() / 1000);
        const common = {
          hostId: HOST,
          deviceId: device.deviceId,
          iat: now,
          exp: now + 60,
          jti: randomUUID().replaceAll("-", ""),
        };
        const statement = deviceCredentialSigningInput(
          scope === "host" ? { ...common, scope } : { ...common, workspaceId: WORKSPACE },
        );
        return assembleDeviceCredential(
          statement,
          sign("sha256", Buffer.from(statement), { key: privateKey, dsaEncoding: "ieee-p1363" }),
        );
      },
      timing: { backoffBaseMs: 20, backoffCapMs: 40 },
    };
    const link =
      scope === "host"
        ? createHostScopeLink({ ...input, hostId: HOST })
        : createHostLink({ ...input, workspaceId: WORKSPACE });
    cleanups.push(() => link.close());
    return link;
  }
  return { db, inspect, connect };
}

async function query(link: HostLinkCalls, name: string, input?: unknown) {
  const value = await link.query(`hostModels.${name}`, input);
  return sessionProcedureSchemas()[`hostModels.${name}`]!.output.parse(value);
}

describe("host model defaults over real links", () => {
  it("reads and writes all screen preferences through the existing production handlers", async () => {
    const f = await fixture();
    const link = f.connect();
    await ready(link);
    const state = link.getState();
    expect(state.status === "ready" && state.welcome.features).toEqual([FEATURE]);
    expect(await query(link, "inspect", { refresh: true })).toEqual(snapshot());
    expect(await query(link, "defaults")).toMatchObject({ global: null });
    expect(
      await link.mutate("hostModels.setDefault", { purpose: "global", selection: SELECTION }),
    ).toMatchObject({ global: SELECTION });
    expect(await query(link, "defaults")).toMatchObject({ global: SELECTION });
    const hidden = [{ providerId: "fixture", modelId: "unsigned" }];
    expect(await query(link, "hiddenModels")).toEqual([]);
    expect(await link.mutate("hostModels.setHiddenModels", hidden)).toEqual(hidden);
    expect(await query(link, "hiddenModels")).toEqual(hidden);
    expect(await query(link, "compactionPolicy")).toMatchObject({ autoCompaction: true });
    expect(await link.mutate("hostModels.setCompactionPolicy", { autoCompaction: false })).toEqual({
      autoCompaction: false,
    });
    expect(await query(link, "compactionPolicy")).toEqual({ autoCompaction: false });
    expect(await query(link, "codeModePolicy")).toMatchObject({ enabled: true });
    const policy = { enabled: false, models: {} };
    expect(await link.mutate("hostModels.setCodeModePolicy", policy)).toEqual(policy);
    expect(await query(link, "codeModePolicy")).toEqual(policy);
    expect(await query(link, "pickerView")).toBe("all");
    expect(await link.mutate("hostModels.setPickerView", "defaults")).toBe("defaults");
    expect(await query(link, "pickerView")).toBe("defaults");
    // The new grant does not smuggle sign-ins or the old model-access operations.
    expect(await expectHostError(link.query("signIns.status"))).toMatchObject({
      reason: "verb-refused",
    });
    expect(await expectHostError(link.query("modelAccess.defaults"))).toMatchObject({
      reason: "verb-refused",
    });
  });

  it("refuses unsigned, absent and unsupported defaults without persisting them", async () => {
    const f = await fixture();
    const link = f.connect();
    await ready(link);
    for (const selection of [
      { ...SELECTION, modelId: "unsigned" },
      { ...SELECTION, modelId: "absent" },
      { ...SELECTION, reasoningLevel: "high" },
    ]) {
      await expect(
        link.mutate("hostModels.setDefault", { purpose: "global", selection }),
      ).rejects.toThrow();
      expect(await query(link, "defaults")).toMatchObject({ global: null });
    }
    await expect(
      link.mutate("hostModels.setDefault", { purpose: "global", selection: null }),
    ).rejects.toThrow("cannot be cleared");
    await expect(link.mutate("hostModels.setPickerView", "future-view")).rejects.toThrow();
  });

  it.each(["device", "session"] as const)(
    "never grants a %s Workspace the feature; refuses before inputs or handlers",
    async (kind) => {
      const actor: HostConnectionActor =
        kind === "device"
          ? { kind, deviceId: DEVICE, workspaceId: WORKSPACE }
          : { kind, sessionId: "fixture-session", workspaceId: WORKSPACE };
      const f = await fixture(kind === "session" ? { actor } : {});
      const link = f.connect("workspace");
      await ready(link);
      const state = link.getState();
      expect(state.status === "ready" && state.welcome.features).toEqual([]);
      expect(
        await expectHostError(link.query("hostModels.inspect", { refresh: "malformed" })),
      ).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
      expect(await expectHostError(link.mutate("hostModels.setDefault", {}))).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
      expect(f.inspect).not.toHaveBeenCalled();
    },
  );

  it("refuses an operator credential at the handshake", async () => {
    const f = await fixture({ operator: true });
    const link = f.connect();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error("Handshake did not refuse the operator"));
      }, 3000);
      const stop = link.subscribeState((state) => {
        if (state.status !== "refused") return;
        clearTimeout(timer);
        stop();
        resolve();
      });
    });
    const state = link.getState();
    expect(state.status === "refused" && state.error).toMatchObject({
      code: "UNAUTHORIZED",
      reason: "credential-invalid",
    });
    await expect(link.query("hostModels.defaults")).rejects.toThrow();
    expect(f.inspect).not.toHaveBeenCalled();
  });
});
