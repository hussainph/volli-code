import { describe, expect, it } from "vite-plus/test";
import { ALWAYS_ONLINE } from "./connectivity";

describe("ALWAYS_ONLINE", () => {
  it("is a host that is never offline and never sleeps", async () => {
    expect(ALWAYS_ONLINE.isOnline()).toBe(true);
    await expect(ALWAYS_ONLINE.waitUntilOnline(new AbortController().signal)).resolves.toBe(
      undefined,
    );
    const unsubscribe = ALWAYS_ONLINE.onResume(() => {
      throw new Error("a host that never sleeps never wakes");
    });
    expect(unsubscribe()).toBe(undefined);
  });
});
