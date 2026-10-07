import { describe, expect, it } from "vite-plus/test";

import { CHECKLIST_ROWS, describeFailure, STEP_ORDER, type ProvisionFailure } from "./failures";

const EVERY: ProvisionFailure[] = [
  { code: "unreachable", step: "connect", detail: "" },
  { code: "unresolvable", step: "connect", detail: "" },
  { code: "host-key-changed", step: "connect", detail: "" },
  { code: "host-key-rejected", step: "connect" },
  { code: "password-only", step: "connect", detail: "" },
  { code: "key-refused", step: "connect", detail: "" },
  { code: "ssh-missing", step: "connect", detail: "" },
  { code: "ssh-failed", step: "connect", detail: "" },
  { code: "connection-lost", step: "install", detail: "" },
  { code: "probe-failed", step: "probe", detail: "" },
  { code: "unsupported-system", step: "probe", system: "Darwin" },
  { code: "unsupported-arch", step: "probe", arch: "aarch64" },
  { code: "target-unavailable", step: "probe", target: "darwin-arm64" },
  { code: "target-unavailable", step: "probe", target: "plan9-mips" },
  { code: "no-systemd", step: "probe" },
  { code: "no-user-manager", step: "probe" },
  { code: "glibc-too-old", step: "probe", glibc: "2.31" },
  { code: "disk-full", step: "probe", freeBytes: 96 * 1024 ** 2, needBytes: 420 * 1024 ** 2 },
  { code: "host-newer", step: "probe", version: "9.0.0" },
  { code: "needs-sudo", step: "probe", version: "0.2.4" },
  { code: "artifact-unavailable", step: "deliver", detail: "" },
  { code: "artifact-checksum", step: "deliver", detail: "" },
  { code: "artifact-fetch-failed", step: "deliver", detail: "" },
  { code: "upload-failed", step: "deliver", detail: "" },
  { code: "remote-checksum", step: "deliver", detail: "" },
  { code: "unpack-failed", step: "deliver", detail: "" },
  {
    code: "hostd-refused",
    step: "start",
    hostd: "start-failed",
    message: "volli-hostd did not start.",
    detail: [],
  },
  { code: "tunnel-failed", step: "link", detail: "" },
  { code: "host-key-unverifiable", step: "connect", detail: "1 keys, 0 fingerprints" },
  {
    code: "linger-needs-admin",
    step: "start",
    user: "deploy",
    command: "sudo loginctl enable-linger 'deploy'",
  },
  { code: "unexpected-state", step: "install", detail: "no delivered release to install" },
];

describe("every failure's line and recovery", () => {
  it("has one line and one recovery, retrying from the step that broke", () => {
    for (const failure of EVERY) {
      const { line, recovery } = describeFailure(failure, "box");
      expect(line.length).toBeGreaterThan(0);
      if (recovery.action === "retry") expect(STEP_ORDER).toContain(recovery.from);
    }
    expect(describeFailure(EVERY[17]!, "box")).toEqual({
      line: "96 MB free · needs 420 MB",
      recovery: { action: "retry", label: "Check again", from: "probe" },
    });
    expect(describeFailure(EVERY[11]!, "pi").recovery).toEqual({
      action: "back",
      label: "Choose another host",
    });
    expect(describeFailure(EVERY[26]!, "box").line).toBe("volli-hostd did not start.");
    expect(describeFailure(EVERY[12]!, "mac").line).toBe(
      "Apple silicon Mac hosts aren’t supported by this build yet",
    );
    expect(describeFailure(EVERY[13]!, "x").line).toMatch(/^plan9-mips hosts/u);
  });

  it("hands an administrator's command over, and starts over from the probe when lost", () => {
    expect(describeFailure(EVERY.at(-3)!, "box")).toEqual({
      line: "Couldn’t compute box’s host key fingerprints to show you, so they can’t be checked",
      recovery: { action: "retry", label: "Try again", from: "connect" },
    });
    expect(describeFailure(EVERY.at(-2)!, "box")).toEqual({
      line: "box stops Volli host when deploy logs out. Ask an administrator to run: sudo loginctl enable-linger 'deploy'",
      recovery: { action: "retry", label: "Check again", from: "start" },
    });
    expect(describeFailure(EVERY.at(-1)!, "box")).toEqual({
      line: "Adding box lost track of where it was",
      recovery: { action: "retry", label: "Check again", from: "probe" },
    });
  });

  it("says this Mac could not keep the host, and runs the link again", () => {
    expect(
      describeFailure({ code: "save-failed", step: "link", detail: "disk full" }, "box"),
    ).toEqual({
      line: "Couldn’t save box on this Mac",
      recovery: { action: "retry", label: "Try again", from: "link" },
    });
  });

  it("maps the lab's five rows onto the steps, each step once", () => {
    expect(Object.values(CHECKLIST_ROWS).flat()).toEqual([...STEP_ORDER]);
  });
});
