import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  isBlockingSetupRun,
  markSetupStartedAnyway,
  readEnvironmentRun,
  recordEnvironmentRun,
  type EnvironmentRunStart,
} from "./environment-runs";
import { claimFirstRunSetup, markFirstRunPending, workingCopyRecordPath } from "./first-run";
import { retryWorktreeSetup, startWorktreeSetupAnyway, worktreeSetupStatus } from "./setup-gate";

let home: string;
const worktreePath = "/wt/VC-1";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "volli-setup-gate-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const start: EnvironmentRunStart = {
  script: "setup",
  source: "repo",
  scriptSha: "sha",
  reason: "new-working-copy",
  runnerKind: "mac",
  ticketId: "t",
  startedAt: 1,
};

function record(outcome: "succeeded" | "failed" | "timed_out") {
  return recordEnvironmentRun({ home }, worktreePath, start, {
    endedAt: 2,
    outcome,
    exitCode: outcome === "failed" ? 1 : outcome === "succeeded" ? 0 : null,
    summary: `${outcome}.`,
    tail: "",
  });
}

describe("environment run facts", () => {
  it("keeps the last run per script, each with its own UUID", () => {
    expect(readEnvironmentRun({ home }, worktreePath, "setup")).toBeNull();
    const first = record("failed");
    const second = record("succeeded");

    expect(second.id).not.toBe(first.id);
    expect(second.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readEnvironmentRun({ home }, worktreePath, "setup")).toEqual(second);
    expect(readEnvironmentRun({ home }, worktreePath, "resume")).toBeNull();
  });

  it("refuses to read a record it cannot parse as a fact, rather than read it as nothing", () => {
    record("failed");
    const path = workingCopyRecordPath({ home }, worktreePath, "setup-run.json");
    writeFileSync(path, JSON.stringify({ id: "x" }));
    expect(() => readEnvironmentRun({ home }, worktreePath, "setup")).toThrow(/malformed/);
    writeFileSync(path, "null");
    expect(() => readEnvironmentRun({ home }, worktreePath, "setup")).toThrow(/malformed/);
    writeFileSync(path, "{");
    expect(() => readEnvironmentRun({ home }, worktreePath, "setup")).toThrow();
  });

  it("blocks on a failed or timed-out run until someone starts anyway", () => {
    expect(isBlockingSetupRun(null)).toBe(false);
    expect(isBlockingSetupRun(record("succeeded"))).toBe(false);
    expect(isBlockingSetupRun(record("timed_out"))).toBe(true);
    expect(markSetupStartedAnyway({ home }, worktreePath, "t", 9)).toMatchObject({
      startedAnywayAt: 9,
    });
    expect(isBlockingSetupRun(readEnvironmentRun({ home }, worktreePath, "setup"))).toBe(false);
    expect(markSetupStartedAnyway({ home }, worktreePath, "t", 10)).toBeNull();
  });
});

describe("the setup gate", () => {
  it("reads none, pending, succeeded, failed and started-anyway", () => {
    expect(worktreeSetupStatus({ home }, worktreePath, "t", 1)).toEqual({ kind: "none" });
    markFirstRunPending({ home }, worktreePath, "t", ["setup"]);
    expect(worktreeSetupStatus({ home }, worktreePath, "t", 1)).toEqual({ kind: "pending" });
    claimFirstRunSetup({ home }, worktreePath);
    record("succeeded");
    expect(worktreeSetupStatus({ home }, worktreePath, "t", 1)).toMatchObject({
      kind: "succeeded",
    });
    record("failed");
    expect(worktreeSetupStatus({ home }, worktreePath, "t", 1)).toMatchObject({ kind: "failed" });
    expect(startWorktreeSetupAnyway({ home }, worktreePath, "t", 5)).toMatchObject({
      kind: "started-anyway",
      run: { startedAnywayAt: 5 },
    });
    expect(worktreeSetupStatus({ home }, worktreePath, "t", 1)).toMatchObject({
      kind: "started-anyway",
    });
  });

  it("owes the run again on Retry after a failure, and only then", () => {
    expect(retryWorktreeSetup({ home }, worktreePath, "t", 1)).toEqual({ kind: "none" });
    record("succeeded");
    expect(retryWorktreeSetup({ home }, worktreePath, "t", 1)).toMatchObject({ kind: "succeeded" });
    record("failed");
    expect(retryWorktreeSetup({ home }, worktreePath, "t", 1)).toEqual({ kind: "pending" });
    // A run already owed is not owed twice, and the claim takes it once.
    expect(retryWorktreeSetup({ home }, worktreePath, "t", 1)).toEqual({ kind: "pending" });
    expect(claimFirstRunSetup({ home }, worktreePath)).toBe(true);
    expect(claimFirstRunSetup({ home }, worktreePath)).toBe(false);
    // Retrying a working copy someone started anyway owes it again too.
    startWorktreeSetupAnyway({ home }, worktreePath, "t", 1);
    expect(retryWorktreeSetup({ home }, worktreePath, "t", 1)).toEqual({ kind: "pending" });
  });

  it("reads a record it cannot read as a failed setup that either answer replaces", () => {
    record("failed");
    const path = workingCopyRecordPath({ home }, worktreePath, "setup-run.json");
    writeFileSync(path, "{");
    expect(worktreeSetupStatus({ home }, worktreePath, "t", 1)).toMatchObject({
      kind: "failed",
      run: { summary: "The environment setup record could not be read." },
    });
    expect(startWorktreeSetupAnyway({ home }, worktreePath, "t", 4)).toMatchObject({
      kind: "started-anyway",
      run: { startedAnywayAt: 4 },
    });
    writeFileSync(path, "{");
    expect(retryWorktreeSetup({ home }, worktreePath, "t", 1)).toEqual({ kind: "pending" });
  });

  it("keeps an outcome a later build wrote, without blocking on it", () => {
    const path = workingCopyRecordPath({ home }, worktreePath, "setup-run.json");
    record("failed");
    const fact = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...fact, outcome: "cancelled" }));
    expect(worktreeSetupStatus({ home }, worktreePath, "t", 1)).toMatchObject({
      kind: "succeeded",
      run: { outcome: "cancelled" },
    });
  });

  it("forgets an earlier working copy's runs when a new one is created at the same path", () => {
    record("failed");
    markFirstRunPending({ home }, worktreePath, "t", ["copy"]);
    expect(readEnvironmentRun({ home }, worktreePath, "setup")).toBeNull();
    expect(worktreeSetupStatus({ home }, worktreePath, "t", 1)).toEqual({ kind: "none" });
  });

  it("answers Start anyway only for a failed setup", () => {
    expect(startWorktreeSetupAnyway({ home }, worktreePath, "t", 1)).toEqual({ kind: "none" });
    record("succeeded");
    expect(startWorktreeSetupAnyway({ home }, worktreePath, "t", 1)).toMatchObject({
      kind: "succeeded",
    });
  });
});
