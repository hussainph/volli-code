import { describe, expect, it } from "vite-plus/test";

import type { ProvisionFailure } from "./failures";
import { initialProvisionState, type ProvisionState } from "./provision";
import {
  failureJson,
  isSkipped,
  logLine,
  questionJson,
  stepStatuses,
  stoppedAt,
  archName,
  flowFacts,
} from "./remote-hosts-flow";

const READY = initialProvisionState({
  host: "box",
  appVersion: "1.1.0",
  device: { publicKey: "SPKI", fingerprint: "SHA256:mac", name: "Mac" },
  pinnedHostId: null,
});

const failedWith = (failure: ProvisionFailure): ProvisionState => ({
  ...READY,
  status: "stopped",
  stop: { kind: "failed", failure },
});

describe("a flow's steps", () => {
  it("shows results as done or skipped, the stopped step, and the one running", () => {
    expect(
      stepStatuses(
        { connect: { ok: true }, probe: {}, deliver: { skipped: true } },
        { step: "install", failed: true },
        null,
      ).map((step) => step.status),
    ).toEqual(["done", "done", "skipped", "failed", "pending", "pending", "pending"]);
    expect(
      stepStatuses({}, { step: "connect", failed: false }, null).map((step) => step.status)[0],
    ).toBe("running");
    expect(stepStatuses({}, null, "connect")[0]).toEqual({ id: "connect", status: "running" });
  });

  it("knows a skipped result", () => {
    expect(isSkipped({ skipped: true })).toBe(true);
    expect(isSkipped({ skipped: "yes" })).toBe(false);
    expect(isSkipped(null)).toBe(false);
    expect(isSkipped("skipped")).toBe(false);
  });

  it("says where a stopped state stopped, and nothing for one that has not", () => {
    expect(stoppedAt(READY)).toBeNull();
    expect(stoppedAt(failedWith({ code: "no-systemd", step: "probe" }))).toEqual({
      step: "connect",
      failed: true,
    });
    const all = {
      ...failedWith({ code: "no-systemd", step: "probe" }),
      results: {
        connect: {},
        probe: {},
        deliver: {},
        install: {},
        start: {},
        enroll: {},
        link: { url: "ws://x" },
      },
    } as unknown as ProvisionState;
    expect(stoppedAt(all)).toBeNull();
  });
});

describe("a flow's question and failure as JSON", () => {
  it("is null when the state did not stop that way", () => {
    expect(questionJson(READY, "q1")).toBeNull();
    expect(failureJson(READY, "box")).toBeNull();
  });

  it("carries a question's own facts", () => {
    const state: ProvisionState = {
      ...READY,
      status: "stopped",
      stop: {
        kind: "question",
        question: { kind: "already-paired", step: "probe", hostId: "h" },
      },
    };
    expect(questionJson(state, "q3")).toEqual({
      id: "q3",
      kind: "already-paired",
      step: "probe",
      hostId: "h",
    });
  });

  it("gives the line, the recovery and any detail", () => {
    expect(
      failureJson(failedWith({ code: "unreachable", step: "connect", detail: "refused" }), "box"),
    ).toEqual({
      code: "unreachable",
      step: "connect",
      line: "Couldn’t reach box",
      recovery: { action: "retry", label: "Try again", from: "connect" },
      detail: "refused",
    });
    expect(
      failureJson(failedWith({ code: "unreachable", step: "connect", detail: "" }), "box")?.detail,
    ).toBeNull();
    expect(failureJson(failedWith({ code: "no-systemd", step: "probe" }), "box")).toMatchObject({
      recovery: { action: "back" },
      detail: null,
    });
    const refused = (detail: string[]) =>
      failureJson(
        failedWith({
          code: "hostd-refused",
          step: "install",
          hostd: "command-failed",
          message: "systemctl failed",
          detail,
        }),
        "box",
      );
    expect(refused(["one", "two"])).toMatchObject({ line: "systemctl failed", detail: "one\ntwo" });
    expect(refused([])?.detail).toBeNull();
  });
});

describe("a flow's log line", () => {
  it("keeps flat fields, writes the rest as JSON, and drops undefined", () => {
    expect(
      logLine("2026-01-01T00:00:00.000Z", "warn", "step failed", {
        step: "probe",
        ms: 3,
        ok: false,
        none: null,
        gone: undefined,
        failure: { code: "no-systemd" },
      }),
    ).toEqual({
      at: "2026-01-01T00:00:00.000Z",
      level: "warn",
      message: "step failed",
      fields: { step: "probe", ms: 3, ok: false, none: null, failure: '{"code":"no-systemd"}' },
    });
  });
});

/** A hostd start answer, as `start --json` prints it. */
function started(mode: "system" | "user", linger: boolean | null) {
  return {
    v: 1 as const,
    ok: true as const,
    mode,
    version: "1.2.0",
    restarted: true,
    hostId: null,
    listen: null,
    linger,
  };
}

describe("what an add has found", () => {
  const probe = {
    kernel: "Linux",
    arch: "aarch64",
    os: { id: "debian", version: "12", name: "Debian GNU/Linux 12 (bookworm)" },
    user: "deploy",
    home: "/home/deploy",
    systemd: 252,
    launchd: false,
    userManager: true,
    linger: false,
    glibc: "2.36",
    disk: { home: 1, system: 1 },
    memoryBytes: 4_000_000_000,
    sudo: "nopasswd",
    existing: null,
    sshHostKeys: [],
    artifactTarget: "linux-arm64",
  } as const;

  it("says nothing before a step has, and never makes a fact up", () => {
    expect(flowFacts({}, {})).toEqual({
      user: null,
      os: null,
      system: null,
      arch: null,
      memoryBytes: null,
      version: null,
      keepsRunning: null,
      alreadyPaired: false,
    });
  });

  it("reads each from the step that found it", () => {
    expect(flowFacts({ probe }, {})).toMatchObject({
      user: "deploy",
      os: "linux",
      system: "Debian GNU/Linux 12 (bookworm)",
      arch: "arm64",
      memoryBytes: 4_000_000_000,
    });
    // A system unit keeps running; a user unit only when it lingers.
    expect(flowFacts({ probe, start: started("system", null) }, {}).keepsRunning).toBe(true);
    expect(flowFacts({ probe, start: started("user", true) }, {}).keepsRunning).toBe(true);
    expect(flowFacts({ probe, start: started("user", false) }, {}).keepsRunning).toBe(false);
    expect(flowFacts({ probe, start: { skipped: true } }, {}).keepsRunning).toBeNull();
    // The version: the install's, else the start's, else the enrollment's.
    expect(flowFacts({ probe, start: started("system", null) }, {}).version).toBe("1.2.0");
    const enroll = {
      v: 1 as const,
      ok: true as const,
      hostId: "h",
      deviceId: "d",
      fingerprint: "SHA256:mac",
      created: false,
      version: "1.3.0",
      listen: null,
    };
    expect(flowFacts({ probe, enroll }, {})).toMatchObject({
      version: "1.3.0",
      alreadyPaired: true,
    });
    expect(flowFacts({}, { alreadyPaired: true }).alreadyPaired).toBe(true);
  });

  it("leaves a Mac's start to its startup line, and blank OS text unsaid", () => {
    const mac = {
      ...probe,
      kernel: "Darwin",
      arch: "arm64",
      os: { id: "macos", version: "", name: " " },
      user: "",
      launchd: true,
    };
    expect(flowFacts({ probe: mac, start: started("user", null) }, {})).toMatchObject({
      os: "macos",
      system: null,
      user: null,
      keepsRunning: null,
    });
  });

  it("names architectures the way people read them", () => {
    expect(archName("x86_64")).toBe("x86-64");
    expect(archName("amd64")).toBe("x86-64");
    expect(archName("aarch64")).toBe("arm64");
    expect(archName("arm64")).toBe("arm64");
    expect(archName("riscv64")).toBe("riscv64");
  });
});
