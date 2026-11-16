import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExperimentSnapshot } from "@volli/shared";

import { createExperimentsStore, hasVisibleExperiments, isExperimentOn } from "./experiments";

function snapshot(enabled: boolean): ExperimentSnapshot {
  return { cloud: { enabled, source: "storage" } };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("experiments store", () => {
  it("hides experiments until an answer and honors host visibility with older-host compatibility", () => {
    expect(hasVisibleExperiments(null)).toBe(false);
    expect(
      hasVisibleExperiments({ cloud: { enabled: false, source: "default", visible: false } }),
    ).toBe(false);
    expect(hasVisibleExperiments(snapshot(false))).toBe(true);
    expect(
      hasVisibleExperiments({ cloud: { enabled: true, source: "environment", visible: true } }),
    ).toBe(true);
  });
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

  it("retries a failed boot read when Settings asks again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = vi
      .fn<() => Promise<ExperimentSnapshot>>()
      .mockRejectedValueOnce(new Error("bridge down"))
      .mockResolvedValueOnce(snapshot(false));
    const store = createExperimentsStore(read);
    await store.getState().ensure();
    expect(hasVisibleExperiments(store.getState().snapshot)).toBe(false);
    await store.getState().ensure();
    expect(read).toHaveBeenCalledTimes(2);
    expect(hasVisibleExperiments(store.getState().snapshot)).toBe(true);
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
