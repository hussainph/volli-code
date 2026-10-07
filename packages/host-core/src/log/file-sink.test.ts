import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { LogRecord } from "@volli/shared";

import {
  createRotatingFileSink,
  LOG_FILE_POLICY,
  NODE_LOG_FILE_SYSTEM,
  type LogFileFailure,
  type LogFileSystem,
} from "./file-sink";
import { MAX_LOG_LINE_BYTES } from "./logger";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // Spies on every synchronous call the sink could make: it must make none.
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
    writeSync: vi.fn(actual.writeSync),
    appendFileSync: vi.fn(actual.appendFileSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vc699-logs-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function record(ts: string, msg = "m"): [LogRecord, string] {
  const value: LogRecord = { ts, level: "info", component: "c", msg };
  return [value, JSON.stringify(value)];
}

function lines(path: string): LogRecord[] {
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as LogRecord);
}

/** Node's filesystem, with one operation failing as told. */
function failing(
  overrides: Partial<LogFileSystem>,
): LogFileSystem & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const counted = <K extends keyof LogFileSystem>(name: K): LogFileSystem[K] =>
    ((...args: never[]) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return (overrides[name] ?? NODE_LOG_FILE_SYSTEM[name])(...(args as [never]));
    }) as LogFileSystem[K];
  return {
    calls,
    mkdir: counted("mkdir"),
    size: counted("size"),
    open: counted("open"),
    readdir: counted("readdir"),
    unlink: counted("unlink"),
  };
}

const ERROR = (code: string) => Object.assign(new Error(code), { code });

describe("the rotating file sink", () => {
  it("files lines by day and reads back as JSON lines", async () => {
    const directory = join(tempDir(), "nested", "logs");
    const sink = createRotatingFileSink({ directory, now: () => new Date("2026-10-08T00:00:00Z") });
    sink.write(...record("2026-10-07T23:59:59.000Z", "late"));
    sink.write(...record("2026-10-08T00:00:01.000Z", "early"));
    await sink.flush();
    expect(sink.currentFile()).toBe(join(directory, "volli-2026-10-08.jsonl"));
    await sink.close();
    expect(readdirSync(directory).toSorted()).toEqual([
      "volli-2026-10-07.jsonl",
      "volli-2026-10-08.jsonl",
    ]);
    expect(lines(join(directory, "volli-2026-10-07.jsonl")).map(({ msg }) => msg)).toEqual([
      "late",
    ]);
    // Closed: later lines are dropped, never thrown.
    sink.write(...record("2026-10-08T00:00:02.000Z"));
    expect(sink.dropped()).toBe(1);
    expect(sink.currentFile()).toBeNull();
  });

  it("rolls a full file to the next index, appending to what an earlier launch left", async () => {
    const directory = tempDir();
    writeFileSync(join(directory, "volli-2026-10-07.jsonl"), "x".repeat(200));
    const sink = createRotatingFileSink({
      directory,
      policy: { maxFileBytes: 200, maxTotalBytes: 10_000 },
      now: () => new Date("2026-10-07T12:00:00Z"),
    });
    for (let index = 0; index < 6; index += 1)
      sink.write(...record("2026-10-07T12:00:00.000Z", `n${index}`));
    await sink.close();
    expect(readdirSync(directory).toSorted()).toEqual([
      "volli-2026-10-07.1.jsonl",
      "volli-2026-10-07.2.jsonl",
      "volli-2026-10-07.3.jsonl",
      "volli-2026-10-07.jsonl",
    ]);
    for (const name of readdirSync(directory)) {
      expect(statSync(join(directory, name)).size).toBeLessThanOrEqual(200);
    }
    expect(sink.dropped()).toBe(0);
  });

  it("removes files past the retention window, then the oldest past the total cap", async () => {
    const directory = tempDir();
    writeFileSync(join(directory, "volli-2026-09-01.jsonl"), "old\n");
    writeFileSync(join(directory, "volli-2026-10-05.jsonl"), "a".repeat(300));
    writeFileSync(join(directory, "volli-2026-10-06.jsonl"), "b".repeat(300));
    writeFileSync(join(directory, "volli-2026-10-06.1.jsonl"), "c".repeat(300));
    writeFileSync(join(directory, "unrelated.txt"), "keep");
    const sink = createRotatingFileSink({
      directory,
      policy: { retainDays: 7, maxTotalBytes: 700 },
      now: () => new Date("2026-10-07T12:00:00Z"),
    });
    sink.write(...record("2026-10-07T12:00:00.000Z"));
    await sink.flush();
    await sink.prune();
    await sink.close();
    expect(readdirSync(directory).toSorted()).toEqual([
      "unrelated.txt",
      "volli-2026-10-06.1.jsonl",
      "volli-2026-10-06.jsonl",
      "volli-2026-10-07.jsonl",
    ]);
  });

  it("states its defaults", () => {
    expect(LOG_FILE_POLICY).toEqual({
      maxFileBytes: 10 * 1024 * 1024,
      retainDays: 7,
      maxTotalBytes: 100 * 1024 * 1024,
      maxBufferedBytes: 4 * 1024 * 1024,
      maxLineBytes: MAX_LOG_LINE_BYTES + 1,
    });
  });
});

/*
 * Review blockers 3, 4 and 5 (VC-699), permanent: the reviewer's probes,
 * asserting the bounds now hold.
 */
describe("bounds (strict, at the boundary)", () => {
  it("holds a synchronous burst to the backlog bound across rotations, and counts the rest", async () => {
    const directory = tempDir();
    const sink = createRotatingFileSink({
      directory,
      policy: { maxFileBytes: 200, maxBufferedBytes: 250, maxTotalBytes: 100_000 },
    });
    // The reviewer's line: 138 bytes with its newline.
    const value: LogRecord = {
      ts: new Date().toISOString(),
      level: "info",
      component: "probe",
      msg: "x".repeat(60),
    };
    const line = JSON.stringify(value);
    const size = Buffer.byteLength(line) + 1;
    expect(size).toBe(138);
    let peak = 0;
    for (let index = 0; index < 40; index += 1) {
      sink.write(value, line);
      peak = Math.max(peak, sink.pendingBytes());
    }
    // The reviewer's probe accepted 5,520 bytes here; one line fits 250.
    expect(peak).toBeLessThanOrEqual(250);
    expect(sink.pendingBytes()).toBe(size);
    expect(sink.dropped()).toBe(39);
    await sink.flush();
    expect(sink.pendingBytes()).toBe(0);
    // The next line that fits brings one notice, and both count against the bound.
    sink.write(value, line);
    expect(sink.pendingBytes()).toBeLessThanOrEqual(250);
    await sink.close();
    const written = readdirSync(directory).flatMap((name) => lines(join(directory, name)));
    expect(written.filter(({ component }) => component === "log")).toEqual([
      expect.objectContaining({ msg: "log lines dropped", dropped: 39, level: "warn" }),
    ]);
    expect(written.filter(({ component }) => component === "probe")).toHaveLength(2);
  });

  it("admits a line at exactly the backlog bound, and not one byte past it", () => {
    const directory = tempDir();
    const [value, line] = record("2026-10-07T12:00:00.000Z");
    const size = Buffer.byteLength(line) + 1;
    const exact = createRotatingFileSink({ directory, policy: { maxBufferedBytes: size } });
    exact.write(value, line);
    expect([exact.pendingBytes(), exact.dropped()]).toEqual([size, 0]);
    const under = createRotatingFileSink({ directory, policy: { maxBufferedBytes: size - 1 } });
    under.write(value, line);
    expect([under.pendingBytes(), under.dropped()]).toEqual([0, 1]);
    return Promise.all([exact.close(), under.close()]);
  });

  it("never grows a reopened file past its cap: the line goes to the next file", async () => {
    const directory = tempDir();
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(join(directory, `volli-${day}.jsonl`), "x".repeat(190));
    const sink = createRotatingFileSink({ directory, policy: { maxFileBytes: 200 } });
    sink.write(...record(`${day}T00:00:00.000Z`, "hello"));
    await sink.close();
    // The reviewer's probe: 273 bytes against a 200-byte cap.
    expect(statSync(join(directory, `volli-${day}.jsonl`)).size).toBe(190);
    expect(lines(join(directory, `volli-${day}.1.jsonl`)).map(({ msg }) => msg)).toEqual(["hello"]);
  });

  it("fills a file to exactly its cap, and starts the next with the line that would cross it", async () => {
    const directory = tempDir();
    const day = "2026-10-07";
    const [value, line] = record(`${day}T00:00:00.000Z`);
    const size = Buffer.byteLength(line) + 1;
    const sink = createRotatingFileSink({ directory, policy: { maxFileBytes: size * 2 } });
    for (let index = 0; index < 3; index += 1) sink.write(value, line);
    await sink.close();
    expect(statSync(join(directory, `volli-${day}.jsonl`)).size).toBe(size * 2);
    expect(statSync(join(directory, `volli-${day}.1.jsonl`)).size).toBe(size);
  });

  it("drops a line past the line ceiling or the file cap, counted and reported", async () => {
    const directory = tempDir();
    const day = "2026-10-07";
    const sink = createRotatingFileSink({ directory, policy: { maxLineBytes: 120 } });
    const [big, bigLine] = record(`${day}T00:00:00.000Z`, "y".repeat(120));
    sink.write(big, bigLine);
    expect(sink.dropped()).toBe(1);
    expect(sink.pendingBytes()).toBe(0);
    sink.write(...record(`${day}T00:00:01.000Z`, "ok"));
    await sink.close();
    const written = lines(join(directory, `volli-${day}.jsonl`));
    expect(written.map(({ msg }) => msg)).toEqual(["log lines dropped", "ok"]);
    for (const text of readFileSync(join(directory, `volli-${day}.jsonl`), "utf8").split("\n")) {
      expect(Buffer.byteLength(text) + 1).toBeLessThanOrEqual(120);
    }
    const small = createRotatingFileSink({ directory, policy: { maxFileBytes: 50 } });
    small.write(...record(`${day}T00:00:02.000Z`, "z".repeat(60)));
    expect(small.dropped()).toBe(1);
    await small.close();
  });
});

describe("never fatal, never synchronous", () => {
  it("does no synchronous filesystem call: creating, writing, rotating, pruning or closing", async () => {
    const directory = join(tempDir(), "logs");
    const sync = [
      nodeFs.existsSync,
      nodeFs.statSync,
      nodeFs.mkdirSync,
      nodeFs.openSync,
      nodeFs.writeSync,
      nodeFs.appendFileSync,
      nodeFs.readdirSync,
    ] as unknown as ReturnType<typeof vi.fn>[];
    for (const spy of sync) spy.mockClear();
    const sink = createRotatingFileSink({ directory, policy: { maxFileBytes: 120 } });
    for (let index = 0; index < 5; index += 1) {
      sink.write(...record(`2026-10-0${index + 1}T00:00:00.000Z`, `n${index}`));
      sink.write(...record(`2026-10-0${index + 1}T00:00:01.000Z`, `m${index}`));
    }
    // Nothing touched the disk on the caller's stack: not even the directory.
    expect(sink.currentFile()).toBeNull();
    await sink.flush();
    await sink.prune();
    await sink.close();
    for (const spy of sync) expect(spy).not.toHaveBeenCalled();
    expect(readdirSync(directory).length).toBeGreaterThan(5);
  });

  it("survives a file where its directory should be: no throw, one report, lines dropped", async () => {
    const userData = tempDir();
    writeFileSync(join(userData, "logs"), "a file occupies the log directory");
    const failures: LogFileFailure[] = [];
    const sink = createRotatingFileSink({
      directory: join(userData, "logs"),
      onFailure: (failure) => failures.push(failure),
    });
    sink.write(...record("2026-10-07T00:00:00.000Z"));
    sink.write(...record("2026-10-07T00:00:01.000Z"));
    await sink.flush();
    sink.write(...record("2026-10-07T00:00:02.000Z"));
    await sink.close();
    expect(failures).toEqual([
      {
        stage: "directory",
        code: expect.stringMatching(/^E[A-Z]+$/u),
        directory: join(userData, "logs"),
      },
    ]);
    expect(sink.dropped()).toBe(3);
    expect(sink.failure()).toEqual(failures[0]);
    expect(sink.currentFile()).toBeNull();
  });

  it("survives an unwritable directory", async () => {
    const directory = tempDir();
    chmodSync(directory, 0o500);
    const failures: LogFileFailure[] = [];
    const sink = createRotatingFileSink({ directory, onFailure: (f) => failures.push(f) });
    sink.write(...record("2026-10-07T00:00:00.000Z"));
    await sink.close();
    expect(failures).toEqual([expect.objectContaining({ stage: "open", code: "EACCES" })]);
    expect(sink.dropped()).toBe(1);
  });

  it("survives a full disk: the write fails, the sink stops and says so once", async () => {
    const directory = tempDir();
    const failures: LogFileFailure[] = [];
    let closed = 0;
    const fs = failing({
      open: () =>
        Promise.resolve({
          write: () => Promise.reject(ERROR("ENOSPC")),
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        }),
    });
    const sink = createRotatingFileSink({ directory, fs, onFailure: (f) => failures.push(f) });
    sink.write(...record("2026-10-07T00:00:00.000Z"));
    sink.write(...record("2026-10-07T00:00:01.000Z"));
    await sink.flush();
    sink.write(...record("2026-10-07T00:00:02.000Z"));
    await sink.close();
    expect(failures).toEqual([{ stage: "write", code: "ENOSPC", directory }]);
    expect(sink.dropped()).toBe(3);
    expect(sink.pendingBytes()).toBe(0);
    expect(closed).toBe(1);
  });

  it("survives an open that fails, and a reporter that throws", async () => {
    const fs = failing({ open: () => Promise.reject(ERROR("EMFILE")) });
    const sink = createRotatingFileSink({
      directory: tempDir(),
      fs,
      onFailure: () => {
        throw new Error("reporter broke");
      },
    });
    sink.write(...record("2026-10-07T00:00:00.000Z"));
    await sink.close();
    expect(sink.failure()).toMatchObject({ stage: "open", code: "EMFILE" });
    expect(fs.calls["open"]).toBe(1);
  });

  it("reports to stderr by default, as one JSON line naming no path", async () => {
    const directory = tempDir();
    writeFileSync(join(directory, "logs"), "");
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const sink = createRotatingFileSink({ directory: join(directory, "logs") });
      sink.write(...record("2026-10-07T00:00:00.000Z"));
      await sink.close();
    } finally {
      spy.mockRestore();
    }
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toMatchObject({
      level: "warn",
      component: "log",
      stage: "directory",
    });
    expect(writes[0]).not.toContain(directory);
  });

  it("makes the directory once, then appends to an existing one", async () => {
    const directory = join(tempDir(), "logs");
    mkdirSync(directory);
    const fs = failing({});
    const sink = createRotatingFileSink({ directory, fs, policy: { maxFileBytes: 100 } });
    for (let index = 0; index < 4; index += 1) {
      sink.write(...record("2026-10-07T00:00:00.000Z", `n${index}`));
    }
    await sink.close();
    expect(fs.calls["mkdir"]).toBe(1);
    expect(readdirSync(directory).length).toBe(4);
  });
});
