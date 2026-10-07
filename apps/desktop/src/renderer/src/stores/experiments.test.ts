import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExperimentSnapshot } from "@volli/shared";

import { createExperimentsStore, isExperimentOn } from "./experiments";

function snapshot(enabled: boolean): ExperimentSnapshot {
  return { cloud: { enabled, source: "storage" } };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("experiments store", () => {
  it("reads every flag off until the host answers", () => {
    const store = createExperimentsStore(() => new Promise(() => {}));
    expect(store.getState().snapshot).toBeNull();
    expect(isExperimentOn(store.getState().snapshot, "cloud")).toBe(false);
  });

  it("adopts the host's answer, and shares one read between callers", async () => {
    const read = vi.fn(async () => snapshot(true));
    const store = createExperimentsStore(read);
    await Promise.all([store.getState().ensure(), store.getState().ensure()]);
    await store.getState().ensure();
    expect(read).toHaveBeenCalledTimes(1);
    expect(isExperimentOn(store.getState().snapshot, "cloud")).toBe(true);
  });

  it("keeps a save that landed while the first read was in flight", async () => {
    let answer: ((value: ExperimentSnapshot) => void) | undefined;
    const store = createExperimentsStore(
      () =>
        new Promise<ExperimentSnapshot>((resolve) => {
          answer = resolve;
        }),
    );
    const read = store.getState().ensure();
    store.getState().receive(snapshot(true));
    answer?.(snapshot(false));
    await read;
    expect(isExperimentOn(store.getState().snapshot, "cloud")).toBe(true);
  });

  it("stays off and logs when the read fails — nobody asked for it, so no toast", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createExperimentsStore(async () => {
      throw new Error("bridge down");
    });
    await store.getState().ensure();
    expect(store.getState().snapshot).toBeNull();
    expect(warn).toHaveBeenCalledWith("[volli] Couldn't read experiments:", "bridge down");
  });

  it("reads through the Session RPC client by default", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // No bridge in this environment: the default read fails and stays off.
    vi.stubGlobal("api", {});
    const store = createExperimentsStore();
    await store.getState().ensure();
    expect(store.getState().snapshot).toBeNull();
  });
});
