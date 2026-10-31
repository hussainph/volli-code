import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { RUNNER } from "./identity";
import {
  checkRunnerStatus,
  RUNNER_STATES,
  runnerVerdict,
  type RunnerState,
  type RunnerStatus,
} from "./runner-status";
import { statusExitCode, statusFilePath, writeStatus } from "./status";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "runner-status-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function status(state: RunnerState): RunnerStatus {
  return {
    v: 1,
    state,
    pid: 4242,
    version: "0.3.0",
    startedAt: "2026-10-31T12:00:00.000Z",
    updatedAt: "2026-10-31T12:00:01.000Z",
    dataDir,
    socketPath: join(dataDir, "volli.sock"),
    link: null,
    backend: null,
    update: null,
    credentials: null,
  };
}

describe("the runner's status", () => {
  it("lives in runner-status.json", () => {
    expect(statusFilePath(RUNNER, dataDir)).toBe(join(dataDir, "runner-status.json"));
  });

  it("serves only online, refuses while up but not online, and is not serving unlinked", () => {
    const codes = Object.fromEntries(
      RUNNER_STATES.map((state) => {
        const verdict = runnerVerdict(state) ?? "not-serving";
        return [state, statusExitCode(verdict)];
      }),
    );
    expect(codes).toEqual({
      starting: 3,
      unlinked: 3,
      connecting: 1,
      online: 0,
      offline: 1,
      revoked: 1,
      draining: 1,
      updating: 1,
      stopping: 3,
      stopped: 3,
    });
  });

  it("is not serving with no file, and reads a live one through the probes", async () => {
    expect(await checkRunnerStatus(dataDir)).toEqual({
      verdict: "not-serving",
      detail: "no status file",
      status: null,
    });
    writeStatus(RUNNER, dataDir, status("unlinked"));
    const probes = {
      read: () => status("unlinked"),
      alive: () => true,
      accepts: () => Promise.resolve(true),
    };
    expect(await checkRunnerStatus(dataDir, probes)).toEqual({
      verdict: "not-serving",
      detail: "unlinked",
      status: status("unlinked"),
    });
  });
});
