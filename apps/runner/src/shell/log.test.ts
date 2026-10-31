import { describe, expect, it, vi } from "vite-plus/test";

import { EXAMPLE } from "../testing/identity";
import { installProcessLog, logLevelFrom, routeConsole, type ShellLogger } from "./log";

type LogFn = ShellLogger["info"];

describe("the process log", () => {
  it("writes the daemon's lines as JSON, under its component, and keeps them in the ring", () => {
    const lines: string[] = [];
    const { logger, ring } = installProcessLog(EXAMPLE, "info", (line) => lines.push(line));
    logger.debug("hidden");
    logger.info("starting", { pid: 7 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("}\n")).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "info",
      component: "example",
      msg: "starting",
      pid: 7,
    });
    expect(ring.size().lines).toBe(1);
  });

  it("reads a known level and falls back to info", () => {
    expect(logLevelFrom("debug")).toBe("debug");
    expect(logLevelFrom("loud")).toBe("info");
  });
});

describe("routing console", () => {
  it("sends every console method through the logger", () => {
    const logger = {
      debug: vi.fn<LogFn>(),
      info: vi.fn<LogFn>(),
      warn: vi.fn<LogFn>(),
      error: vi.fn<LogFn>(),
    };
    const target = { ...console };
    routeConsole(logger, target);
    target.debug("a %d", 1);
    target.log("b");
    target.info("c", { n: 2 });
    target.warn("d");
    target.error("[volli] failed:", "e");
    const source = { source: "console" };
    expect(logger.debug.mock.calls).toEqual([["a 1", source]]);
    expect(logger.info.mock.calls).toEqual([
      ["b", source],
      ["c { n: 2 }", source],
    ]);
    expect(logger.warn.mock.calls).toEqual([["d", source]]);
    expect(logger.error.mock.calls).toEqual([["[volli] failed: e", source]]);
  });

  it("routes the global console by default", () => {
    const logger = {
      debug: vi.fn<LogFn>(),
      info: vi.fn<LogFn>(),
      warn: vi.fn<LogFn>(),
      error: vi.fn<LogFn>(),
    };
    const saved = { ...console };
    try {
      routeConsole(logger);
      console.info("through");
    } finally {
      Object.assign(console, saved);
    }
    expect(logger.info).toHaveBeenCalledWith("through", { source: "console" });
  });
});
