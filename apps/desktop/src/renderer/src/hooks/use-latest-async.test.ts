import { describe, expect, it } from "vite-plus/test";

import { createLatestAsyncGuard } from "./use-latest-async";

describe("createLatestAsyncGuard", () => {
  it("keeps only the newest claim current, so an earlier fetch's late resolve drops itself", () => {
    const guard = createLatestAsyncGuard();

    const first = guard.claim();
    expect(guard.isCurrent(first)).toBe(true);

    const second = guard.claim();
    expect(guard.isCurrent(second)).toBe(true);
    expect(guard.isCurrent(first)).toBe(false); // superseded by the later claim
  });

  it("invalidate retires the outstanding token until the next claim", () => {
    const guard = createLatestAsyncGuard();

    const token = guard.claim();
    expect(guard.isCurrent(token)).toBe(true);

    guard.invalidate();
    expect(guard.isCurrent(token)).toBe(false); // cleanup ran — the in-flight result is stale

    const next = guard.claim();
    expect(guard.isCurrent(next)).toBe(true);
  });
});
