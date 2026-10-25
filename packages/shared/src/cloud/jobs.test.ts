import { describe, expect, test } from "vite-plus/test";

import {
  JOB_KINDS,
  JOB_STATUSES,
  TERMINAL_JOB_TTL_MS,
  UNSUPPORTED_JOB_KIND,
  isJobKind,
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
});
