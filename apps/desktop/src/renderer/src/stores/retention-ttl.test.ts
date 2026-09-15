import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createRetentionTtlStore } from "./retention-ttl";

function stubGetTtlDays(impl: () => Promise<unknown>) {
  const read = vi.fn(impl);
  Object.assign(globalThis, { window: { api: { retention: { getTtlDays: read } } } });
  return read;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("ensure", () => {
  it("reads the setting once and caches it", async () => {
    const read = stubGetTtlDays(() => Promise.resolve({ ok: true, days: 14 }));
    const store = createRetentionTtlStore();

    await expect(store.getState().ensure()).resolves.toEqual({ ok: true, days: 14 });
    await expect(store.getState().ensure()).resolves.toEqual({ ok: true, days: 14 });

    // The whole point (VC-373): one read serves every ticket's repository card
    // and the Settings pane.
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.getState().ttlDays).toBe(14);
  });

  it("shares one read between askers that collide on a frame", async () => {
    let release: ((value: unknown) => void) | undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const read = stubGetTtlDays(() => held);
    const store = createRetentionTtlStore();

    const first = store.getState().ensure();
    const second = store.getState().ensure();
    release!({ ok: true, days: 30 });

    await expect(first).resolves.toEqual({ ok: true, days: 30 });
    await expect(second).resolves.toEqual({ ok: true, days: 30 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("leaves the cache empty when main refuses, so the next asker retries", async () => {
    const read = stubGetTtlDays(() => Promise.resolve({ ok: false, error: "db closed" }));
    const store = createRetentionTtlStore();

    await expect(store.getState().ensure()).resolves.toEqual({ ok: false, error: "db closed" });
    expect(store.getState().ttlDays).toBeNull();

    read.mockResolvedValue({ ok: true, days: 7 });
    await expect(store.getState().ensure()).resolves.toEqual({ ok: true, days: 7 });
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.getState().ttlDays).toBe(7);
  });

  it("folds a rejected bridge call onto the same failure shape", async () => {
    stubGetTtlDays(() => Promise.reject(new Error("ipc gone")));
    const store = createRetentionTtlStore();

    await expect(store.getState().ensure()).resolves.toEqual({ ok: false, error: "ipc gone" });
    expect(store.getState().ttlDays).toBeNull();
  });
});

describe("adopt", () => {
  it("records the value a settings write answered with, without a second read", async () => {
    const read = stubGetTtlDays(() => Promise.resolve({ ok: true, days: 14 }));
    const store = createRetentionTtlStore();

    store.getState().adopt(3);

    expect(store.getState().ttlDays).toBe(3);
    await expect(store.getState().ensure()).resolves.toEqual({ ok: true, days: 3 });
    expect(read).not.toHaveBeenCalled();
  });
});
