import { afterEach, describe, expect, it } from "vite-plus/test";

import { captureHostLog, type CapturedHostLog } from "../testing/log";
import { hostLogger } from "./root";
import { SSH_INSTALL_STEPS, startStepLog } from "./steps";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
let log: CapturedHostLog | null = null;
afterEach(() => log?.restore());

describe("a flow of steps as one trace", () => {
  it("names the SSH install's steps in order", () => {
    expect(SSH_INSTALL_STEPS).toEqual(["probe", "upload", "unit", "start", "pair", "connect"]);
  });

  it("logs each step's start and outcome under the Client's trace, lines inside a step included", async () => {
    log = captureHostLog();
    let clock = 1_000;
    const install = startStepLog({
      component: "ssh-install",
      flow: "install",
      traceId: TRACE,
      fields: { host: "box" },
      now: () => clock,
    });
    expect(install.traceId).toBe(TRACE);
    const probed = await install.step("probe", () => {
      hostLogger("ssh").debug("ssh exited", { exitCode: 0 });
      clock += 570;
      return "linux-x64";
    });
    expect(probed).toBe("linux-x64");
    install.info("artifact chosen", { arch: probed });
    await expect(
      install.step(
        "upload",
        async () => {
          clock += 30;
          throw new Error("scp: permission denied");
        },
        { bytes: 42 },
      ),
    ).rejects.toThrow("permission denied");
    install.failed(new Error("upload failed"));
    install.done({ outcome: "abandoned" });
    expect(
      log.records.map(({ component, msg, step, traceId }) => [component, msg, step, traceId]),
    ).toEqual([
      ["ssh-install", "install started", undefined, TRACE],
      ["ssh-install", "step started", "probe", TRACE],
      ["ssh", "ssh exited", "probe", TRACE],
      ["ssh-install", "step done", "probe", TRACE],
      ["ssh-install", "artifact chosen", undefined, TRACE],
      ["ssh-install", "step started", "upload", TRACE],
      ["ssh-install", "step failed", "upload", TRACE],
      ["ssh-install", "install failed", undefined, TRACE],
      ["ssh-install", "install done", undefined, TRACE],
    ]);
    expect(log.records[3]).toMatchObject({ durationMs: 570, host: "box", flow: "install" });
    expect(log.records[6]).toMatchObject({
      bytes: 42,
      durationMs: 30,
      error: { message: "scp: permission denied" },
    });
    expect(log.records[8]).toMatchObject({ durationMs: 600, outcome: "abandoned" });
  });

  it("mints a trace when the Client sent none or a malformed one, and names the step a failure stopped in", async () => {
    log = captureHostLog();
    const flow = startStepLog({ component: "ssh-install", flow: "install", traceId: "nope" });
    expect(flow.traceId).toMatch(/^[0-9a-f]{32}$/u);
    let release!: () => void;
    const pending = flow.step("pair", () => new Promise<void>((resolve) => (release = resolve)));
    flow.failed("timed out");
    release();
    await pending;
    expect(log.records.find(({ msg }) => msg === "install failed")).toMatchObject({ step: "pair" });
    expect(startStepLog({ component: "c", flow: "f" }).traceId).toMatch(/^[0-9a-f]{32}$/u);
  });
});
