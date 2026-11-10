import { installHostLog, logContext, startMainStallMonitor } from "@volli/host-core/log";
import type { LogRecord } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { handlers, listeners, windows } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, (...args: never[]) => void>(),
  windows: [] as unknown[],
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => windows },
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
    on(channel: string, listener: (...args: never[]) => void) {
      listeners.set(channel, listener);
    },
  },
}));

import type { WebContents } from "electron";
import { broadcastSessionActivity } from "./broadcast";
import { clientEventSink } from "./client-event-sink";
import { handleRawIpc, onRawIpc } from "./raw-ipc";

/** Holds the event loop for `ms`, as a slow synchronous handler would. */
function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Busy: nothing else in this process runs until it returns.
  }
}

const event = { sender: {} };
let records: LogRecord[] = [];
let undoLog: () => void = () => {};

beforeEach(() => {
  records = [];
  handlers.clear();
  listeners.clear();
  undoLog = installHostLog({ level: "info", sink: { write: (record) => records.push(record) } });
});

afterEach(() => undoLog());

const stalls = () => records.filter((record) => record.msg === "main stall");

describe("the raw IPC door (VC-1090)", () => {
  it("passes an invoke's event, arguments and result through unchanged, inside its own trace", async () => {
    handleRawIpc("volli:sync-project-roots", (sender, first: unknown, second: unknown) => ({
      sender,
      args: [first, second],
      context: logContext(),
    }));
    const result = handlers.get("volli:sync-project-roots")!(...([event, "a", 2] as never[]));
    expect(result).toEqual({
      sender: event,
      args: ["a", 2],
      context: expect.objectContaining({
        door: "ipc",
        operation: "volli:sync-project-roots",
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
    });
    handleRawIpc("volli:list-directory", async () => "listed");
    await expect(handlers.get("volli:list-directory")!(...([event] as never[]))).resolves.toBe(
      "listed",
    );
  });

  it("writes an attributed stall line for an invoke or a send that blocks past the threshold", () => {
    const monitor = startMainStallMonitor({ thresholdMs: 30 });
    try {
      const seen: unknown[] = [];
      handleRawIpc("volli:terminal-write", () => block(40));
      onRawIpc("volli:terminal-ack", (_sender, ...args: unknown[]) => {
        seen.push(args);
        block(40);
      });
      onRawIpc("volli:terminal-set-visible", () => block(1));
      handlers.get("volli:terminal-write")!(...([event] as never[]));
      listeners.get("volli:terminal-ack")!(...([event, "s-1", 10] as never[]));
      listeners.get("volli:terminal-set-visible")!(...([event] as never[]));
      expect(seen).toEqual([["s-1", 10]]);
    } finally {
      monitor.stop();
    }
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "door",
        door: "ipc",
        operation: "volli:terminal-write",
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
      expect.objectContaining({
        attribution: "span",
        door: "ipc",
        operation: "volli:terminal-ack",
      }),
    ]);
  });
});

describe("the fan-out to windows (VC-1090)", () => {
  /** A WebContents whose `send` serializes slowly, as a large payload would. */
  const slowContents = () => ({
    id: 7,
    isDestroyed: () => false,
    send: vi.fn(() => block(40)),
  });

  it("times a broadcast to every window and one client's stream as broadcast spans", () => {
    const contents = slowContents();
    windows.splice(0, windows.length, { webContents: contents });
    const monitor = startMainStallMonitor({ thresholdMs: 30 });
    try {
      broadcastSessionActivity({ sessionId: "s-1" } as never);
      clientEventSink(contents as unknown as WebContents).publish("terminal-data", {
        sessionId: "t",
      } as never);
    } finally {
      monitor.stop();
      windows.length = 0;
    }
    expect(contents.send.mock.calls).toEqual([
      ["volli:session-activity", { sessionId: "s-1" }],
      ["volli:terminal-data", { sessionId: "t" }],
    ]);
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "span",
        door: "broadcast",
        operation: "volli:session-activity",
      }),
      expect.objectContaining({
        attribution: "span",
        door: "broadcast",
        operation: "volli:terminal-data",
      }),
    ]);
  });
});
