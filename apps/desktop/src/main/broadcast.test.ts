import type { PendingArmedRun } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { windows } = vi.hoisted(() => ({ windows: [] as unknown[] }));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => windows },
}));

import {
  broadcastDataChanged,
  broadcastPendingArmedRuns,
  flushDataChangedForTest,
} from "./broadcast";
import { DATA_CHANGED_BATCH_WINDOW_MS } from "./data-change-coalescer";

const PENDING: PendingArmedRun = {
  id: "arrival-1",
  ticketId: "ticket-1",
  projectId: "project-1",
  ticketDisplayId: "VC-12",
  automationId: "automation-1",
  automationName: "Review sweep",
  status: "doing",
  origin: "armed",
  openedAt: 1_000,
  startAt: 4_500,
};

function windowFixture(destroyed = false) {
  return {
    webContents: {
      isDestroyed: () => destroyed,
      send: vi.fn(),
    },
  };
}

beforeEach(() => {
  windows.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

/*
 * What lives here is the FAN-OUT: which windows a delivered invalidation
 * reaches and what it says on the wire. The coalescing rule itself — merging,
 * the window, re-entrancy, disposal — is a unit of `data-change-coalescer.ts`
 * and is tested there against a recording sink rather than through Electron.
 */
describe("data change broadcast", () => {
  it("turns a synchronous mutation burst into one re-hydrate per live window", () => {
    const first = windowFixture();
    const second = windowFixture();
    const destroyed = windowFixture(true);
    windows.push(first, second, destroyed);

    for (let mutation = 0; mutation < 15; mutation += 1) {
      broadcastDataChanged({ ticketId: "ticket-1", projectId: "project-1", kind: "ticket" });
    }

    expect(first.webContents.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);

    expect(first.webContents.send).toHaveBeenCalledExactlyOnceWith("volli:data-changed", {
      entity: "tickets",
      ticketId: "ticket-1",
      projectId: "project-1",
      kind: "ticket",
    });
    expect(second.webContents.send).toHaveBeenCalledTimes(1);
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it("stamps the entity discriminant call sites never pass", () => {
    const window = windowFixture();
    windows.push(window);

    broadcastDataChanged();
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);

    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith("volli:data-changed", {
      entity: "tickets",
    });
  });

  it("carries the merged scope, not the first or last call's", () => {
    const window = windowFixture();
    windows.push(window);

    broadcastDataChanged({ ticketId: "ticket-1", projectId: "project-1", kind: "comment" });
    broadcastDataChanged({ ticketId: "ticket-2", projectId: "project-1", kind: "worktree" });
    broadcastDataChanged({ ticketId: "ticket-2", projectId: "project-2", kind: "session" });
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);

    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith("volli:data-changed", {
      entity: "tickets",
      kind: "worktree",
    });
  });

  it("queues nothing anyone can receive when no window is open", () => {
    // Quit, or the moment between windows on macOS. The invalidation is simply
    // dropped: nothing survives that could act on it, and the next window
    // hydrates from SQLite at boot anyway.
    broadcastDataChanged({ kind: "worktree" });
    expect(() => vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS)).not.toThrow();

    const late = windowFixture();
    windows.push(late);
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS * 10);
    expect(late.webContents.send).not.toHaveBeenCalled();
  });

  it("delivers on demand for the tests that assert on an absence", () => {
    const window = windowFixture();
    windows.push(window);

    broadcastDataChanged({ kind: "ticket" });
    flushDataChangedForTest();

    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith("volli:data-changed", {
      entity: "tickets",
      kind: "ticket",
    });
  });
});

describe("pending armed Run broadcast", () => {
  it("sends one identical whole snapshot to both live windows", () => {
    const first = windowFixture();
    const second = windowFixture();
    const destroyed = windowFixture(true);
    windows.push(first, second, destroyed);

    broadcastPendingArmedRuns([PENDING]);

    expect(first.webContents.send).toHaveBeenCalledExactlyOnceWith(
      "volli:pending-armed-runs-changed",
      [PENDING],
    );
    expect(second.webContents.send).toHaveBeenCalledExactlyOnceWith(
      "volli:pending-armed-runs-changed",
      [PENDING],
    );
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });
});
