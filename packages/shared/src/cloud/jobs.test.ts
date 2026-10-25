import { describe, expect, test } from "vite-plus/test";

import {
  JOB_RESULT_MAX_CHARS,
  JOB_KINDS,
  JOB_STATUSES,
  TERMINAL_JOB_TTL_MS,
  UNSUPPORTED_JOB_KIND,
  isJobKind,
  isPlainJson,
  jobResultProblem,
  isTerminalJobStatus,
  jobRank,
  unsupportedJobOutcome,
} from "./jobs";

describe("runner jobs", () => {
  test("know the twelve kinds and read the rest as unsupported", () => {
    expect(JOB_KINDS).toHaveLength(12);
    expect(isJobKind("workingCopy.materialize")).toBe(true);
    expect(isJobKind("relay.open")).toBe(false);
    expect(isJobKind(undefined)).toBe(false);
    expect(unsupportedJobOutcome("relay.open")).toEqual({
      status: "failed",
      code: UNSUPPORTED_JOB_KIND,
      detail: 'This runner does not know the job kind "relay.open"; update it.',
      retryable: false,
    });
  });

  test("rank urgent before normal", () => {
    expect(jobRank("urgent")).toBe(0);
    expect(jobRank("normal")).toBe(1);
  });

  test("name the terminal statuses", () => {
    expect(JOB_STATUSES.filter(isTerminalJobStatus)).toEqual([
      "done",
      "failed",
      "cancelled",
      "expired",
    ]);
    expect(TERMINAL_JOB_TTL_MS).toBe(604_800_000);
  });

  test("a result is plain JSON within the bound", () => {
    expect(jobResultProblem({ ok: true, files: [1, "a", null, { nested: false }] })).toBeNull();
    expect(jobResultProblem(Object.create(null))).toBeNull();
    for (const bad of [
      undefined,
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new ArrayBuffer(4),
      new Date(0),
      { f: () => 1 },
      [Symbol("s")],
    ]) {
      expect(jobResultProblem(bad)).toBe("The result is not plain JSON.");
    }
    expect(jobResultProblem("x".repeat(JOB_RESULT_MAX_CHARS))).toMatch(/larger than 65536/);
    let deep: unknown = null;
    for (let index = 0; index < 70; index += 1) deep = [deep];
    expect(isPlainJson(deep)).toBe(false);
  });
});
