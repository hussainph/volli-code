import { describe, expect, it } from "vite-plus/test";

import { createJsonLogger, logLevelFrom, routeConsole } from "./log";

const AT = new Date("2026-10-04T12:00:00.000Z");

function capture(level: Parameters<typeof createJsonLogger>[0]["level"]) {
  const lines: string[] = [];
  const logger = createJsonLogger({ level, write: (line) => lines.push(line), now: () => AT });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, parsed };
}

describe("the JSON line logger", () => {
  it("writes one JSON object per line with ts, level and msg", () => {
    const { logger, lines, parsed } = capture("debug");
    logger.debug("d");
    logger.info("i", { socketPath: "/s" });
    logger.warn("w");
    logger.error("e");
    expect(lines.every((line) => line.endsWith("}\n") && !line.slice(0, -1).includes("\n"))).toBe(
      true,
    );
    expect(parsed()).toEqual([
      { ts: AT.toISOString(), level: "debug", component: "hostd", msg: "d" },
      { socketPath: "/s", ts: AT.toISOString(), level: "info", component: "hostd", msg: "i" },
      { ts: AT.toISOString(), level: "warn", component: "hostd", msg: "w" },
      { ts: AT.toISOString(), level: "error", component: "hostd", msg: "e" },
    ]);
  });

  it("drops lines below its level", () => {
    const { logger, parsed } = capture("warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    expect(parsed().map((line) => line["msg"])).toEqual(["w"]);
  });

  it("never lets a field forge ts, level or msg", () => {
    const { logger, parsed } = capture("info");
    logger.info("real", { msg: "forged", level: "error", ts: "then" });
    expect(parsed()[0]).toEqual({
      ts: AT.toISOString(),
      level: "info",
      component: "hostd",
      msg: "real",
    });
  });

  it("serialises errors by name and message, and bigints as strings", () => {
    const { logger, parsed } = capture("info");
    logger.error("failed", { error: new TypeError("bad"), size: 10n });
    expect(parsed()[0]).toMatchObject({
      error: { name: "TypeError", message: "bad" },
      size: "10",
    });
  });

  it("uses the clock when none is given", () => {
    const lines: string[] = [];
    createJsonLogger({ level: "info", write: (line) => lines.push(line) }).info("now");
    const ts = (JSON.parse(lines[0]!) as { ts: string }).ts;
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
  });
});

describe("the log level", () => {
  it("reads a known level and falls back to info", () => {
    expect(logLevelFrom("debug")).toBe("debug");
    expect(logLevelFrom("error")).toBe("error");
    expect(logLevelFrom(undefined)).toBe("info");
    expect(logLevelFrom("loud")).toBe("info");
  });
});

describe("routing console", () => {
  it("sends every console method through the logger as JSON", () => {
    const { logger, parsed } = capture("debug");
    const target = { ...console };
    routeConsole(logger, target);
    target.debug("a %d", 1);
    target.log("b");
    target.info("c", { n: 2 });
    target.warn("d");
    target.error("[volli] failed:", "e");
    expect(parsed().map(({ level, msg, source }) => ({ level, msg, source }))).toEqual([
      { level: "debug", msg: "a 1", source: "console" },
      { level: "info", msg: "b", source: "console" },
      { level: "info", msg: "c { n: 2 }", source: "console" },
      { level: "warn", msg: "d", source: "console" },
      { level: "error", msg: "[volli] failed: e", source: "console" },
    ]);
  });
});
