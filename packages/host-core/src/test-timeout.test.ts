import { describe, expect, it } from "vite-plus/test";

// What this package's config actually hands a test (VC-1233): 15 s on a CI
// runner, so a few-second disk stall cannot fail a test caught in a
// synchronous SQLite or fs call, and Vitest's own 5 s at a desk. Read from the
// running task, so the shard's own run proves the setting took effect.
const ci = process.env["CI"];
const onCi = Boolean(ci) && ci !== "false" && ci !== "0";

describe("host-core's test timeout", () => {
  it(`is ${onCi ? "15 s on a CI runner" : "Vitest's default 5 s off CI"}`, ({ task }) => {
    expect(task.timeout).toBe(onCi ? 15_000 : 5_000);
  });

  it("leaves a test's own shorter bound alone", { timeout: 2_000 }, ({ task }) => {
    expect(task.timeout).toBe(2_000);
  });
});
