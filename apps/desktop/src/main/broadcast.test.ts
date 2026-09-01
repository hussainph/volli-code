import type { PendingArmedRun } from "@volli/shared";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { windows } = vi.hoisted(() => ({ windows: [] as unknown[] }));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => windows },
}));

import { broadcastPendingArmedRuns } from "./broadcast";

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
