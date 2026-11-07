import type { LogRecord } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { withTrace } from "../log/context";
import { hostLogger, installHostLog } from "../log/root";
import { teeSinks } from "../log/sinks";
import { startMainStallMonitor, type MainStallMonitor } from "../log/stall";
import { mainStallRow, perfStallSink, rendererStallRow } from "./stall-sink";
import type { PerfStallInput } from "./store";

let clock = 0;
let rows: PerfStallInput[] = [];
let undoLog: () => void = () => {};
const monitors: MainStallMonitor[] = [];

beforeEach(() => {
  clock = 1_000;
  rows = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  undoLog = installHostLog({
    level: "debug",
    sink: teeSinks(perfStallSink({ record: (row) => rows.push(row) })),
  });
});

afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  undoLog();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function record(fields: Record<string, unknown>): LogRecord {
  return {
    ts: "2026-11-01T10:00:00.000Z",
    level: "warn",
    component: "main-stall",
    msg: "main stall",
    ...fields,
  } as LogRecord;
}

describe("the perf store's stall hook", () => {
  it("records the real monitor's door stall with its door, operation and Session", () => {
    const monitor = startMainStallMonitor({ tickMs: 50, thresholdMs: 200 });
    monitors.push(monitor);
    withTrace(null, { door: "ipc", operation: "volli:board-load", sessionId: "session-1" }, () => {
      clock += 300;
    });
    expect(rows).toEqual([
      expect.objectContaining({
        process: "main",
        kind: "door",
        door: "ipc",
        operation: "volli:board-load",
        sessionId: "session-1",
        durationMs: 300,
        hint: null,
      }),
    ]);
    expect(Number.isFinite(rows[0]!.at)).toBe(true);
  });

  it("records the real monitor's unattributed stall under unattributed, with its hint", () => {
    // On the CPU throughout, and no GC: the block stays unattributed (VC-1090).
    const monitor = startMainStallMonitor({
      tickMs: 50,
      thresholdMs: 200,
      threadCpuMs: () => clock,
      observeGc: () => () => {},
    });
    monitors.push(monitor);
    withTrace(null, { door: "socket", operation: "ticket.list" }, () => {
      clock += 1;
    });
    // The door call above ran 1 ms inside this tick, so the lag reads 401.
    clock += 50 + 400;
    vi.advanceTimersByTime(50);
    // Held one tick, for the GC pauses inside it to arrive.
    clock += 50;
    vi.advanceTimersByTime(50);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "unattributed",
        door: "unattributed",
        operation: "unattributed",
        hint: "socket/ticket.list",
        durationMs: 401,
      }),
    ]);
  });

  it("records a renderer stall line with its label and window", () => {
    hostLogger("renderer-stall").warn("renderer stall", {
      window: 2,
      door: "renderer",
      kind: "input",
      operation: "keydown",
      label: "draft-typing",
      durationMs: 240,
      inputDelayMs: 5,
    });
    expect(rows).toEqual([
      expect.objectContaining({
        process: "renderer",
        kind: "input",
        door: "renderer",
        operation: "keydown",
        label: "draft-typing",
        windowId: 2,
        durationMs: 240,
      }),
    ]);
  });

  it("retains flattened renderer-frame timings and top attribution from the log", () => {
    const fields = {
      scriptTotalMs: 140,
      blockingMs: 100,
      renderMs: 90,
      styleLayoutMs: 70,
      scriptFile: "chat-plane.tsx",
      scriptFunction: "ChatPlaneContent",
      scriptInvoker: "user-callback",
      scriptMs: 80,
    };
    hostLogger("renderer-stall").warn("renderer stall", {
      kind: "frame",
      operation: "long-animation-frame",
      label: "pane-switch",
      durationMs: 250,
      ...fields,
    });
    expect(rows).toEqual([expect.objectContaining(fields)]);
  });

  it("does not invent breakdowns on old frame logs or frame fields on inputs or main stalls", () => {
    const fields = {
      scriptTotalMs: 140,
      blockingMs: 100,
      renderMs: 90,
      styleLayoutMs: 70,
      scriptFile: "chat-plane.tsx",
      scriptFunction: "ChatPlaneContent",
      scriptInvoker: "user-callback",
      scriptMs: 80,
    };
    hostLogger("renderer-stall").warn("renderer stall", { kind: "frame", durationMs: 250 });
    hostLogger("renderer-stall").warn("renderer stall", {
      kind: "input",
      durationMs: 250,
      ...fields,
    });
    hostLogger("renderer-stall").warn("renderer stall", {
      kind: "unknown",
      durationMs: 250,
      ...fields,
    });
    hostLogger("main-stall").warn("main stall", { durationMs: 250, ...fields });
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      for (const field of Object.keys(fields)) expect(row).not.toHaveProperty(field);
    }
  });

  it("sanitizes frame attribution and drops invalid optional durations, preserving zero", () => {
    const row = rendererStallRow(
      record({
        kind: "frame",
        durationMs: 250,
        scriptTotalMs: 140.6,
        blockingMs: 0,
        renderMs: Number.POSITIVE_INFINITY,
        styleLayoutMs: "70",
        scriptMs: Number.NaN,
        scriptFile: "file:///Users/private/renderer.js?token=secret#fragment",
        scriptFunction: "private user content",
        scriptInvoker: "private user content",
      }),
    );
    expect(row).toMatchObject({
      scriptTotalMs: 141,
      blockingMs: 0,
      scriptFile: "renderer.js",
      scriptInvoker: "other",
    });
    for (const field of ["renderMs", "styleLayoutMs", "scriptMs", "scriptFunction"]) {
      expect(row).not.toHaveProperty(field);
    }
    expect(
      rendererStallRow(
        record({
          kind: "frame",
          durationMs: 250,
          scriptFile: "unsafe name",
          scriptFunction: "Object.flush",
          scriptInvoker: "event-listener",
          scriptMs: -2,
          renderMs: 1_000_000,
        }),
      ),
    ).toMatchObject({
      scriptFile: "unknown",
      scriptFunction: "Object.flush",
      scriptInvoker: "event-listener",
      scriptMs: 0,
      renderMs: 600_000,
    });
  });

  it("lets every other line pass by, roll-ups included", () => {
    hostLogger("main-stall").info("main stall load", { stalls: 3 });
    hostLogger("renderer-stall").info("renderer stall load", { stalls: 3 });
    hostLogger("ipc").warn("main stall", { durationMs: 900 });
    expect(rows).toEqual([]);
  });

  it("reads a span's own labels and its parent as the hint", () => {
    expect(
      mainStallRow(
        record({
          durationMs: 210,
          attribution: "span",
          door: "runtime",
          operation: "turn",
          parentDoor: "timer",
          parentOperation: "watchdog",
        }),
      ),
    ).toMatchObject({ kind: "span", door: "runtime", operation: "turn", hint: "timer/watchdog" });
  });

  it("files a line missing its labels as unknown, and drops one with no duration or time", () => {
    expect(mainStallRow(record({ durationMs: 210 }))).toMatchObject({
      kind: "unknown",
      door: "unknown",
      operation: "unknown",
      sessionId: null,
      hint: null,
    });
    expect(mainStallRow(record({ durationMs: "210" }))).toBeNull();
    expect(mainStallRow(record({ durationMs: 210, ts: "never" }))).toBeNull();
    expect(
      rendererStallRow(record({ component: "renderer-stall", durationMs: 210 })),
    ).toMatchObject({ kind: "unknown", operation: "unknown", label: null, windowId: null });
    expect(rendererStallRow(record({ durationMs: Number.NaN }))).toBeNull();
    expect(rendererStallRow(record({ durationMs: 210, ts: "never" }))).toBeNull();
  });
});
