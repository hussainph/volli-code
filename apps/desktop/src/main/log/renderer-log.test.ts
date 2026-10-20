// @vitest-environment node
import { installHostLog } from "@volli/host-core/log";
import type { LogRecord } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createRendererLogWriter,
  registerRendererLogForwarding,
  RENDERER_LOG_BUDGET,
} from "./renderer-log";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
let undo: (() => void) | null = null;
afterEach(() => undo?.());

function capture(): LogRecord[] {
  const records: LogRecord[] = [];
  undo = installHostLog({ level: "debug", sink: { write: (record) => records.push(record) } });
  return records;
}

describe("the renderer's lines in main's log", () => {
  it("names each line renderer:<area>, keeps its trace and redacts it", () => {
    const records = capture();
    const write = createRendererLogWriter(() => 0);
    write(
      { id: 7 },
      { level: "warn", area: "console", msg: "React warned", fields: { token: "abc" } },
    );
    write(
      { id: 7 },
      { level: "info", area: "host-link", msg: "state", fields: { to: "ready" }, traceId: TRACE },
    );
    write({ id: 7 }, { level: "shout", area: "console", msg: "malformed" });
    expect(
      records.map(({ component, level, msg, traceId, window, token }) => ({
        component,
        level,
        msg,
        traceId,
        window,
        token,
      })),
    ).toEqual([
      {
        component: "renderer:console",
        level: "warn",
        msg: "React warned",
        traceId: undefined,
        window: 7,
        token: "[redacted]",
      },
      {
        component: "renderer:host-link",
        level: "info",
        msg: "state",
        traceId: TRACE,
        window: 7,
        token: undefined,
      },
    ]);
  });

  it("bounds what one window may send, and says how many it dropped", () => {
    const records = capture();
    let now = 0;
    const write = createRendererLogWriter(() => now);
    for (let index = 0; index < RENDERER_LOG_BUDGET.lines + 5; index += 1) {
      write({ id: 1 }, { level: "error", area: "window", msg: `e${index}` });
    }
    // Another window has its own budget.
    write({ id: 2 }, { level: "error", area: "window", msg: "other" });
    expect(records).toHaveLength(RENDERER_LOG_BUDGET.lines + 1);
    now = RENDERER_LOG_BUDGET.windowMs;
    write({ id: 1 }, { level: "error", area: "window", msg: "after" });
    expect(records.slice(-2).map(({ msg, dropped }) => [msg, dropped])).toEqual([
      ["renderer log lines dropped", 5],
      ["after", undefined],
    ]);
  });

  it("listens on its channel", () => {
    const records = capture();
    let listener!: (event: { sender: { id: number } }, entry: unknown) => void;
    registerRendererLogForwarding({ on: (_channel, registered) => (listener = registered) });
    listener({ sender: { id: 3 } }, { level: "error", area: "window", msg: "boom" });
    expect(records).toMatchObject([{ component: "renderer:window", msg: "boom" }]);
  });
});
