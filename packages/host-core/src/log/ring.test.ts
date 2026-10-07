import { describe, expect, it } from "vite-plus/test";
import type { HostLogsBatch, LogLevel, LogRecord } from "@volli/shared";

import { createLogRing, LOG_PAGE_LIMIT, LOG_RING_BOUNDS } from "./ring";

function line(msg: string, level: LogLevel = "info"): [LogRecord, string] {
  const record: LogRecord = { ts: "2026-10-07T12:00:00.000Z", level, component: "test", msg };
  return [record, JSON.stringify(record)];
}

const msgs = (batch: HostLogsBatch) => batch.entries.map(({ record }) => record.msg);
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("the host's recent log", () => {
  it("states its bounds", () => {
    expect(LOG_RING_BOUNDS).toEqual({ maxLines: 10_000, maxBytes: 8 * 1024 * 1024 });
    expect(LOG_PAGE_LIMIT).toBe(500);
  });

  it("reads the newest lines, oldest first, and resumes strictly after a cursor", () => {
    const ring = createLogRing();
    for (const msg of ["a", "b", "c"]) ring.write(...line(msg));
    const first = ring.read({ limit: 2 });
    expect(msgs(first)).toEqual(["b", "c"]);
    // A tail is not a resume: older lines are not a gap.
    expect(first.gap).toBe(false);
    expect(first.cursor).toBe(first.entries[1]!.cursor);
    ring.write(...line("d"));
    expect(msgs(ring.read({ after: first.cursor }))).toEqual(["d"]);
    expect(ring.read({ after: ring.read({}).cursor })).toMatchObject({ entries: [], gap: false });
  });

  it("filters by level", () => {
    const ring = createLogRing();
    ring.write(...line("chatter", "debug"));
    ring.write(...line("broke", "error"));
    expect(msgs(ring.read({ minLevel: "warn" }))).toEqual(["broke"]);
  });

  it("evicts by count and by bytes, and says a resumed reader missed lines", () => {
    const byCount = createLogRing({ maxLines: 2 });
    byCount.write(...line("a"));
    const cursor = byCount.read({}).cursor;
    for (const msg of ["b", "c", "d"]) byCount.write(...line(msg));
    expect(byCount.size().lines).toBe(2);
    expect(byCount.read({ after: cursor })).toMatchObject({ gap: true });
    expect(msgs(byCount.read({ after: cursor }))).toEqual(["c", "d"]);

    const byBytes = createLogRing({ maxBytes: 200 });
    for (const msg of ["a", "b", "c", "d"]) byBytes.write(...line(msg));
    expect(byBytes.size().bytes).toBeLessThanOrEqual(200);
    expect(byBytes.size().lines).toBeLessThan(4);
    // One line past the byte bound is still kept: the newest is never dropped.
    const tiny = createLogRing({ maxBytes: 1 });
    tiny.write(...line("only"));
    expect(msgs(tiny.read({}))).toEqual(["only"]);
  });

  it("says a page that could not hold every unread line left a gap", () => {
    const ring = createLogRing();
    ring.write(...line("start"));
    const cursor = ring.read({}).cursor;
    for (const msg of ["a", "b", "c"]) ring.write(...line(msg));
    expect(ring.read({ after: cursor, limit: 2 })).toMatchObject({ gap: true });
    expect(ring.read({ after: cursor, limit: 3 })).toMatchObject({ gap: false });
    // Lines the filter excludes are not missed lines.
    ring.write(...line("quiet", "debug"));
    expect(
      ring.read({
        after: ring.read({ limit: 1, minLevel: "info" }).entries[0]!.cursor,
        minLevel: "warn",
      }),
    ).toMatchObject({
      gap: false,
    });
  });

  it("treats another instance's cursor, or nonsense, as a gap from the start", () => {
    const ring = createLogRing();
    ring.write(...line("a"));
    for (const after of ["other:1", `${ring.instance}:x`, `${ring.instance}:99`, "nonsense"]) {
      expect(ring.read({ after })).toMatchObject({ gap: true });
      expect(msgs(ring.read({ after }))).toEqual(["a"]);
    }
  });

  it("compacts its storage as it evicts", () => {
    const ring = createLogRing({ maxLines: 10 });
    for (let index = 0; index < 5_000; index += 1) ring.write(...line(`n${index}`));
    expect(ring.size().lines).toBe(10);
    expect(msgs(ring.read({})).at(-1)).toBe("n4999");
  });

  it("follows from a cursor: the backlog first, then live lines in batches", async () => {
    const ring = createLogRing();
    ring.write(...line("old"));
    const cursor = ring.read({}).cursor;
    ring.write(...line("missed"));
    const batches: HostLogsBatch[] = [];
    const stop = ring.follow({ after: cursor, minLevel: "info" }, (batch) => batches.push(batch));
    expect(batches.map(msgs)).toEqual([["missed"]]);
    ring.write(...line("live-1"));
    ring.write(...line("hidden", "debug"));
    ring.write(...line("live-2"));
    await tick();
    expect(batches.map(msgs)).toEqual([["missed"], ["live-1", "live-2"]]);
    expect(batches[1]!.cursor).toBe(batches[1]!.entries[1]!.cursor);
    stop();
    ring.write(...line("after stop"));
    await tick();
    expect(batches).toHaveLength(2);
  });

  it("follows live only without a cursor, splits a burst into pages, and stops a pending batch", async () => {
    const ring = createLogRing();
    ring.write(...line("before"));
    const batches: HostLogsBatch[] = [];
    const stop = ring.follow({}, (batch) => batches.push(batch));
    expect(batches).toEqual([]);
    for (let index = 0; index < LOG_PAGE_LIMIT + 3; index += 1) ring.write(...line(`n${index}`));
    await tick();
    expect(batches.map((batch) => batch.entries.length)).toEqual([LOG_PAGE_LIMIT, 3]);
    ring.write(...line("pending"));
    stop();
    await tick();
    expect(batches).toHaveLength(2);
  });

  it("follows from a cursor with nothing new and no gap without an empty first batch", async () => {
    const ring = createLogRing();
    ring.write(...line("a"));
    const batches: HostLogsBatch[] = [];
    ring.follow({ after: ring.read({}).cursor }, (batch) => batches.push(batch));
    expect(batches).toEqual([]);
    // A follower from a lost cursor hears the gap even with nothing to send.
    const lost: HostLogsBatch[] = [];
    createLogRing().follow({ after: "gone:3" }, (batch) => lost.push(batch));
    expect(lost).toMatchObject([{ entries: [], gap: true }]);
  });
});
