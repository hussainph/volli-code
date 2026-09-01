/** Renderer projection and Cancel wiring for main-owned armed countdowns. */
import type { PendingArmedRun } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  cancelArmedRun,
  receivePendingArmedRuns,
  resetArmedRuns,
  useArmedRunStore,
} from "./armed-run";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}));

function pending(overrides: Partial<PendingArmedRun> = {}): PendingArmedRun {
  return {
    id: "arrival-1",
    ticketId: "t1",
    projectId: "p1",
    ticketDisplayId: "VC-12",
    automationId: "a1",
    automationName: "Review sweep",
    status: "doing",
    origin: "armed",
    openedAt: 1_000,
    startAt: 4_500,
    ...overrides,
  };
}

let cancel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cancel = vi.fn(async () => ({ ok: true, cancelled: true }));
  vi.stubGlobal("window", {
    api: { automations: { cancelPendingArmedRun: cancel } },
  });
});

afterEach(() => {
  resetArmedRuns();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("main-owned armed Run projection", () => {
  it("replaces local state from the whole canonical snapshot", () => {
    const first = pending();
    const second = pending({ id: "arrival-2", ticketId: "t2", ticketDisplayId: "VC-13" });

    receivePendingArmedRuns([first, second]);
    expect(useArmedRunStore.getState().pending).toEqual({
      "arrival-1": first,
      "arrival-2": second,
    });

    receivePendingArmedRuns([second]);
    expect(useArmedRunStore.getState().pending).toEqual({ "arrival-2": second });
  });

  it("sends Cancel for the exact arrival and waits for main's shared snapshot", async () => {
    const row = pending();
    receivePendingArmedRuns([row]);

    await cancelArmedRun(row.id);

    expect(cancel).toHaveBeenCalledWith({ id: "arrival-1" });
    // Main broadcasts the removal to every renderer; this client does not
    // invent a private cancelled state ahead of the shared truth.
    expect(useArmedRunStore.getState().pending).toEqual({ "arrival-1": row });
  });
});
