import type { RendererLogEntry } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { consoleText, installRendererLogForwarding, rendererLog } from "./renderer-log";

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

  it("writes console arguments as one line", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(consoleText(["a", 1, { b: 2 }, new TypeError("bad"), undefined, cyclic])).toBe(
      'a 1 {"b":2} TypeError: bad undefined [object Object]',
    );
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
      ["warn", "console", "careful 2"],
      ["error", "console", "Error: broke"],
      ["error", "window", "boom"],
      ["error", "window", "script"],
      ["error", "window", "unhandled rejection"],
    ]);
    expect(sent[4]!.fields).toEqual({ reason: "Error: lost" });
    undo();
    expect(target.removeEventListener).toHaveBeenCalledTimes(2);
    target.console.warn("after");
    expect(sent).toHaveLength(5);
  });
});
