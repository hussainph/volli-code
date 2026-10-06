import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { bytesToBase64Url } from "@volli/host-protocol";

import { runEnroll, type EnrollCommand, type EnrollPorts } from "./enroll";
import { enrolledDevicesPath } from "./enrolled-devices";
import { installLayout, type InstallLayout } from "./layout";
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

function ports(overrides: Partial<EnrollPorts> = {}): EnrollPorts {
  return {
    uid: () => process.getuid!(),
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
  mode: "system",
  dataDir: null,
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
    await runEnroll(command({ mode: "user" }), ports({ probes: serving({ hostProtocol: null }) }));
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
    writeFileSync(enrolledDevicesPath(layouts.system.dataDir), "{");
    expect((await refusal(runEnroll(command(), ports()))).code).toBe("store-unreadable");
  });
});
