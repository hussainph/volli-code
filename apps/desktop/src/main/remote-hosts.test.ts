import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RemoteHostsUnavailableError } from "@volli/host-install";

import {
  consoleInstallLogger,
  createDesktopRemoteHosts,
  devTarballsFrom,
  deviceKeyPurpose,
  fileRegistryStore,
  inventoryDeviceKeys,
  readHostdPin,
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
  it("round-trips whole, 0600, and reads a missing or broken file as none", () => {
    const path = join(root, "nested/remote-hosts.json");
    const store = fileRegistryStore(path);
    expect(store.load()).toBeNull();
    const file = { v: 1 as const, hosts: [] };
    store.save(file);
    expect(store.load()).toEqual(file);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, "{");
    expect(store.load()).toEqual({ v: 0 });
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
      logger: consoleInstallLogger({
        debug: (line: string) => lines.push(line),
        info: (line: string) => lines.push(line),
        warn: (line: string) => lines.push(line),
        error: (line: string) => lines.push(line),
      }),
    });
    expect(() => hosts.snapshot()).toThrow(RemoteHostsUnavailableError);
    await expect(hosts.startAdd({ target: "deploy@box" })).rejects.toThrow(
      RemoteHostsUnavailableError,
    );
    expect(() => readFileSync(join(root, "remote-hosts.json"))).toThrow();
    await hosts.close();
  });

  it("logs with the component and the fields it was given", () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = consoleInstallLogger(sink);
    logger.info("step started", { step: "probe" });
    logger.warn("w");
    logger.debug("d");
    logger.error("e");
    expect(sink.info).toHaveBeenCalledWith("[volli] host-install: step started", { step: "probe" });
    expect(sink.warn).toHaveBeenCalledWith("[volli] host-install: w", {});
  });
});
