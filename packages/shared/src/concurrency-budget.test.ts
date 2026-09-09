import { describe, expect, it } from "vite-plus/test";

import {
  VOLLI_CONCURRENCY_HINT_ENV,
  concurrencyBudget,
  concurrencyBudgetEnv,
} from "./concurrency-budget";

describe("concurrencyBudget", () => {
  // The ticket's own worked example: an 8-core machine with four other
  // Sessions working gives the fifth two jobs.
  it("divides the cores between the Sessions working on the machine", () => {
    expect(concurrencyBudget(8, 4)).toBe(2);
    expect(concurrencyBudget(8, 2)).toBe(4);
    expect(concurrencyBudget(16, 3)).toBe(5);
  });

  it("gives a Session alone on the machine every core", () => {
    expect(concurrencyBudget(8, 0)).toBe(8);
    expect(concurrencyBudget(8, 1)).toBe(8);
  });

  it("never drops below one job, however crowded the machine", () => {
    expect(concurrencyBudget(8, 40)).toBe(1);
    expect(concurrencyBudget(1, 16)).toBe(1);
  });

  // A host API that answers 0 or NaN must not stop a toolchain dead — that
  // failure is far worse than the over-subscription this exists to prevent.
  it("treats an unusable core count or Session count as one", () => {
    expect(concurrencyBudget(0, 4)).toBe(1);
    expect(concurrencyBudget(Number.NaN, 4)).toBe(1);
    expect(concurrencyBudget(8, Number.NaN)).toBe(8);
    expect(concurrencyBudget(-4, -4)).toBe(1);
    expect(concurrencyBudget(Number.POSITIVE_INFINITY, 2)).toBe(1);
  });

  it("floors a fractional share rather than rounding it up", () => {
    expect(concurrencyBudget(10, 3)).toBe(3);
    expect(concurrencyBudget(8.9, 2)).toBe(4);
  });
});

describe("concurrencyBudgetEnv", () => {
  it("writes the budget in every spelling a toolchain reads", () => {
    expect(concurrencyBudgetEnv(2, {})).toEqual({
      VOLLI_CONCURRENCY_HINT: "2",
      VITEST_MAX_WORKERS: "2",
      CARGO_BUILD_JOBS: "2",
      CMAKE_BUILD_PARALLEL_LEVEL: "2",
      PYTEST_XDIST_AUTO_NUM_WORKERS: "2",
      UV_THREADPOOL_SIZE: "2",
      MAKEFLAGS: "-j2",
      GOFLAGS: "-p=2",
      GRADLE_OPTS: "-Dorg.gradle.workers.max=2",
    });
  });

  it("names the hint by the exported constant", () => {
    expect(concurrencyBudgetEnv(3, {})[VOLLI_CONCURRENCY_HINT_ENV]).toBe("3");
  });

  // The rule the ticket states outright: a user with MAKEFLAGS=-j16 exported in
  // their shell keeps it. Volli fills gaps; it does not clobber.
  it("leaves every variable the surrounding environment already defines", () => {
    const filled = concurrencyBudgetEnv(2, {
      MAKEFLAGS: "-j16",
      CARGO_BUILD_JOBS: "12",
      GOFLAGS: "-mod=vendor",
      GRADLE_OPTS: "-Xmx4g",
    });
    expect(filled["MAKEFLAGS"]).toBeUndefined();
    expect(filled["CARGO_BUILD_JOBS"]).toBeUndefined();
    // Skipped ENTIRELY rather than merged: these are command lines, and
    // appending to one changes what the user's own flags mean.
    expect(filled["GOFLAGS"]).toBeUndefined();
    expect(filled["GRADLE_OPTS"]).toBeUndefined();
    // Everything the user said nothing about is still filled.
    expect(filled).toEqual({
      VOLLI_CONCURRENCY_HINT: "2",
      VITEST_MAX_WORKERS: "2",
      CMAKE_BUILD_PARALLEL_LEVEL: "2",
      PYTEST_XDIST_AUTO_NUM_WORKERS: "2",
      UV_THREADPOOL_SIZE: "2",
    });
  });

  // vitest itself gates on `if (process.env.VITEST_MAX_WORKERS)`, so an
  // exported empty string is not a value any tool acts on.
  it("fills a variable exported as an empty string", () => {
    expect(concurrencyBudgetEnv(2, { VITEST_MAX_WORKERS: "" })["VITEST_MAX_WORKERS"]).toBe("2");
  });

  it("never writes a budget below one, whatever it is handed", () => {
    expect(concurrencyBudgetEnv(0, {})[VOLLI_CONCURRENCY_HINT_ENV]).toBe("1");
    expect(concurrencyBudgetEnv(2.9, {})["MAKEFLAGS"]).toBe("-j2");
  });
});
