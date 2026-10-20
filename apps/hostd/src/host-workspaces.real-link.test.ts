/** Real hostd listener, enrolled P-256 credentials, SQLite and git; no CLI/operator token. */
import { spawnSync } from "node:child_process";
import * as files from "node:fs/promises";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { insertProject, listProjects, openVolliDb } from "@volli/host-core/db";
import { captureHostLog, sealTestHandlers, testProject } from "@volli/host-core/testing";
import {
  assembleDeviceCredential,
  buildHostHello,
  bytesToBase64Url,
  deviceCredentialSigningInput,
  encodeHostHello,
} from "@volli/host-protocol";
import { expectHostError } from "@volli/host-protocol/testing";
import type { SessionEngine } from "@volli/session-engine";
import type { HostRouter } from "@volli/session-rpc";
import type { HostWorkspaceCreateInput } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
import { createEnrolledDeviceVerifier, dataDirDeviceStore, enrollDevice } from "./enrolled-devices";
import { startHostdProtocolListener } from "./host-protocol";
import { createHostWorkspaces } from "./host-workspaces";

const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const NOW_S = 1_800_000_000;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const captured = captureHostLog();
  cleanups.push(() => captured.restore());
  const scratch = resolve(import.meta.dirname, "../../../.tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "workspaces-link-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openVolliDb(join(root, "volli.db"));
  cleanups.push(() => db.close());
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const projectsRoot = join(root, "volli");
  let tracked: Promise<unknown> | undefined;
  const workspaces = createHostWorkspaces({
    db,
    projectsRoot,
    userInstall: true,
    env,
    gitCredentialHelper: "",
    detachedWork: {
      track: (work) => {
        tracked = work;
      },
    },
    testOnly: { allowFileUrls: true },
  });
  cleanups.push(() => workspaces.close());
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
  let entered: (() => void) | undefined;
  const handlers = sealTestHandlers({
    "workspaces.list": () => workspaces.list(),
    "workspaces.create": (input: HostWorkspaceCreateInput) => {
      const result = workspaces.create(input);
      entered?.();
      return result;
    },
  });
  const listener = await startHostdProtocolListener({
    db,
    hostId: HOST,
    version: "workspace-real-link",
    bind: { host: "127.0.0.1", port: 5387 },
    verifier: createEnrolledDeviceVerifier({ store, hostId: HOST, now: () => NOW_S * 1000 }),
    handlers,
    sessionEngine: { getSession: async () => null } as unknown as SessionEngine,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  cleanups.push(() => listener.close());
  function connect() {
    const text = deviceCredentialSigningInput({
      hostId: HOST,
      scope: "host",
      deviceId: device.deviceId,
      iat: NOW_S,
      exp: NOW_S + 60,
      jti: randomUUID().replaceAll("-", ""),
    });
    const credential = assembleDeviceCredential(
      text,
      sign("sha256", Buffer.from(text), { key: privateKey, dsaEncoding: "ieee-p1363" }),
    );
    const hello = buildHostHello({
      scope: "host",
      client: { kind: "desktop", version: "workspace-real-link" },
      credential,
      features: ["host.workspaces"],
    });
    let dropTransport: () => void;
    class TestSocket extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        dropTransport = () => this.close(1000, "fixture disconnect");
      }
    }
    const socket = createWSClient({
      url: listener.url,
      connectionParams: encodeHostHello(hello),
      WebSocket: TestSocket,
    });
    cleanups.push(() => socket.close());
    const client = createTRPCClient<HostRouter>({ links: [wsLink({ client: socket })] });
    return {
      client,
      drop: () => {
        dropTransport();
        void socket.close();
      },
    };
  }
  return {
    db,
    root,
    projectsRoot,
    env,
    connect,
    finished: () => tracked!,
    whenEntered: () =>
      new Promise<void>((done) => {
        entered = done;
      }),
  };
}

describe("host-owned workspaces over a real signed-device link", () => {
  it("delivers a whole-row byte-bounded non-ASCII catalog through the real listener", async () => {
    const f = await fixture();
    // macOS's path limit is smaller than the legal host wire limit. Model
    // canonical Linux paths at the filesystem boundary; the service, signed
    // enrollment, router, frame encoder and listener are all production code.
    const parent = `/${Array.from({ length: 13 }, () => "界".repeat(80)).join("/")}`;
    vi.spyOn(files, "realpath").mockImplementation(async (path) => String(path));
    for (let i = 0; i < 500; i++) {
      const path = join(parent, `project-${i}`);
      insertProject(
        f.db,
        testProject({ id: randomUUID(), name: "界".repeat(512), path, sortOrder: i }),
      );
    }
    const { client } = f.connect();
    const catalog = await client.workspaces.list.query();
    expect(catalog.workspaces.length).toBeGreaterThan(0);
    expect(catalog.omitted).toBeGreaterThan(0);
    expect(catalog.workspaces.length + catalog.omitted).toBe(500);
    expect(Buffer.byteLength(JSON.stringify(catalog), "utf8")).toBeLessThanOrEqual(
      2 * 1024 * 1024 - 64 * 1024,
    );
    for (const row of catalog.workspaces) {
      expect(row.name).toBe("界".repeat(512));
      expect(row.path.startsWith(parent)).toBe(true);
    }
  }, 20_000);

  it("registers an existing host folder before any project and reports command-intent conflict over the wire", async () => {
    const f = await fixture();
    const { client } = f.connect();
    expect(listProjects(f.db)).toEqual([]);
    expect(await client.protocol.hostWelcome.query()).toMatchObject({
      scope: "host",
      features: ["host.workspaces"],
    });
    expect(await client.workspaces.list.query()).toEqual({ workspaces: [], omitted: 0 });
    const path = join(f.root, "existing");
    mkdirSync(path);
    const input = { commandId: randomUUID(), source: { path }, name: "Existing" };
    const result = await client.workspaces.create.mutate(input);
    expect(result).toMatchObject({
      ok: true,
      workspace: { name: "Existing", path, gitRemoteUrl: null },
    });
    expect(await client.workspaces.create.mutate(input)).toEqual(result);
    expect(await client.workspaces.list.query()).toEqual({
      workspaces: [result.ok ? result.workspace : null],
      omitted: 0,
    });
    expect(
      await expectHostError(client.workspaces.create.mutate({ ...input, name: "Other intent" })),
    ).toMatchObject({ code: "CONFLICT", reason: "command-conflict" });
    expect(listProjects(f.db)).toHaveLength(1);
  });

  it("lets a real local bare clone finish after a dropped transport, then returns its exact outcome on a fresh credential", async () => {
    const f = await fixture();
    const bare = join(f.root, "fixture.git");
    const init = spawnSync("git", ["init", "--bare", "--initial-branch=main", bare], {
      env: f.env,
      encoding: "utf8",
    });
    expect(init.status, init.stderr).toBe(0);
    const first = f.connect();
    await first.client.protocol.hostWelcome.query();
    const input = {
      commandId: randomUUID(),
      source: { gitUrl: pathToFileURL(bare).href },
      name: "Cloned",
    };
    const entered = f.whenEntered();
    const dropped = first.client.workspaces.create.mutate(input).then(
      () => "completed",
      () => "dropped",
    );
    await entered;
    first.drop();
    expect(await dropped).toBe("dropped");
    const second = f.connect();
    await second.client.protocol.hostWelcome.query();
    let result = await second.client.workspaces.create.mutate(input);
    // The runtime's detached-work owner can await settlement, independent of either transport.
    if (!result.ok && result.failure.code === "still-running") {
      await f.finished();
      result = await second.client.workspaces.create.mutate(input);
    }
    expect(result).toMatchObject({
      ok: true,
      workspace: { path: join(f.projectsRoot, "fixture"), name: "Cloned", gitRemoteUrl: null },
    });
    expect(existsSync(join(f.projectsRoot, "fixture", ".git"))).toBe(true);
    expect(await second.client.workspaces.create.mutate(input)).toEqual(result);
    expect(await second.client.workspaces.list.query()).toEqual({
      workspaces: [result.ok ? result.workspace : null],
      omitted: 0,
    });
    expect(listProjects(f.db)).toHaveLength(1);
    expect(
      await second.client.workspaces.create.mutate({ ...input, commandId: randomUUID() }),
    ).toMatchObject({ ok: false, failure: { code: "target-exists" } });
  });
});
