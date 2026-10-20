import { describe, expect, it, vi } from "vite-plus/test";
import type { LogRecord } from "@volli/shared";

import {
  currentTrace,
  logContext,
  mintSpanId,
  mintTraceId,
  withLogContext,
  withTrace,
} from "./context";
import { buildLogRecord, createLogger, MAX_LOG_LINE_BYTES, type LogSink } from "./logger";
import { hostLogger, hostLogLevel, installHostLog } from "./root";
import { consoleSink, jsonLineSink, teeSinks } from "./sinks";

const AT = new Date("2026-10-07T12:00:00.000Z");
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

function capture(level: "debug" | "info" | "warn" | "error" = "debug") {
  const records: LogRecord[] = [];
  const lines: string[] = [];
  const sink: LogSink = {
    write(record, line) {
      records.push(record);
      lines.push(line);
    },
  };
  const logger = createLogger({ level, sink, now: () => AT, component: "test" });
  return { logger, records, lines, sink };
}

describe("the logger", () => {
  it("writes ts, level, component and msg first, then the fields, as one JSON line", () => {
    const { logger, lines, records } = capture();
    logger.info("connected", { connection: "c-1", streams: 2 });
    expect(lines).toEqual([
      '{"ts":"2026-10-07T12:00:00.000Z","level":"info","component":"test","msg":"connected","connection":"c-1","streams":2}',
    ]);
    expect(JSON.parse(lines[0]!)).toEqual(records[0]);
  });

  it("checks the level before it builds anything", () => {
    const { logger, records } = capture("warn");
    const fields = {
      get expensive(): number {
        throw new Error("built a line below the level");
      },
    };
    logger.debug("d", fields);
    logger.info("i", fields);
    logger.warn("w");
    logger.error("e");
    expect(records.map((record) => record.level)).toEqual(["warn", "error"]);
    expect(logger.enabled("info")).toBe(false);
    expect(logger.enabled("error")).toBe(true);
  });

  it("never lets a field forge the named keys", () => {
    const { logger, records } = capture();
    logger.info("real", { ts: "then", level: "error", msg: "forged", component: "other" });
    expect(records[0]).toEqual({
      ts: AT.toISOString(),
      level: "info",
      component: "test",
      msg: "real",
    });
  });

  it("layers the ambient context, the child's fields and the call's, a later one winning", () => {
    const { logger, records } = capture();
    const child = logger.child({ component: "door", connection: "c-1", sessionId: "child" });
    expect(child.component).toBe("door");
    withLogContext({ traceId: TRACE, sessionId: "ambient" }, () => {
      child.info("call", { turnId: "t-1" });
      child.child({ commandId: "cmd-1" }).warn("deeper", { sessionId: "call" });
    });
    expect(records).toEqual([
      {
        ts: AT.toISOString(),
        level: "info",
        component: "door",
        msg: "call",
        traceId: TRACE,
        sessionId: "child",
        connection: "c-1",
        turnId: "t-1",
      },
      {
        ts: AT.toISOString(),
        level: "warn",
        component: "door",
        msg: "deeper",
        traceId: TRACE,
        sessionId: "call",
        connection: "c-1",
        commandId: "cmd-1",
      },
    ]);
  });

  it("redacts secrets in fields and the message (a merge gate)", () => {
    const { logger, lines } = capture();
    logger.error("auth failed: Authorization: Bearer abc.def.ghi", {
      token: "t0k3n",
      credential: "c",
      headers: { cookie: "sid=1", accept: "json" },
      error: new Error("password=hunter2"),
    });
    const line = lines[0]!;
    for (const secret of ["abc.def.ghi", "t0k3n", "sid=1", "hunter2"])
      expect(line).not.toContain(secret);
    expect(JSON.parse(line)).toMatchObject({ headers: { accept: "json" }, token: "[redacted]" });
  });

  it("cuts a line past its ceiling to what correlates it", () => {
    const { logger, records, lines } = capture();
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`f${index}`, "y".repeat(1_900)]),
    );
    withLogContext({ traceId: TRACE, sessionId: "s-1" }, () => logger.info("big", many));
    expect(records[0]).toEqual({
      ts: AT.toISOString(),
      level: "info",
      component: "test",
      msg: "big",
      traceId: TRACE,
      sessionId: "s-1",
      truncated: true,
      bytes: expect.any(Number),
    });
    expect((records[0]!["bytes"] as number) > MAX_LOG_LINE_BYTES).toBe(true);
    expect(lines[0]!.length).toBeLessThan(1_000);
    // A line long enough to count, but under the byte bound, is kept whole.
    logger.info("wide", {
      a: "z".repeat(1_900),
      b: "z".repeat(1_900),
      c: "z".repeat(1_900),
      d: "z".repeat(1_900),
    });
    expect(records[1]!["truncated"]).toBeUndefined();
  });

  it("uses the wall clock when the root names none", () => {
    const records: LogRecord[] = [];
    createLogger({
      level: "info",
      sink: { write: (record) => records.push(record) },
      component: "c",
    }).info("now");
    expect(Number.isNaN(Date.parse(records[0]!.ts))).toBe(false);
  });

  it("builds a record from layers without a logger", () => {
    expect(
      buildLogRecord({
        level: "debug",
        msg: "m",
        component: "c",
        now: AT,
        fields: [{ a: 1 }, { a: 2, b: undefined }],
      }),
    ).toEqual({ ts: AT.toISOString(), level: "debug", component: "c", msg: "m", a: 2 });
  });
});

describe("the correlation context", () => {
  it("is empty outside any operation", () => {
    expect(logContext()).toEqual({});
    expect(currentTrace()).toBeNull();
  });

  it("follows the operation across awaits and timers", async () => {
    const seen = await withLogContext({ traceId: TRACE, spanId: SPAN }, async () => {
      await Promise.resolve();
      return new Promise((resolve) => setTimeout(() => resolve(currentTrace()), 1));
    });
    expect(seen).toEqual({ traceId: TRACE, spanId: SPAN });
    expect(logContext()).toEqual({});
  });

  it("mints W3C-shaped ids", () => {
    expect(mintTraceId()).toMatch(/^[0-9a-f]{32}$/u);
    expect(mintSpanId()).toMatch(/^[0-9a-f]{16}$/u);
    expect(mintTraceId()).not.toBe(mintTraceId());
  });

  it("opens a door with the peer's trace, the running one, or a fresh one", () => {
    const sent = withTrace({ traceId: TRACE, spanId: SPAN }, { door: "websocket" }, () =>
      logContext(),
    );
    expect(sent).toEqual({ traceId: TRACE, spanId: SPAN, door: "websocket" });

    const nested = withTrace({ traceId: TRACE, spanId: SPAN }, {}, () =>
      withTrace(undefined, { door: "ipc" }, () => logContext()),
    );
    expect(nested["traceId"]).toBe(TRACE);
    expect(nested["spanId"]).not.toBe(SPAN);
    expect(nested["door"]).toBe("ipc");

    const fresh = withTrace({ traceId: "not-a-trace", spanId: SPAN }, {}, () => currentTrace());
    expect(fresh?.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(fresh?.traceId).not.toBe(TRACE);
  });
});

describe("the installed root", () => {
  it("routes every module logger to what the host installed, and undoes it", () => {
    const records: LogRecord[] = [];
    const module = hostLogger("pty", { area: "terminal" });
    const undo = installHostLog({
      level: "debug",
      sink: { write: (record) => records.push(record) },
      now: () => AT,
    });
    expect(hostLogLevel()).toBe("debug");
    module.debug("spawned", { pid: 1 });
    expect(records).toEqual([
      {
        ts: AT.toISOString(),
        level: "debug",
        component: "pty",
        msg: "spawned",
        area: "terminal",
        pid: 1,
      },
    ]);
    undo();
    expect(hostLogLevel()).toBe("warn");
  });

  it("keeps a newer install when an older one is undone", () => {
    const first = installHostLog({ level: "warn", sink: { write: () => undefined } });
    const second = installHostLog({ level: "error", sink: { write: () => undefined } });
    first();
    expect(hostLogLevel()).toBe("error");
    second();
    first();
    expect(hostLogLevel()).toBe("warn");
  });

  it("writes warnings to the console until a host installs a root", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    hostLogger("boot").info("ready");
    hostLogger("boot").warn("slow");
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[boot] slow");
    warn.mockRestore();
    info.mockRestore();
  });
});

describe("the sinks", () => {
  it("writes newline-terminated JSON lines and survives a closed stream", () => {
    const out: string[] = [];
    const record = buildLogRecord({ level: "info", msg: "m", component: "c", now: AT, fields: [] });
    jsonLineSink((line) => out.push(line)).write(record, JSON.stringify(record));
    expect(out).toEqual([`${JSON.stringify(record)}\n`]);
    expect(() =>
      jsonLineSink(() => {
        throw new Error("EPIPE");
      }).write(record, "{}"),
    ).not.toThrow();
  });

  it("tees to every sink even when one throws", () => {
    const seen: string[] = [];
    const tee = teeSinks(
      {
        write: () => {
          throw new Error("full");
        },
      },
      { write: (_record, line) => seen.push(line) },
    );
    const record = buildLogRecord({ level: "info", msg: "m", component: "c", now: AT, fields: [] });
    tee.write(record, "line");
    expect(seen).toEqual(["line"]);
  });

  it("prints a readable line on the console, by level", () => {
    const target = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = createLogger({
      level: "debug",
      sink: consoleSink(target),
      component: "git",
      now: () => AT,
    });
    logger.debug("d");
    logger.warn("push failed", { exitCode: 1 });
    logger.error("e");
    logger.info("i");
    expect(target.debug).toHaveBeenCalledWith("[git] d");
    expect(target.warn).toHaveBeenCalledWith("[git] push failed", { exitCode: 1 });
    expect(target.error).toHaveBeenCalledWith("[git] e");
    expect(target.info).toHaveBeenCalledWith("[git] i");
  });
});

describe("the test capture", () => {
  it("collects every host logger's records, by component, and restores", async () => {
    const { captureHostLog } = await import("../testing/log");
    const log = captureHostLog("info");
    hostLogger("pty").info("spawned");
    hostLogger("git").debug("below");
    hostLogger("git").warn("slow");
    expect(log.records.map(({ msg }) => msg)).toEqual(["spawned", "slow"]);
    expect(log.of("git").map(({ msg }) => msg)).toEqual(["slow"]);
    log.restore();
    expect(hostLogLevel()).toBe("warn");
  });
});
