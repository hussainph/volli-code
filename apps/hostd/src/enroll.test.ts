import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { bytesToBase64Url } from "@volli/host-protocol";

import { runDevices } from "./devices";
import { runEnroll, type EnrollCommand, type EnrollPorts } from "./enroll";
import { enrolledDevicesPath, readEnrolledDevices, rootDeviceStore } from "./enrolled-devices";
import { installLayout, layoutDeviceStore, type InstallLayout } from "./layout";
import { ManagementError } from "./management";
import type { HostdStatus, StatusProbes } from "./status";

let root: string;
let layouts: Record<"system" | "user", InstallLayout>;
const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hostd-enroll-"));
  layouts = {
    system: installLayout("system", { prefix: root, home: join(root, "home"), env: {} }),
    user: installLayout("user", { home: join(root, "home"), env: {} }),
  };
  mkdirSync(layouts.system.dataDir, { recursive: true });
  mkdirSync(join(root, "etc"), { recursive: true, mode: 0o755 });
  chmodSync(join(root, "etc"), 0o755);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const spki = () =>
  bytesToBase64Url(
    generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
      format: "der",
      type: "spki",
    }),
  );

function serving(overrides: Partial<HostdStatus> = {}): StatusProbes {
  return {
    read: () =>
      ({
        v: 1,
        state: "serving",
        pid: 1,
        socketPath: "/run/volli-hostd.sock",
        version: "1.1.0",
        hostId: HOST,
        hostProtocol: { url: "ws://127.0.0.1:7420", host: "127.0.0.1", port: 7420 },
        ...overrides,
      }) as HostdStatus,
    alive: () => true,
    accepts: async () => true,
  };
}

const ME = process.getuid!();
/** The service account: neither root nor the store's owner. */
const VOLLI_UID = ME + 4242;

function ports(overrides: Partial<EnrollPorts> = {}): EnrollPorts {
  return {
    uid: () => ME,
    // The tests' own uid stands in for root as the system store's owner.
    trustedOwnerUid: ME,
    layouts,
    probes: serving(),
    version: "1.1.0",
    now: () => new Date("2026-10-07T00:00:00Z"),
    newId: randomUUID,
    ...overrides,
  };
}

const command = (overrides: Partial<EnrollCommand> = {}): EnrollCommand => ({
  kind: "enroll",
  mode: null,
  dataDir: join(root, "own"),
  publicKey: spki(),
  name: "Alice's Mac",
  ...overrides,
});

async function refusal(work: Promise<unknown>): Promise<ManagementError> {
  const error = await work.then(
    () => new Error("expected a refusal"),
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ManagementError);
  return error as ManagementError;
}

describe("enroll", () => {
  beforeEach(() => {
    mkdirSync(join(root, "own"));
  });

  it("trusts the key and answers the host id the desktop pins, idempotently", async () => {
    const key = command();
    const first = await runEnroll(key, ports());
    expect(first).toMatchObject({
      v: 1,
      ok: true,
      hostId: HOST,
      created: true,
      version: "1.1.0",
      listen: { host: "127.0.0.1", port: 7420 },
    });
    expect(first.fingerprint).toMatch(/^SHA256:/u);
    const again = await runEnroll(key, ports());
    expect(again).toMatchObject({ deviceId: first.deviceId, created: false });
  });

  it("finds the data directory from the mode, or takes it as given", async () => {
    mkdirSync(layouts.user.dataDir, { recursive: true });
    await runEnroll(
      command({ mode: "user", dataDir: null }),
      ports({ probes: serving({ hostProtocol: null }) }),
    );
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    expect(
      (
        await runEnroll(
          command({ mode: null, dataDir: elsewhere }),
          ports({ probes: serving({ hostProtocol: undefined }) }),
        )
      ).listen,
    ).toBeNull();
  });

  it("refuses root, another account's data directory, and a host that is not serving", async () => {
    expect((await refusal(runEnroll(command(), ports({ uid: () => 0 })))).code).toBe("is-root");
    expect(
      (await refusal(runEnroll(command({ dataDir: layouts.system.dataDir }), ports()))).message,
    ).toMatch(/is the system install's: run enroll --system as root/u);
    expect((await refusal(runEnroll(command(), ports({ uid: () => 4242 })))).code).toBe(
      "data-dir-owner",
    );
    expect((await refusal(runEnroll(command({ dataDir: join(root, "none") }), ports()))).code).toBe(
      "not-installed",
    );
    const notServing: StatusProbes = { ...serving(), read: () => null };
    expect(await refusal(runEnroll(command(), ports({ probes: notServing })))).toMatchObject({
      code: "not-serving",
      detail: ["no status file"],
    });
    expect(
      await refusal(runEnroll(command(), ports({ probes: serving({ hostId: null }) }))),
    ).toMatchObject({ code: "not-serving", detail: [] });
  });

  it("refuses a key that is not P-256, and a store that is not its own", async () => {
    expect((await refusal(runEnroll(command({ publicKey: "AAAA" }), ports()))).code).toBe(
      "bad-key",
    );
    writeFileSync(enrolledDevicesPath(join(root, "own")), "{");
    expect((await refusal(runEnroll(command(), ports()))).code).toBe("store-unreadable");
  });
});

// S-B1: an enrolled device acts as the person. On a system install every
// Session runs as `volli`, so `volli` must be able neither to enroll nor to
// write where enrolled keys are kept.
describe("enroll --system", () => {
  const system = (overrides: Partial<EnrollCommand> = {}) =>
    command({ mode: "system", dataDir: null, ...overrides });
  const asRoot = (overrides: Partial<EnrollPorts> = {}) => ports({ uid: () => 0, ...overrides });

  it("refuses the service account: only root may enroll a device that acts as the person", async () => {
    const error = await refusal(runEnroll(system(), ports({ uid: () => VOLLI_UID })));
    expect(error).toMatchObject({ code: "not-root", exitCode: 77 });
    expect(readEnrolledDevices(layoutDeviceStore(layouts.system, ME))).toEqual([]);
    // Nor through the data directory it owns: the system host never reads that.
    expect(
      (await refusal(runEnroll(system({ mode: null, dataDir: layouts.system.dataDir }), ports())))
        .code,
    ).toBe("usage");
  });

  it("as root, keeps the key in root's 0644 store outside the data directory", async () => {
    const previous = process.umask(0o077);
    let first;
    try {
      first = await runEnroll(system(), asRoot());
    } finally {
      process.umask(previous);
    }
    expect(first).toMatchObject({ ok: true, hostId: HOST, created: true });
    const file = layouts.system.devicesFile;
    expect(file).toBe(join(root, "etc/volli-hostd-devices"));
    const stat = statSync(file);
    // Readable by hostd's account, writable by root alone (its owner here is the stand-in).
    expect(stat.mode & 0o777).toBe(0o644);
    expect(stat.uid).toBe(ME);
    expect(readEnrolledDevices(rootDeviceStore(file, ME))).toMatchObject([
      { deviceId: first.deviceId },
    ]);
    expect(readEnrolledDevices(rootDeviceStore(file, VOLLI_UID))).toBe("untrusted");
    expect(() => statSync(enrolledDevicesPath(layouts.system.dataDir))).toThrow();
    expect((await runEnroll(system({ publicKey: spki() }), asRoot())).created).toBe(true);
  });

  it("refuses a system store the service account could write, and never overwrites it", async () => {
    await runEnroll(system(), asRoot());
    chmodSync(layouts.system.devicesFile, 0o666);
    expect(await refusal(runEnroll(system({ publicKey: spki() }), asRoot()))).toMatchObject({
      code: "store-untrusted",
    });
    expect(readEnrolledDevices(layoutDeviceStore(layouts.system, ME))).toBe("untrusted");
    chmodSync(layouts.system.devicesFile, 0o644);
    expect((await refusal(runEnroll(system(), asRoot({ trustedOwnerUid: VOLLI_UID })))).code).toBe(
      "store-untrusted",
    );
  });
});

describe("devices list | revoke", () => {
  it("lists without keys and revokes as root on a system install, idempotently", async () => {
    const enrolled = await runEnroll(
      command({ mode: "system", dataDir: null }),
      ports({ uid: () => 0 }),
    );
    const base = { kind: "devices" as const, mode: "system" as const, dataDir: null };
    const listed = runDevices(
      { ...base, action: "list", deviceId: null },
      ports({ uid: () => VOLLI_UID }),
    );
    expect(listed).toMatchObject({ ok: true, devices: [{ deviceId: enrolled.deviceId }] });
    expect(JSON.stringify(listed)).not.toContain("publicKey");
    const revoke = { ...base, action: "revoke" as const, deviceId: enrolled.deviceId };
    expect(() => runDevices(revoke, ports({ uid: () => VOLLI_UID }))).toThrow(
      expect.objectContaining({ code: "not-root" }),
    );
    expect(runDevices(revoke, ports({ uid: () => 0 }))).toMatchObject({
      ok: true,
      changed: true,
      device: { deviceId: enrolled.deviceId, revokedAt: "2026-10-07T00:00:00.000Z" },
    });
    expect(runDevices(revoke, ports({ uid: () => 0 }))).toMatchObject({ changed: false });
    expect(() =>
      runDevices({ ...revoke, deviceId: randomUUID() }, ports({ uid: () => 0 })),
    ).toThrow(expect.objectContaining({ code: "unknown-device" }));
  });

  it("revokes in a user install's own store, as its owner", async () => {
    mkdirSync(join(root, "own"));
    const enrolled = await runEnroll(command(), ports());
    const revoke = {
      kind: "devices" as const,
      action: "revoke" as const,
      mode: null,
      dataDir: join(root, "own"),
      deviceId: enrolled.deviceId,
    };
    expect(() => runDevices(revoke, ports({ uid: () => 0 }))).toThrow(
      expect.objectContaining({ code: "is-root" }),
    );
    expect(runDevices(revoke, ports())).toMatchObject({ changed: true });
    expect(runDevices({ ...revoke, action: "list", deviceId: null }, ports())).toMatchObject({
      devices: [{ revokedAt: "2026-10-07T00:00:00.000Z" }],
    });
  });

  it("lists a user install's store from its mode", () => {
    expect(
      runDevices(
        { kind: "devices", action: "list", mode: "user", dataDir: null, deviceId: null },
        ports(),
      ),
    ).toEqual({ v: 1, ok: true, devices: [] });
  });

  it("refuses to list a store it cannot read or trust", async () => {
    mkdirSync(join(root, "own"));
    writeFileSync(enrolledDevicesPath(join(root, "own")), "{");
    const list = { kind: "devices" as const, action: "list" as const, deviceId: null };
    expect(() => runDevices({ ...list, mode: null, dataDir: join(root, "own") }, ports())).toThrow(
      expect.objectContaining({ code: "store-unreadable" }),
    );
    await runEnroll(command({ mode: "system", dataDir: null }), ports({ uid: () => 0 }));
    chmodSync(layouts.system.devicesFile, 0o666);
    expect(() => runDevices({ ...list, mode: "system", dataDir: null }, ports())).toThrow(
      expect.objectContaining({ code: "store-untrusted" }),
    );
  });

  it.skipIf(ME === 0)("passes on a failure that is no refusal of the store's", () => {
    const dir = join(root, "readonly");
    mkdirSync(dir);
    writeFileSync(enrolledDevicesPath(dir), JSON.stringify({ v: 1, devices: [] }));
    chmodSync(dir, 0o500);
    try {
      expect(() =>
        runDevices(
          { kind: "devices", action: "revoke", mode: null, dataDir: dir, deviceId: randomUUID() },
          ports(),
        ),
      ).toThrow(expect.objectContaining({ code: "EACCES" }));
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
