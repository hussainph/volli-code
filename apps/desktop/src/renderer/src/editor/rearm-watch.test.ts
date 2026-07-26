import { describe, expect, it, vi } from "vite-plus/test";
import type { Result } from "@volli/shared";

import { rearmWatch } from "./rearm-watch";

const input = { projectId: "project-1", ticketId: null, relPath: "src/app.ts" };

describe("rearmWatch", () => {
  it("releases the stale hold before re-arming, and reports the re-arm", async () => {
    const order: string[] = [];
    const unwatch = vi.fn(async () => {
      order.push("unwatch");
      return { ok: true } as const;
    });
    const watch = vi.fn(async () => {
      order.push("watch");
      return { ok: true } as const;
    });

    await expect(rearmWatch({ watch, unwatch }, input)).resolves.toEqual({ ok: true });
    // Re-arming first would leave main's refCount one too high for the tab.
    expect(order).toEqual(["unwatch", "watch"]);
    expect(unwatch).toHaveBeenCalledWith(input);
    expect(watch).toHaveBeenCalledWith(input);
  });

  it("re-arms even when releasing the dead hold fails", async () => {
    // Main already dropped the subscription, so `unwatch` may well reject —
    // that failure is not separately actionable and must not swallow the re-arm.
    const unwatch = vi.fn(() => Promise.reject(new Error("no such subscription")));
    const watch = vi.fn(async () => ({ ok: true }) as const);

    await expect(rearmWatch({ watch, unwatch }, input)).resolves.toEqual({ ok: true });
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("reports a failed and a rejected re-arm as the same typed failure", async () => {
    const unwatch = vi.fn(async () => ({ ok: true }) as const);
    const watch = vi
      .fn<(request: typeof input) => Promise<Result>>()
      .mockResolvedValueOnce({ ok: false, error: "Unknown project" })
      .mockRejectedValueOnce(new Error("EMFILE"));

    await expect(rearmWatch({ watch, unwatch }, input)).resolves.toEqual({
      ok: false,
      error: "Unknown project",
    });
    await expect(rearmWatch({ watch, unwatch }, input)).resolves.toEqual({
      ok: false,
      error: "EMFILE",
    });
  });
});
