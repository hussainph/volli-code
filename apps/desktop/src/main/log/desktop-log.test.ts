// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostLogger, withTrace } from "@volli/host-core/log";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  desktopLogDirectory,
  exitAfterLogFlush,
  startDesktopLog,
  type DesktopLog,
} from "./desktop-log";

const TRACE = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };
const dirs: string[] = [];
const logs: DesktopLog[] = [];
afterEach(async () => {
  for (const log of logs.splice(0)) await log.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), "vc699-profile-"));
  dirs.push(dir);
  return dir;
}

describe("the desktop's log", () => {
  it("writes every host logger's lines as JSON under the profile's log directory, traced", async () => {
    const userData = profile();
    const log = startDesktopLog({ userData, dev: false, env: {} });
    logs.push(log);
    expect(log.directory).toBe(desktopLogDirectory(userData));
    expect(log.level).toBe("info");
    withTrace(TRACE, { door: "ipc" }, () =>
      hostLogger("session").info("session turn.started", { sessionId: "s-1", token: "secret" }),
    );
    hostLogger("session").debug("below the level");
    await log.flush();
    const lines = readFileSync(log.file.currentFile()!, "utf8").trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      {
        ts: expect.any(String),
        level: "info",
        component: "session",
        msg: "session turn.started",
        traceId: TRACE.traceId,
        spanId: TRACE.spanId,
        door: "ipc",
        sessionId: "s-1",
        token: "[redacted]",
      },
    ]);
  });

  it("logs every hop in a dev build, to the terminal too, and takes VOLLI_LOG_LEVEL", async () => {
    const terminal = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const seen: string[] = [];
    const dev = startDesktopLog({
      userData: profile(),
      dev: true,
      env: {},
      console: terminal,
      sinks: [{ write: (_record, line) => seen.push(line) }],
    });
    logs.push(dev);
    expect(dev.level).toBe("debug");
    hostLogger("rpc").debug("rpc call", { operation: "session.command" });
    expect(terminal.debug).toHaveBeenCalledWith("[rpc] rpc call", { operation: "session.command" });
    expect(seen).toHaveLength(1);
    await dev.close();
    logs.pop();
    const quiet = startDesktopLog({
      userData: profile(),
      dev: true,
      env: { VOLLI_LOG_LEVEL: "warn" },
    });
    logs.push(quiet);
    expect(quiet.level).toBe("warn");
  });

  it("prints to the terminal in a packaged build when asked (a smoke's captured boot)", async () => {
    const terminal = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const log = startDesktopLog({
      userData: profile(),
      dev: false,
      env: {},
      console: terminal,
      terminal: true,
    });
    logs.push(log);
    hostLogger("desktop").info("harness runtime ready");
    expect(terminal.info).toHaveBeenCalledWith("[desktop] harness runtime ready");
  });

  it("flushes the log before the app exits, within a deadline", async () => {
    const exits: (number | undefined)[] = [];
    const app = {
      name: "volli",
      exit(code?: number) {
        exits.push(code);
      },
      getName() {
        return this.name;
      },
    };
    let release!: () => void;
    const wrapped = exitAfterLogFlush(app, {
      flush: () => new Promise<void>((resolve) => (release = resolve)),
    });
    expect(wrapped.getName()).toBe("volli");
    expect(wrapped.name).toBe("volli");
    wrapped.exit(0);
    await Promise.resolve();
    expect(exits).toEqual([]);
    release();
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });

  it("stops waiting on a disk that never answers", async () => {
    vi.useFakeTimers();
    try {
      const log = startDesktopLog({ userData: profile(), dev: false, env: {} });
      logs.push(log);
      const stuck = vi.spyOn(log.file, "flush").mockReturnValue(new Promise(() => {}));
      const flushed = log.flush(50);
      vi.advanceTimersByTime(50);
      await flushed;
      expect(stuck).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("power transitions", () => {
  it("logs a lid close and reopen as sleep and wake, with the reason", async () => {
    const { logPowerTransitions } = await import("./desktop-log");
    const userData = profile();
    const log = startDesktopLog({ userData, dev: false, env: {} });
    logs.push(log);
    const listeners = new Map<string, () => void>();
    logPowerTransitions({ on: (event, listener) => listeners.set(event, listener) });
    expect([...listeners.keys()]).toEqual(["suspend", "resume", "lock-screen", "unlock-screen"]);
    listeners.get("suspend")!();
    listeners.get("resume")!();
    await log.flush();
    const lines = readFileSync(log.file.currentFile()!, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map(({ component, msg, reason }) => [component, msg, reason])).toEqual([
      ["power", "system sleeping", "suspend"],
      ["power", "system woke", "resume"],
    ]);
  });
});
