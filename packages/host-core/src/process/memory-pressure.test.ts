import { describe, expect, it, vi } from "vite-plus/test";

import {
  judgeMemoryPressure,
  parseFreePercentage,
  parseSwapUsedBytes,
  readMemoryPressure,
} from "./memory-pressure";

const PRESSURE_FIXTURE = [
  "The system has 17179869184 (1048576 pages with a page size of 16384).",
  "System-wide memory free percentage: 42%",
].join("\n");
const SWAP_FIXTURE = "vm.swapusage: total = 15360.00M  used = 14408.94M  free = 951.06M";

describe("parseFreePercentage", () => {
  it("reads the number macOS itself reasons about", () => {
    expect(parseFreePercentage(PRESSURE_FIXTURE)).toBe(42);
    expect(parseFreePercentage("System-wide memory free percentage: 7.5%")).toBe(7.5);
  });

  it("answers null for output that says nothing legible", () => {
    expect(parseFreePercentage("")).toBeNull();
    expect(parseFreePercentage("free percentage: lots%")).toBeNull();
  });
});

describe("parseSwapUsedBytes", () => {
  it("scales every unit sysctl might print", () => {
    expect(parseSwapUsedBytes(SWAP_FIXTURE)).toBeCloseTo(14408.94 * 1024 ** 2, 0);
    expect(parseSwapUsedBytes("used = 2.00G")).toBe(2 * 1024 ** 3);
    expect(parseSwapUsedBytes("used = 512.00K")).toBe(512 * 1024);
    expect(parseSwapUsedBytes("used = 1.00T")).toBe(1024 ** 4);
  });

  it("answers null when there is no reading in the output", () => {
    expect(parseSwapUsedBytes("vm.swapusage: total = 0.00M")).toBeNull();
  });
});

describe("judgeMemoryPressure", () => {
  it("calls a comfortable machine comfortable, and reports what it measured", () => {
    expect(judgeMemoryPressure(42, 1024 ** 3)).toEqual({
      underPressure: false,
      detail: "free 42%, swap 1.0 GB",
    });
  });

  it("raises the flag on either reading alone", () => {
    expect(judgeMemoryPressure(6, 0).underPressure).toBe(true);
    expect(judgeMemoryPressure(80, 9 * 1024 ** 3).underPressure).toBe(true);
    expect(judgeMemoryPressure(null, 9 * 1024 ** 3)).toMatchObject({ underPressure: true });
    expect(judgeMemoryPressure(6, null)).toMatchObject({ underPressure: true });
  });

  it("reports an unreadable machine as no pressure, so nothing is killed on a guess", () => {
    expect(judgeMemoryPressure(null, null)).toEqual({
      underPressure: false,
      detail: "memory pressure could not be measured",
    });
  });
});

describe("readMemoryPressure", () => {
  it("takes both readings", async () => {
    const run = vi.fn(async (file: string) =>
      file === "memory_pressure" ? PRESSURE_FIXTURE : SWAP_FIXTURE,
    );
    await expect(readMemoryPressure(run)).resolves.toMatchObject({ underPressure: true });
    expect(run.mock.calls).toEqual([
      ["memory_pressure", ["-Q"]],
      ["sysctl", ["vm.swapusage"]],
    ]);
  });

  it("survives a machine where neither tool answers", async () => {
    await expect(readMemoryPressure(async () => null)).resolves.toEqual({
      underPressure: false,
      detail: "memory pressure could not be measured",
    });
  });
});
