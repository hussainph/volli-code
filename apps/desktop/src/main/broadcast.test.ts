import type { PendingArmedRun } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { windows } = vi.hoisted(() => ({ windows: [] as unknown[] }));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => windows },
}));

import type { HostEventMap, HostEventTopic } from "@volli/host-core/ports";
import {
  broadcastDataChanged,
  broadcastPendingArmedRuns,
  broadcastSessionRetitled,
  broadcastSessionsInterrupted,
  broadcastSystemAppearance,
  flushDataChangedForTest,
  windowEventBus,
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

describe("the host event bus over every window (VC-554)", () => {
  // One payload per topic, sent on the channel the topic names. `data-changed`
  // is the one that coalesces, and is covered above.
  const SENT: { [T in Exclude<HostEventTopic, "data-changed">]: HostEventMap[T] } = {
    "session-activity": { projectId: "p", ticketId: null } as HostEventMap["session-activity"],
    "session-retitled": { sessionId: "s", title: "Named" },
    "sessions-interrupted": { ticketId: "t", sessionIds: ["s"] },
    "session-started": { sessionId: "s" } as HostEventMap["session-started"],
    "harness-event": { sessionId: "s" } as HostEventMap["harness-event"],
    "session-harness": { sessionId: "s" } as HostEventMap["session-harness"],
    "pending-armed-runs-changed": [PENDING],
    "pending-armed-run-settled": { kind: "failed", pending: PENDING, error: "no" },
    "worktree-phase": { ticketId: "t", phase: "ready" },
    "file-changed": {
      projectId: "p",
      ticketId: null,
      relPath: "file.md",
      source: "main",
      revision: 1,
    },
    "dir-changed": { projectId: "p", relPath: "" },
  };

  it("sends each topic on its own volli: channel to every live window, at once", () => {
    const live = windowFixture();
    const destroyed = windowFixture(true);
    windows.push(live, destroyed);

    for (const [topic, payload] of Object.entries(SENT)) {
      windowEventBus.publish(topic as keyof typeof SENT, payload as never);
      expect(live.webContents.send).toHaveBeenLastCalledWith(`volli:${topic}`, payload);
    }
    expect(live.webContents.send).toHaveBeenCalledTimes(Object.keys(SENT).length);
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it("coalesces data-changed through the same window as broadcastDataChanged", () => {
    const window = windowFixture();
    windows.push(window);

    windowEventBus.publish("data-changed", { ticketId: "ticket-1" });
    broadcastDataChanged({ ticketId: "ticket-1" });
    expect(window.webContents.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);

    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith("volli:data-changed", {
      entity: "tickets",
      ticketId: "ticket-1",
    });
  });

  it("keeps the desktop spellings' payloads, and sends window-only facts directly", () => {
    const window = windowFixture();
    windows.push(window);

    broadcastSessionRetitled("s", "Named");
    broadcastSessionsInterrupted("t", ["s"]);
    broadcastSystemAppearance(true);

    expect(window.webContents.send.mock.calls).toEqual([
      ["volli:session-retitled", { sessionId: "s", title: "Named" }],
      ["volli:sessions-interrupted", { ticketId: "t", sessionIds: ["s"] }],
      ["volli:system-appearance-changed", true],
    ]);
  });
});
