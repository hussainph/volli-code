import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RemoteHostsUnavailableError, SILENT_LOGGER, type RemoteHosts } from "@volli/host-install";
import type { ActiveAddHost, RemoteHostDevices } from "@volli/shared";

import {
  createDesktopRemoteHosts,
  desktopWakeSource,
  devTarballsFrom,
  deviceKeyPurpose,
  fileRegistryStore,
  inventoryDeviceKeys,
  readHostdPin,
  REMOTE_HOST_LINK_FEATURES,
  remoteHostsPort,
  type DeviceKeyInventory,
} from "./remote-hosts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desktop-remote-hosts-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The sealed inventory's surface, in memory: no keychain, no safeStorage. */
function memoryInventory() {
  const records = new Map<string, string>();
  const inventory: DeviceKeyInventory = {
    get: (_family, { purpose }) => (records.has(purpose) ? { value: records.get(purpose)! } : null),
    put: (_family, { purpose }, value) => records.set(purpose, value),
    remove: (_family, { purpose }) => records.delete(purpose),
  };
  return { inventory, records };
}

const SHA = "a".repeat(64);

describe("device keys in the sealed inventory", () => {
  it("keeps each under its own host-private purpose, unlocking first", async () => {
    const { inventory, records } = memoryInventory();
    const unlock = vi.fn(async () => {});
    const keys = inventoryDeviceKeys(inventory, unlock);
    expect(await keys.get("host:a")).toBeNull();
    await keys.put("host:a", "-----BEGIN PRIVATE KEY-----\nx\n");
    expect(records.get(deviceKeyPurpose("host:a"))).toContain("PRIVATE KEY");
    expect(await keys.get("host:a")).toContain("PRIVATE KEY");
    await keys.remove("host:a");
    expect(records.size).toBe(0);
    expect(unlock).toHaveBeenCalledTimes(4);
    records.set(deviceKeyPurpose("odd"), 42 as unknown as string);
    expect(await keys.get("odd")).toBeNull();
  });
});

describe("the registry file", () => {
  it("round-trips whole, 0600; reads a missing file as none and refuses a broken one", () => {
    const path = join(root, "nested/remote-hosts.json");
    const store = fileRegistryStore(path);
    expect(store.load()).toBeNull();
    const file = { v: 1 as const, hosts: [] };
    store.save(file);
    expect(store.load()).toEqual(file);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Not JSON, or not a file it can read: thrown, so the engine leaves it alone.
    const broken = join(root, "broken.json");
    writeFileSync(broken, "{");
    expect(() => fileRegistryStore(broken).load()).toThrow(SyntaxError);
    const directory = join(root, "a-directory.json");
    mkdirSync(directory);
    expect(() => fileRegistryStore(directory).load()).toThrow(/EISDIR/u);
    // A save that cannot land throws, and leaves no temporary file behind.
    expect(() => fileRegistryStore(directory).save(file)).toThrow();
    expect(() => statSync(`${directory}.${process.pid}.tmp`)).toThrow();
  });

  it("is never overwritten when a newer Volli wrote it", async () => {
    const path = join(root, "remote-hosts.json");
    const newer = `${JSON.stringify({ v: 2, hosts: [], futureData: "keep" })}\n`;
    writeFileSync(path, newer);
    const { inventory } = memoryInventory();
    const hosts = createDesktopRemoteHosts({
      userData: root,
      appVersion: "1.1.0",
      packaged: false,
      manifestPath: join(root, "absent.json"),
      env: {},
      inventory,
      unlockInventory: async () => {},
      enabled: () => true,
      logger: SILENT_LOGGER,
    });
    expect(hosts.snapshot().readOnly).toBe("This Mac’s hosts file is from a newer Volli.");
    await expect(hosts.startAdd({ target: "deploy@box" })).rejects.toMatchObject({
      code: "registry-read-only",
    });
    expect(readFileSync(path, "utf8")).toBe(newer);
    await hosts.close();
  });
});

describe("the hostd it installs", () => {
  it("trusts only the app's pin, and reads a missing or malformed one as none", () => {
    const manifest = join(root, "hostd-release-manifest.json");
    expect(readHostdPin(manifest)).toBeNull();
    writeFileSync(manifest, "not json");
    expect(readHostdPin(manifest)).toBeNull();
    writeFileSync(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        version: "1.1.0",
        releaseTag: "v1.1.0",
        assets: [
          {
            platform: "linux",
            arch: "x64",
            name: "volli-hostd-1.1.0-linux-x64.tar.gz",
            sha256: SHA,
          },
        ],
      }),
    );
    expect(readHostdPin(manifest)).toMatchObject({
      version: "1.1.0",
      assets: [{ target: "linux-x64", sha256: SHA }],
    });
  });

  it("takes local tarballs only in an unpackaged build", () => {
    const env = { VOLLI_HOSTD_DEV_TARBALLS: ["/a.tar.gz", "", "/b.tar.gz"].join(delimiter) };
    expect(devTarballsFrom(env, false)).toEqual(["/a.tar.gz", "/b.tar.gz"]);
    expect(devTarballsFrom(env, true)).toEqual([]);
    expect(devTarballsFrom({}, false)).toEqual([]);
    expect(devTarballsFrom({ VOLLI_HOSTD_DEV_TARBALLS: "" }, false)).toEqual([]);
  });
});

describe("the composed engine", () => {
  it("refuses everything while cloud is off, and touches nothing", async () => {
    const { inventory } = memoryInventory();
    const lines: string[] = [];
    const hosts = createDesktopRemoteHosts({
      userData: root,
      appVersion: "1.1.0",
      packaged: false,
      manifestPath: join(root, "absent.json"),
      env: {},
      inventory,
      unlockInventory: async () => {},
      enabled: () => false,
      logger: {
        debug: (line: string) => lines.push(line),
        info: (line: string) => lines.push(line),
        warn: (line: string) => lines.push(line),
        error: (line: string) => lines.push(line),
      },
    });
    expect(() => hosts.snapshot()).toThrow(RemoteHostsUnavailableError);
    await expect(hosts.startAdd({ target: "deploy@box" })).rejects.toThrow(
      RemoteHostsUnavailableError,
    );
    expect(() => readFileSync(join(root, "remote-hosts.json"))).toThrow();
    await hosts.close();
  });
});

function platform() {
  const listeners = new Map<string, Set<() => void>>();
  const state = { online: true };
  return {
    state,
    listeners,
    fire: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    platform: {
      powerMonitor: {
        on(event: "resume" | "unlock-screen", listener: () => void) {
          listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
        },
        removeListener(event: "resume" | "unlock-screen", listener: () => void) {
          listeners.get(event)?.delete(listener);
        },
      },
      net: { isOnline: () => state.online },
    },
  };
}

describe("waking the engine", () => {
  it("says power-resume on resume and unlock, network-online when the network comes back", () => {
    vi.useFakeTimers();
    try {
      const fake = platform();
      const causes: string[] = [];
      const stop = desktopWakeSource(fake.platform, 100)((cause) => causes.push(cause));
      fake.fire("resume");
      fake.fire("unlock-screen");
      vi.advanceTimersByTime(100);
      fake.state.online = false;
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(100);
      fake.state.online = true;
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(100);
      expect(causes).toEqual(["power-resume", "power-resume", "network-online"]);
      stop();
      fake.fire("resume");
      fake.state.online = false;
      vi.advanceTimersByTime(100);
      fake.state.online = true;
      vi.advanceTimersByTime(100);
      expect(causes).toHaveLength(3);
      expect([...fake.listeners.values()].every((set) => set.size === 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes the composed engine's hosts: attached while cloud is on, detached at quit", async () => {
    const fake = platform();
    const { inventory } = memoryInventory();
    const hosts = createDesktopRemoteHosts({
      userData: root,
      appVersion: "1.1.0",
      packaged: false,
      manifestPath: join(root, "absent.json"),
      env: {},
      inventory,
      unlockInventory: async () => {},
      enabled: () => true,
      logger: SILENT_LOGGER,
      wake: fake.platform,
    });
    expect(fake.listeners.get("resume")?.size).toBe(1);
    await hosts.close();
    expect(fake.listeners.get("resume")?.size).toBe(0);
  });
});

describe("the remote hosts port's sign-in (VC-702)", () => {
  it("answers hosts.signIn with the sign-in preflight, else the engine's own refusal", async () => {
    const engine = {
      signIn: vi.fn(() => {
        throw new RemoteHostsUnavailableError("not yet");
      }),
    } as unknown as Parameters<typeof remoteHostsPort>[0];
    expect(() => remoteHostsPort(engine).signIn("h", "claude")).toThrow("not yet");
    const preflight = vi.fn(async () => {});
    await remoteHostsPort(engine, preflight).signIn("h", "claude");
    expect(preflight).toHaveBeenCalledWith("h", "claude");
    // Every Workspace link asks for the host's sign-ins and the relay.
    expect(REMOTE_HOST_LINK_FEATURES).toEqual([
      "sign-ins",
      "auth.callback",
      // The host's log (VC-712).
      "host.logs",
      // Its board and Session reads (VC-710).
      "board.read",
      "board.write",
      "session.read",
      // A remote project's Sessions (VC-713).
      "sessions",
      "sessions.subscribe",
      "sessions.queue",
      "sessions.history",
      "sessions.listing",
    ]);
  });
});

describe("the engine as the handler map's port", () => {
  it("passes a rename, a device list and an add's facts straight to the engine", async () => {
    const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
    const devices: RemoteHostDevices = { hostId: HOST, devices: [] };
    const facts = { user: "deploy" };
    const active: readonly ActiveAddHost[] = [
      { flowId: "flow-1", target: "you@box", name: "you@box", status: "question" },
    ];
    const engine = {
      rename: vi.fn(),
      devices: vi.fn(async () => devices),
      addFacts: vi.fn(() => facts),
      activeAdds: vi.fn(() => active),
    };
    const port = remoteHostsPort(engine as unknown as RemoteHosts);
    expect(port.rename(HOST, "Build box")).toBeUndefined();
    expect(engine.rename).toHaveBeenCalledWith(HOST, "Build box");
    expect(await port.devices(HOST)).toBe(devices);
    expect(engine.devices).toHaveBeenCalledWith(HOST);
    expect(port.addFacts("flow-1")).toBe(facts);
    expect(engine.addFacts).toHaveBeenCalledWith("flow-1");
    // The discovery read (VC-720) forwards whole, and takes nothing.
    expect(port.activeAdds()).toBe(active);
    expect(engine.activeAdds).toHaveBeenCalledWith();
  });

  it("passes a host's projects, a create, an open and a close straight to the engine (VC-710)", async () => {
    const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
    const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
    const projects = { hostId: HOST, projects: [], adds: { kind: "ready" } };
    const created = { ok: true };
    const engine = {
      projects: vi.fn(async () => projects),
      createProject: vi.fn(async () => created),
      openWorkspace: vi.fn(),
      closeWorkspace: vi.fn(),
    };
    const port = remoteHostsPort(engine as unknown as RemoteHosts);
    expect(await port.projects(HOST)).toBe(projects);
    const input = { hostId: HOST, path: "/srv/volli/acme" };
    expect(await port.createProject(input)).toBe(created);
    expect(engine.createProject).toHaveBeenCalledWith(input);
    expect(port.openWorkspace(HOST, WORKSPACE)).toBeUndefined();
    expect(engine.openWorkspace).toHaveBeenCalledWith(HOST, WORKSPACE);
    expect(port.closeWorkspace(HOST, WORKSPACE)).toBeUndefined();
    expect(engine.closeWorkspace).toHaveBeenCalledWith(HOST, WORKSPACE);
  });
});
