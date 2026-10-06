// @vitest-environment node
/**
 * The VC-699 review's desktop probes, permanent (blockers 1, 2 and 3): each
 * showed a leak or a crash; each now asserts the fixed behaviour, through the
 * real renderer forwarder, main's ingress and the desktop log's startup.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostLogger, installHostLog } from "@volli/host-core/log";
import { redactLogFields, type LogRecord, type RendererLogEntry } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { installRendererLogForwarding, rendererLog } from "../../renderer/src/lib/renderer-log";
import { startDesktopLog, type DesktopLog } from "./desktop-log";
import { createRendererLogWriter } from "./renderer-log";

const dirs: string[] = [];
const logs: DesktopLog[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "vc699-probe-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const log of logs.splice(0)) await log.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const SECRETS = [
  "opaque-review-token-123",
  "review-password-123",
  "customer-private-content",
  "private customer roadmap contents",
];

function forwarded(
  run: (target: {
    console: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
    fire: (type: "error" | "unhandledrejection", event: unknown) => void;
  }) => void,
): { records: LogRecord[]; sent: RendererLogEntry[] } {
  const records: LogRecord[] = [];
  const sent: RendererLogEntry[] = [];
  const undo = installHostLog({
    level: "debug",
    sink: { write: (record) => records.push(record) },
  });
  const writer = createRendererLogWriter(() => 0);
  const listeners = new Map<string, (event: unknown) => void>();
  const target = {
    console: { warn: () => {}, error: () => {} },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    removeEventListener: () => {},
  };
  const stop = installRendererLogForwarding(target as never, () => ({
    write: (entry) => {
      // What crosses IPC: a structured clone of the entry, nothing else.
      const crossed = structuredClone(entry);
      sent.push(crossed);
      writer({ id: 1 }, crossed);
    },
  }));
  try {
    run({
      console: target.console as never,
      fire: (type, event) => listeners.get(type)!(event),
    });
  } finally {
    stop();
    undo();
  }
  return { records, sent };
}

describe("blocker 1: the renderer never forwards credentials or content", () => {
  it("redacts a console object structurally before serialisation (the reviewer's probe)", () => {
    const { records, sent } = forwarded(({ console }) => {
      console.warn({
        token: "opaque-review-token-123",
        nested: { password: "review-password-123" },
      });
      console.error(
        "save failed",
        { token: "opaque-review-token-123" },
        new Error("customer-private-content"),
      );
    });
    for (const secret of SECRETS) {
      expect(JSON.stringify(sent)).not.toContain(secret);
      expect(JSON.stringify(records)).not.toContain(secret);
    }
    expect(records.map(({ component, msg }) => [component, msg])).toEqual([
      ["renderer:console", "console message"],
      ["renderer:console", "save failed"],
    ]);
    expect(records[1]).toMatchObject({ args: 2, error: { name: "Error" } });
  });

  it("never forwards the editor tokenizer's file-content warning", () => {
    const fileLine = "private customer roadmap contents";
    const { records, sent } = forwarded(({ console }) => {
      console.warn(`Time limit reached when tokenizing line: ${fileLine.substring(0, 100)}`);
    });
    expect(sent).toEqual([]);
    expect(records).toEqual([]);
  });

  it("forwards an uncaught error and a rejection as summaries, never their text", () => {
    const { records } = forwarded(({ fire }) => {
      fire("error", {
        message: "Uncaught Error: customer-private-content",
        error: new Error("customer-private-content"),
        filename: "app.js",
        lineno: 4,
      });
      fire("unhandledrejection", { reason: { token: "opaque-review-token-123" } });
      fire("unhandledrejection", { reason: "customer-private-content" });
    });
    expect(JSON.stringify(records)).not.toMatch(/opaque-review|customer-private/u);
    expect(records.map(({ msg }) => msg)).toEqual([
      "uncaught error",
      "unhandled rejection",
      "unhandled rejection",
    ]);
  });

  it("main's ingress redacts a raw entry a window sends, whatever its shape", () => {
    const records: LogRecord[] = [];
    const undo = installHostLog({
      level: "debug",
      sink: { write: (record) => records.push(record) },
    });
    try {
      createRendererLogWriter(() => 0)(
        { id: 9 },
        {
          level: "warn",
          area: "console",
          msg: '{"token":"opaque-review-token-123","nested":{"password":"review-password-123"}}',
          fields: {
            nested: { password: "review-password-123" },
            list: ["customer-private-content"],
          },
        },
      );
    } finally {
      undo();
    }
    expect(JSON.stringify(records)).not.toMatch(/opaque-review|review-password|customer-private/u);
    expect(records[0]).toMatchObject({ component: "renderer:console", droppedFields: 2 });
  });

  it("a feature's own fields are made safe in the renderer, before IPC", () => {
    const sent: RendererLogEntry[] = [];
    rendererLog("host-link", () => ({ write: (entry) => sent.push(entry) })).warn("link state", {
      host: "box",
      token: "opaque-review-token-123",
      detail: { password: "review-password-123" },
    });
    expect(sent).toEqual([
      {
        level: "warn",
        area: "host-link",
        msg: "link state",
        fields: { host: "box", token: "[redacted]", droppedFields: 1 },
      },
    ]);
  });
});

describe("blocker 2: errors are scrubbed", () => {
  it("keeps neither a bearer in Error.name nor credentials in its message (the reviewer's probe)", () => {
    const error = new Error("Invalid file JSON: token=opaque-review-token-123");
    error.name = "Bearer opaque-review-token";
    const value = JSON.stringify(redactLogFields({ error }));
    expect(value).not.toContain("opaque-review-token");
  });
});

describe("blocker 3: the desktop log never stops the app starting", () => {
  it("starts with a file where the log directory should be, reports once, and keeps logging elsewhere", async () => {
    const userData = temp();
    writeFileSync(join(userData, "logs"), "a file occupies the log directory");
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const seen: LogRecord[] = [];
    let log!: DesktopLog;
    expect(() => {
      log = startDesktopLog({
        userData,
        dev: false,
        env: {},
        sinks: [{ write: (record) => seen.push(record) }],
      });
    }).not.toThrow();
    logs.push(log);
    hostLogger("boot").info("app ready");
    await log.flush();
    hostLogger("boot").info("still running");
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0]!)).toMatchObject({ component: "log", stage: "directory" });
    expect(seen.map(({ component, msg }) => [component, msg])).toEqual([
      ["boot", "app ready"],
      ["log", "log file disabled: lines are dropped from here on"],
      ["boot", "still running"],
    ]);
    expect(log.file.failure()).toMatchObject({ stage: "directory" });
    expect(readdirSync(userData)).toEqual(["logs"]);
  });
});
