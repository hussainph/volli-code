import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { installLayout, type InstallLayout } from "./layout";
import { managedStatus, type ManagedStatusPorts } from "./manage-status";
import { writeManaged, type CommandResult } from "./management";
import type { HostdStatus, StatusProbes } from "./status";

let root: string;
let layouts: Record<"system" | "user", InstallLayout>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hostd-status-json-"));
  layouts = {
    system: installLayout("system", { prefix: root, home: join(root, "home"), env: {} }),
    user: installLayout("user", { home: join(root, "home"), env: {} }),
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const RUNNING = {
  v: 1,
  state: "serving",
  pid: 7,
  version: "1.0.0",
  socketPath: "/run/volli-hostd.sock",
  hostId: "host-1",
  hostProtocol: { url: "ws://127.0.0.1:7420", host: "127.0.0.1", port: 7420 },
} as HostdStatus;

function probes(status: HostdStatus | null): StatusProbes {
  return { read: () => status, alive: () => true, accepts: async () => true };
}

function ports(overrides: Partial<ManagedStatusPorts> = {}): ManagedStatusPorts {
  return {
    layouts,
    run: (tool): CommandResult =>
      tool === "loginctl"
        ? { code: 0, stdout: "yes\n", stderr: "" }
        : { code: 0, stdout: "ActiveState=active\nUnitFileState=enabled\n", stderr: "" },
    probes: probes(RUNNING),
    login: () => "alice",
    version: "1.1.0",
    ...overrides,
  };
}

/** A managed install of `version`, as `install` leaves one. */
function installed(layout: InstallLayout, ...versions: string[]): void {
  for (const version of versions) mkdirSync(join(layout.releasesDir, version), { recursive: true });
  symlinkSync(join("releases", versions.at(-1)!), layout.currentLink);
  writeManaged(layout, {
    v: 1,
    mode: layout.mode,
    version: versions.at(-1)!,
    port: 7420,
    installedAt: "t",
  });
}

describe("status --json", () => {
  it("describes a managed system install, its unit, the running host and its devices", async () => {
    installed(layouts.system, "1.0.0", "1.1.0");
    mkdirSync(layouts.system.dataDir, { recursive: true });
    writeFileSync(
      join(layouts.system.dataDir, "enrolled-devices.json"),
      JSON.stringify({
        v: 1,
        devices: [
          {
            deviceId: "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
            name: "Mac",
            publicKey: "secret-ish",
            fingerprint: "SHA256:x",
            enrolledAt: "t",
            via: "ssh",
            revokedAt: null,
          },
        ],
      }),
    );
    const status = await managedStatus({ kind: "status-json", mode: null, dataDir: null }, ports());
    expect(status).toEqual({
      v: 1,
      management: 1,
      binary: { version: "1.1.0" },
      mode: "system",
      install: {
        root: layouts.system.root,
        current: "1.1.0",
        releases: ["1.0.0", "1.1.0"],
        flat: false,
        port: 7420,
      },
      unit: { name: "volli-hostd.service", active: "active", enabled: "enabled" },
      linger: null,
      dataDir: layouts.system.dataDir,
      verdict: "serving",
      detail: null,
      running: {
        state: "serving",
        version: "1.0.0",
        pid: 7,
        hostId: "host-1",
        listen: { host: "127.0.0.1", port: 7420 },
      },
      devices: [
        {
          deviceId: "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
          name: "Mac",
          fingerprint: "SHA256:x",
          enrolledAt: "t",
          via: "ssh",
          revokedAt: null,
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("secret-ish");
  });

  it("recognises the runbook's hand-made install by its unit and flat layout", async () => {
    mkdirSync(join(layouts.system.root, "bin"), { recursive: true });
    writeFileSync(join(layouts.system.root, "bin/volli-hostd"), "");
    mkdirSync(layouts.system.unitDir, { recursive: true });
    writeFileSync(join(layouts.system.unitDir, "volli-hostd.service"), "");
    const { hostId: _, hostProtocol: __, ...older } = RUNNING;
    const status = await managedStatus(
      { kind: "status-json", mode: null, dataDir: null },
      ports({ probes: probes(older as HostdStatus) }),
    );
    expect(status).toMatchObject({
      mode: "system",
      install: { current: null, releases: [], flat: true, port: null },
      running: { hostId: null, listen: null },
    });
  });

  it("finds a user install by its record or its unit, with lingering", async () => {
    installed(layouts.user, "1.1.0");
    expect(
      await managedStatus(
        { kind: "status-json", mode: null, dataDir: null },
        ports({ probes: probes(null) }),
      ),
    ).toMatchObject({
      mode: "user",
      linger: true,
      verdict: "not-serving",
      detail: "no status file",
      running: null,
    });
    rmSync(layouts.user.managedFile);
    mkdirSync(layouts.user.unitDir, { recursive: true });
    writeFileSync(join(layouts.user.unitDir, "volli-hostd.service"), "");
    expect(
      (await managedStatus({ kind: "status-json", mode: null, dataDir: null }, ports())).mode,
    ).toBe("user");
  });

  it("says plainly when nothing is installed, or when only a data directory was named", async () => {
    expect(
      await managedStatus({ kind: "status-json", mode: null, dataDir: null }, ports()),
    ).toMatchObject({
      mode: null,
      install: null,
      unit: null,
      dataDir: null,
      verdict: "not-serving",
      detail: "not installed",
      running: null,
      devices: null,
    });
    const dir = join(root, "data");
    mkdirSync(dir);
    writeFileSync(join(dir, "enrolled-devices.json"), "{");
    expect(
      await managedStatus({ kind: "status-json", mode: "system", dataDir: dir }, ports()),
    ).toMatchObject({
      mode: null,
      install: null,
      unit: null,
      dataDir: dir,
      verdict: "serving",
      devices: null,
    });
    expect(
      (await managedStatus({ kind: "status-json", mode: "user", dataDir: null }, ports())).install,
    ).toBeNull();
  });
});
