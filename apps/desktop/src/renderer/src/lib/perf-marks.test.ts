import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { markPerfPhase, perfPhaseMarksEnabled, PERF_MARKS_FLAG } from "./perf-marks";

afterEach(() => {
  Reflect.deleteProperty(globalThis, PERF_MARKS_FLAG);
});

describe("markPerfPhase", () => {
  it("stamps nothing while the window has not asked to be instrumented", () => {
    const host = { mark: vi.fn() };

    markPerfPhase("volli.ticket-workspace.mount", host);

    expect(perfPhaseMarksEnabled()).toBe(false);
    expect(host.mark).not.toHaveBeenCalled();
  });

  it("stamps the phase once a measuring page has switched marks on", () => {
    const host = { mark: vi.fn() };
    Reflect.set(globalThis, PERF_MARKS_FLAG, true);

    markPerfPhase("volli.ticket-workspace.mount", host);

    expect(perfPhaseMarksEnabled()).toBe(true);
    expect(host.mark).toHaveBeenCalledWith("volli.ticket-workspace.mount");
  });
});
