import type { HostLinkLogEvent } from "@volli/host-protocol/client-link";
import type { RendererLogEntry } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { consoleEntry, installRendererLogForwarding, rendererLog } from "./renderer-log";

describe("the renderer's lines for main's log", () => {
  it("sends a feature's lines with its area and trace, and never throws", () => {
    const sent: RendererLogEntry[] = [];
    const log = rendererLog("host-link", () => ({ write: (entry) => sent.push(entry) }));
    log.info("state", { to: "ready" }, "4bf92f3577b34da6a3ce929d0e0e4736");
    log.debug("plain");
    expect(sent).toEqual([
      {
        level: "info",
        area: "host-link",
        msg: "state",
        fields: { to: "ready" },
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      },
      { level: "debug", area: "host-link", msg: "plain" },
    ]);
    expect(() =>
      rendererLog("x", () => ({
        write: () => {
          throw new Error("gone");
        },
      })).error("e"),
    ).not.toThrow();
    expect(() => rendererLog("x", () => null).warn("no door")).not.toThrow();
    // Outside Electron there is no preload door, and nothing is sent.
    expect(() => rendererLog("x").warn("no window api")).not.toThrow();
  });

  it("takes a console call's message and an error's summary, never its other arguments", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(consoleEntry(["a %s", 1, { b: 2 }, new TypeError("bad"), undefined, cyclic])).toEqual({
      msg: "a %s",
      fields: { args: 5, error: { name: "TypeError" } },
    });
    expect(consoleEntry([{ token: "opaque" }])).toEqual({
      msg: "console message",
      fields: { args: 1 },
    });
    expect(consoleEntry([new RangeError("private")])).toEqual({
      msg: "console error object",
      fields: { args: 1, error: { name: "RangeError" } },
    });
    // A message known to quote a file is not forwarded at all.
    expect(consoleEntry(["Time limit reached when tokenizing line: const secret = 1"])).toBeNull();
  });

  it("forwards console warnings and errors, uncaught errors and rejections, and undoes it", () => {
    const sent: RendererLogEntry[] = [];
    const printed: unknown[][] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const target = {
      console: {
        warn: (...args: unknown[]) => printed.push(args),
        error: (...args: unknown[]) => printed.push(args),
      },
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
      removeEventListener: vi.fn(),
    };
    const undo = installRendererLogForwarding(target as never, () => ({
      write: (entry) => sent.push(entry),
    }));
    target.console.warn("careful", 2);
    target.console.error(new Error("broke"));
    listeners.get("error")!({
      message: "boom",
      error: new Error("boom"),
      filename: "app.js",
      lineno: 3,
    });
    listeners.get("error")!({ message: "script", error: null, filename: "", lineno: 0 });
    listeners.get("unhandledrejection")!({ reason: new Error("lost") });
    expect(printed).toHaveLength(2);
    expect(sent.map(({ level, area, msg }) => [level, area, msg])).toEqual([
      ["warn", "console", "careful"],
      ["error", "console", "console error object"],
      ["error", "window", "uncaught error"],
      ["error", "window", "uncaught error"],
      ["error", "window", "unhandled rejection"],
    ]);
    expect(sent[0]!.fields).toEqual({ args: 1 });
    expect(sent[2]!.fields).toEqual({ error: { name: "Error" }, source: "app.js", line: 3 });
    expect(sent[3]!.fields).toEqual({ error: { name: "object" }, source: "", line: 0 });
    expect(sent[4]!.fields).toEqual({ reason: { name: "Error" } });
    expect(JSON.stringify(sent)).not.toMatch(/broke|boom|lost/u);
    undo();
    expect(target.removeEventListener).toHaveBeenCalledTimes(2);
    target.console.warn("after");
    expect(sent).toHaveLength(5);
  });
});

describe("a host link's lines", () => {
  it("names each state change, wake and resnapshot, warning on trouble, under the link's trace", async () => {
    const { hostLinkLog } = await import("./renderer-log");
    const sent: RendererLogEntry[] = [];
    const log = hostLinkLog("box", () => ({ write: (entry) => sent.push(entry) }));
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    log({ kind: "state", from: "connecting", to: "ready", traceId });
    log({ kind: "state", from: "ready", to: "unreachable", reason: "host-unreachable", traceId });
    log({ kind: "wake", cause: "power-resume", status: "ready", traceId });
    log({ kind: "resnapshot", path: "session.subscribe", traceId });
    expect(sent.map(({ level, area, msg, traceId: trace }) => [level, area, msg, trace])).toEqual([
      ["info", "host-link", "link state", traceId],
      ["warn", "host-link", "link state", traceId],
      ["info", "host-link", "wake", traceId],
      ["warn", "host-link", "resnapshot", traceId],
    ]);
    // The link's own event type is what it takes.
    const typed: (event: HostLinkLogEvent) => void = log;
    expect(typed).toBe(log);
    expect(sent[1]!.fields).toEqual({
      host: "box",
      from: "ready",
      to: "unreachable",
      reason: "host-unreachable",
    });
  });
});
