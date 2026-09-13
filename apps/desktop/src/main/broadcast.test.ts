import type { PendingArmedRun } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { windows } = vi.hoisted(() => ({ windows: [] as unknown[] }));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => windows },
}));

import {
  broadcastDataChanged,
  broadcastPendingArmedRuns,
  DATA_CHANGED_BATCH_WINDOW_MS,
} from "./broadcast";

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

  it("widens conflicting scopes and keeps the worktree venue invalidation", () => {
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

  it("never narrows a batch after an untargeted invalidation", () => {
    const window = windowFixture();
    windows.push(window);

    broadcastDataChanged();
    broadcastDataChanged({ ticketId: "ticket-1", projectId: "project-1", kind: "ticket" });
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);

    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith("volli:data-changed", {
      entity: "tickets",
    });
  });

  it("starts a fresh coalescing window after each flush", () => {
    const window = windowFixture();
    windows.push(window);

    broadcastDataChanged({ kind: "ticket" });
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);
    broadcastDataChanged({ kind: "comment" });
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);

    expect(window.webContents.send).toHaveBeenNthCalledWith(1, "volli:data-changed", {
      entity: "tickets",
      kind: "ticket",
    });
    expect(window.webContents.send).toHaveBeenNthCalledWith(2, "volli:data-changed", {
      entity: "tickets",
      kind: "comment",
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
