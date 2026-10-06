import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import type { LogRecord } from "@volli/shared";

import { createRotatingFileSink, LOG_FILE_POLICY } from "./file-sink";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vc699-logs-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(ts: string, msg = "m"): [LogRecord, string] {
  const value: LogRecord = { ts, level: "info", component: "c", msg };
  return [value, JSON.stringify(value)];
}

describe("the rotating file sink", () => {
  it("files lines by day and reads back as JSON lines", async () => {
    const directory = join(tempDir(), "nested", "logs");
    const sink = createRotatingFileSink({ directory, now: () => new Date("2026-10-08T00:00:00Z") });
    sink.write(...record("2026-10-07T23:59:59.000Z", "late"));
    sink.write(...record("2026-10-08T00:00:01.000Z", "early"));
    expect(sink.currentFile()).toBe(join(directory, "volli-2026-10-08.jsonl"));
    await sink.flush();
    await sink.close();
    expect(readdirSync(directory).toSorted()).toEqual([
      "volli-2026-10-07.jsonl",
      "volli-2026-10-08.jsonl",
    ]);
    const lines = readFileSync(join(directory, "volli-2026-10-07.jsonl"), "utf8")
      .trimEnd()
      .split("\n");
    expect(lines.map((line) => (JSON.parse(line) as LogRecord).msg)).toEqual(["late"]);
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
    await sink.prune();
    await sink.close();
    expect(readdirSync(directory).toSorted()).toEqual([
      "unrelated.txt",
      "volli-2026-10-06.1.jsonl",
      "volli-2026-10-06.jsonl",
      "volli-2026-10-07.jsonl",
    ]);
  });

  it("drops lines past the buffer bound and says how many in the next line that fits", async () => {
    const directory = tempDir();
    const sink = createRotatingFileSink({
      directory,
      policy: { maxBufferedBytes: 100 },
      now: () => new Date("2026-10-07T12:00:00Z"),
    });
    for (let index = 0; index < 5; index += 1)
      sink.write(...record("2026-10-07T12:00:00.000Z", `n${index}`));
    expect(sink.dropped()).toBeGreaterThan(0);
    await sink.flush();
    sink.write(...record("2026-10-07T12:00:01.000Z", "after"));
    await sink.close();
    const lines = readFileSync(join(directory, "volli-2026-10-07.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as LogRecord);
    expect(lines.at(-2)).toMatchObject({
      component: "log",
      level: "warn",
      dropped: sink.dropped(),
    });
    expect(lines.at(-1)?.msg).toBe("after");
  });

  it("stops quietly when the disk refuses", async () => {
    const directory = tempDir();
    const sink = createRotatingFileSink({ directory, prefix: "desk" });
    // A directory where the file would go: the open fails asynchronously.
    const day = new Date().toISOString().slice(0, 10);
    rmSync(directory, { recursive: true, force: true });
    sink.write(...record(`${day}T00:00:00.000Z`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    sink.write(...record(`${day}T00:00:01.000Z`));
    expect(sink.dropped()).toBe(1);
    expect(sink.currentFile()).toBeNull();
    await sink.flush();
    await sink.close();
    await sink.prune();
  });

  it("states its defaults", () => {
    expect(LOG_FILE_POLICY).toEqual({
      maxFileBytes: 10 * 1024 * 1024,
      retainDays: 7,
      maxTotalBytes: 100 * 1024 * 1024,
      maxBufferedBytes: 4 * 1024 * 1024,
    });
  });
});
