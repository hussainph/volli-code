// @vitest-environment node
import { installHostLog } from "@volli/host-core/log";
import type { LogRecord, RendererStall } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  registerRendererStallForwarding,
  RENDERER_STALL_BUDGET,
  startRendererStallLog,
} from "./renderer-stall";

let undo: (() => void) | null = null;
afterEach(() => undo?.());

function capture(): LogRecord[] {
  const records: LogRecord[] = [];
  undo = installHostLog({ level: "debug", sink: { write: (record) => records.push(record) } });
  return records;
}

/** Drives the roll-up by hand: the test says when an hour has passed. */
function manual() {
  let at = 0;
  let run: (() => void) | null = null;
  let stopped = 0;
  return {
    now: () => at,
    every: (task: () => void) => {
      run = task;
      return () => {
        stopped += 1;
      };
    },
    advance(ms: number) {
      at += ms;
    },
    summarize: () => run?.(),
    stopped: () => stopped,
  };
}

const FRAME: RendererStall = {
  kind: "frame",
  operation: "long-animation-frame",
  label: "pane-switch",
  durationMs: 240,
  blockingMs: 190,
  renderMs: 30,
  styleLayoutMs: 12,
  scripts: 3,
  script: {
    file: "chat-plane.tsx",
    function: "ChatPlaneContent",
    invoker: "user-callback",
    durationMs: 180,
  },
};

const INPUT: RendererStall = {
  kind: "input",
  operation: "keydown",
  label: "draft-typing",
  durationMs: 136,
  inputDelayMs: 40,
  processingMs: 80,
  presentationMs: 16,
};

function fields(record: LogRecord): Record<string, unknown> {
  const { ts: _ts, level: _level, ...rest } = record as unknown as Record<string, unknown>;
  return rest;
}

describe("renderer stalls in main's log", () => {
  it("writes one renderer-stall line per stall, naming the window, label and parts", () => {
    const records = capture();
    const clock = manual();
    const log = startRendererStallLog(clock);
    log.write({ id: 4 }, { stalls: [FRAME, INPUT], dropped: 0 });
    expect(records.map(fields)).toEqual([
      {
        component: "renderer-stall",
        msg: "renderer stall",
        window: 4,
        door: "renderer",
        kind: "frame",
        operation: "long-animation-frame",
        label: "pane-switch",
        durationMs: 240,
        blockingMs: 190,
        renderMs: 30,
        styleLayoutMs: 12,
        scripts: 3,
        scriptFile: "chat-plane.tsx",
        scriptFunction: "ChatPlaneContent",
        scriptInvoker: "user-callback",
        scriptMs: 180,
      },
      {
        component: "renderer-stall",
        msg: "renderer stall",
        window: 4,
        door: "renderer",
        kind: "input",
        operation: "keydown",
        label: "draft-typing",
        durationMs: 136,
        inputDelayMs: 40,
        processingMs: 80,
        presentationMs: 16,
      },
    ]);
    expect(records.every((record) => record.level === "warn")).toBe(true);
  });

  it("writes a bare frame with only what it has", () => {
    const records = capture();
    const log = startRendererStallLog(manual());
    log.write(
      { id: 1 },
      {
        stalls: [
          { kind: "frame", operation: "longtask", label: "idle", durationMs: 120 },
          { ...FRAME, script: { file: "no-url", invoker: "other", durationMs: 100 } },
        ],
        dropped: 0,
      },
    );
    expect(fields(records[0]!)).toEqual({
      component: "renderer-stall",
      msg: "renderer stall",
      window: 1,
      door: "renderer",
      kind: "frame",
      operation: "longtask",
      label: "idle",
      durationMs: 120,
    });
    expect(records[1]).not.toHaveProperty("scriptFunction");
    expect(records[1]).toMatchObject({ scriptFile: "no-url" });
  });

  it("drops what is not a batch, and a stall outside the vocabulary", () => {
    const records = capture();
    const log = startRendererStallLog(manual());
    log.write({ id: 1 }, "not a batch");
    log.write({ id: 1 }, { stalls: [{ ...INPUT, label: "typing hunter2" }], dropped: 0 });
    expect(records).toEqual([]);
  });

  it("budgets each window, and says how many it dropped when the window turns", () => {
    const records = capture();
    const clock = manual();
    const log = startRendererStallLog(clock);
    const batch = { stalls: Array.from({ length: 30 }, () => INPUT), dropped: 0 };
    for (let index = 0; index < 5; index += 1) log.write({ id: 2 }, batch);
    // Another window has its own budget.
    log.write({ id: 3 }, { stalls: [INPUT], dropped: 0 });
    expect(records.filter((record) => record.msg === "renderer stall")).toHaveLength(
      RENDERER_STALL_BUDGET.stalls + 1,
    );
    clock.advance(RENDERER_STALL_BUDGET.windowMs);
    log.write({ id: 2 }, { stalls: [INPUT], dropped: 2 });
    const dropped = records.find((record) => record.msg === "renderer stalls dropped");
    expect(dropped).toMatchObject({ level: "warn", window: 2, dropped: 150 - 120 });
    clock.advance(RENDERER_STALL_BUDGET.windowMs);
    log.write({ id: 2 }, { stalls: [], dropped: 0 });
    expect(records.findLast((record) => record.msg === "renderer stalls dropped")).toMatchObject({
      dropped: 2,
    });
  });

  it("rolls the hour up beside main's: counts, labels, scripts, dropped", () => {
    const records = capture();
    const clock = manual();
    const log = startRendererStallLog(clock);
    log.write({ id: 1 }, { stalls: [FRAME, FRAME, INPUT], dropped: 4 });
    log.write(
      { id: 2 },
      {
        stalls: [
          {
            ...FRAME,
            durationMs: 400,
            script: { file: "board.tsx", invoker: "event-listener", durationMs: 350 },
          },
          { kind: "frame", operation: "longtask", label: "idle", durationMs: 120 },
        ],
        dropped: 0,
      },
    );
    clock.advance(3_600_000);
    clock.summarize();
    const load = records.find((record) => record.msg === "renderer stall load");
    expect(load && fields(load)).toEqual({
      component: "renderer-stall",
      msg: "renderer stall load",
      windowMs: 3_600_000,
      stalls: 5,
      frames: 4,
      inputs: 1,
      stallMs: 240 + 240 + 136 + 400 + 120,
      maxStallMs: 400,
      dropped: 4,
      top: [
        {
          label: "pane-switch",
          kind: "frame",
          operation: "long-animation-frame",
          count: 3,
          totalMs: 880,
          maxMs: 400,
        },
        {
          label: "draft-typing",
          kind: "input",
          operation: "keydown",
          count: 1,
          totalMs: 136,
          maxMs: 136,
        },
        { label: "idle", kind: "frame", operation: "longtask", count: 1, totalMs: 120, maxMs: 120 },
      ],
      topScripts: [
        {
          file: "chat-plane.tsx",
          function: "ChatPlaneContent",
          count: 2,
          totalMs: 360,
          maxMs: 180,
        },
        { file: "board.tsx", count: 1, totalMs: 350, maxMs: 350 },
      ],
    });
    // The next window starts empty.
    clock.advance(1000);
    clock.summarize();
    expect(fields(records.at(-1)!)).toMatchObject({
      windowMs: 1000,
      stalls: 0,
      dropped: 0,
      top: [],
    });
  });

  it("stops its roll-up once", () => {
    const clock = manual();
    const log = startRendererStallLog(clock);
    log.stop();
    log.stop();
    expect(clock.stopped()).toBe(1);
  });

  it("rolls up on an unref'd interval by default", () => {
    vi.useFakeTimers();
    try {
      const records = capture();
      const log = startRendererStallLog({ summaryIntervalMs: 1000 });
      vi.advanceTimersByTime(1000);
      expect(records.map((record) => record.msg)).toEqual(["renderer stall load"]);
      log.stop();
      vi.advanceTimersByTime(5000);
      expect(records).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("listens on volli:renderer-stalls and writes for the sender", () => {
    const listeners = new Map<
      string,
      (event: { sender: { id: number } }, batch: unknown) => void
    >();
    const write = vi.fn();
    registerRendererStallForwarding(
      { on: (channel, listener) => listeners.set(channel, listener) },
      { write },
    );
    listeners.get("volli:renderer-stalls")?.({ sender: { id: 9 } }, { stalls: [] });
    expect(write).toHaveBeenCalledWith({ id: 9 }, { stalls: [] });
  });
});
