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

  it("maps the lab's five rows onto the steps, each step once", () => {
    expect(Object.values(CHECKLIST_ROWS).flat()).toEqual([...STEP_ORDER]);
  });
});
