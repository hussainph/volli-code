import { describe, expect, it } from "vite-plus/test";

import {
  artifactTarget,
  compareVersions,
  describeSystem,
  parseProbe,
  PROBE_SCRIPT,
  probeHost,
} from "./probe";
import type { SshTransport } from "./ssh";

const STATUS = JSON.stringify({ v: 1, management: 1, verdict: "serving", devices: [] });

const UBUNTU = [
  "kernel=Linux",
  "arch=x86_64",
  "os_id=ubuntu",
  "os_version=24.04",
  "os_name=Ubuntu 24.04.1 LTS",
  "user=deploy",
  "home=/home/deploy",
  "groups=deploy sudo",
  "systemd=255",
  "user_manager=yes",
  "linger=no",
  "glibc=2.39",
  "disk_home=1258291",
  "disk_system=20971520",
  "mem_kb=8167236",
  "sudo=nopasswd",
].join("\n");

const transport = (code: number, stdout: string): SshTransport => ({
  target: { destination: "box", port: null, label: "box" },
  exec: async () => ({ code, stdout, stderr: "boom" }),
  close: async () => {},
});

describe("the probe", () => {
  it("is plain sh that looks at every candidate install", () => {
    expect(PROBE_SCRIPT).toContain("/opt/volli-hostd/current/bin/volli-hostd");
    expect(PROBE_SCRIPT).toContain("sudo -n -u volli");
    expect(PROBE_SCRIPT).not.toMatch(/\bsudo (?!-n)/u);
  });

  it("reads a fresh Ubuntu box", () => {
    expect(parseProbe(UBUNTU)).toEqual({
      kernel: "Linux",
      arch: "x86_64",
      os: { id: "ubuntu", version: "24.04", name: "Ubuntu 24.04.1 LTS" },
      user: "deploy",
      home: "/home/deploy",
      systemd: 255,
      launchd: false,
      userManager: true,
      linger: false,
      glibc: "2.39",
      disk: { home: 1258291 * 1024, system: 20971520 * 1024 },
      memoryBytes: 8167236 * 1024,
      sudo: "nopasswd",
      existing: null,
    });
  });

  it("reads an existing hostd, managed or from before VC-700", () => {
    const managed = parseProbe(
      `${UBUNTU}\nhostd=system managed 1.0.0\nhostd_path=/opt/volli-hostd/current/bin/volli-hostd\nstatus=${STATUS}`,
    );
    expect(managed.existing).toEqual({
      binary: "/opt/volli-hostd/current/bin/volli-hostd",
      version: "1.0.0",
      mode: "system",
      flat: false,
      status: JSON.parse(STATUS),
    });
    const old = parseProbe(
      `${UBUNTU}\nhostd=system flat\nhostd_path=/opt/volli-hostd/bin/volli-hostd\nstatus=`,
    );
    expect(old.existing).toMatchObject({ flat: true, version: "", status: null });
    expect(
      parseProbe(`${UBUNTU}\nhostd=user managed 1.0.0\nstatus={"v":1}`).existing?.status,
    ).toBeNull();
  });

  it("knows sudo, lingering and systemd only from what the box said", () => {
    const without = (key: string) =>
      UBUNTU.split("\n")
        .filter((line) => !line.startsWith(`${key}=`))
        .join("\n");
    expect(parseProbe(without("sudo")).sudo).toBe("password");
    expect(parseProbe(without("sudo").replace("deploy sudo", "deploy wheel")).sudo).toBe(
      "password",
    );
    expect(parseProbe(without("sudo").replace("deploy sudo", "deploy admin")).sudo).toBe(
      "password",
    );
    expect(parseProbe(without("sudo").replace("deploy sudo", "deploy")).sudo).toBe("none");
    expect(parseProbe(UBUNTU.replace("linger=no", "linger=yes")).linger).toBe(true);
    expect(parseProbe(UBUNTU.replace("linger=no", "linger=")).linger).toBeNull();
    expect(parseProbe(without("systemd")).systemd).toBeNull();
    expect(parseProbe(UBUNTU.replace("glibc=2.39", "glibc=")).glibc).toBeNull();
    expect(parseProbe(UBUNTU.replace("disk_home=1258291", "disk_home=")).disk.home).toBeNull();
    expect(parseProbe("=junk\nnoequals").kernel).toBe("");
  });

  it("reads a Mac as a launchd host with its memory in bytes", () => {
    const mac = parseProbe(
      [
        "kernel=Darwin",
        "arch=arm64",
        "os_id=macos",
        "os_version=26.5.1",
        "os_name=macOS 26.5.1",
        "launchd=yes",
        "mem_bytes=17179869184",
        "groups=staff admin",
        "linger=",
        "glibc=",
      ].join("\n"),
    );
    expect(mac).toMatchObject({ launchd: true, systemd: null, glibc: null, sudo: "password" });
    expect(describeSystem(mac)).toEqual(["macOS 26.5", "arm64", "16 GB"]);
  });

  it("runs over the transport, and says when it could not", async () => {
    expect(await probeHost(transport(0, UBUNTU))).toMatchObject({
      ok: true,
      facts: { kernel: "Linux" },
    });
    expect(await probeHost(transport(1, UBUNTU))).toMatchObject({ ok: true });
    expect(await probeHost(transport(255, ""))).toEqual({ ok: false, code: 255, stderr: "boom" });
  });

  it("maps architectures to artifacts, and describes the box in three facts", () => {
    expect(artifactTarget({ kernel: "Linux", arch: "x86_64" })).toBe("linux-x64");
    expect(artifactTarget({ kernel: "Linux", arch: "amd64" })).toBe("linux-x64");
    expect(artifactTarget({ kernel: "Linux", arch: "aarch64" })).toBe("linux-arm64");
    expect(artifactTarget({ kernel: "Linux", arch: "arm64" })).toBe("linux-arm64");
    expect(artifactTarget({ kernel: "Linux", arch: "riscv64" })).toBeNull();
    expect(artifactTarget({ kernel: "Darwin", arch: "arm64" })).toBe("darwin-arm64");
    expect(artifactTarget({ kernel: "Darwin", arch: "x86_64" })).toBe("darwin-x64");
    expect(artifactTarget({ kernel: "FreeBSD", arch: "amd64" })).toBeNull();
    const facts = parseProbe(UBUNTU);
    expect(describeSystem(facts)).toEqual(["Ubuntu 24.04", "x86-64", "8 GB"]);
    expect(
      describeSystem({
        ...facts,
        arch: "aarch64",
        os: { ...facts.os, name: "" },
        memoryBytes: null,
      }),
    ).toEqual(["Linux", "arm64"]);
    expect(describeSystem({ ...facts, arch: "riscv64" })[1]).toBe("riscv64");
  });

  it("orders versions numerically, a prerelease before its release", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.0.1", "1.0")).toBe(1);
    expect(compareVersions("1.0.0-canary.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-canary.1")).toBe(1);
    expect(compareVersions("1.0.0-canary.1", "1.0.0-canary.2")).toBe(-1);
    expect(compareVersions("1.0.0-canary.2", "1.0.0-canary.1")).toBe(1);
    expect(compareVersions("x.y", "0.0")).toBe(0);
  });
});
