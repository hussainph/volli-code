import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";
import type { HostLogsBatch, LogLevel, LogRecord } from "@volli/shared";

import { createLogger } from "./logger";
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

/* ---------------------------------------------------- byte-safe (VC-712) */

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
/** About `size` bytes of message: `glyph` repeated, so a test can choose ASCII or not. */
const sized = (index: number, size: number, glyph = "x") =>
  `${index}:`.padEnd(Math.floor(size / Buffer.byteLength(glyph)), glyph);
/** hostd's frame budget for one answer: its 2 MiB frame less the envelope. */
const FRAME_BUDGET = 2 * 1024 * 1024 - 4096;

describe("the host's recent log, in bytes (VC-712)", () => {
  it("counts encoded bytes, not UTF-16 units", () => {
    const ring = createLogRing();
    const [record, text] = line("héllo — 日本語 🚀");
    ring.write(record, text);
    expect(ring.size().bytes).toBe(Buffer.byteLength(text, "utf8") + 1);
    expect(ring.size().bytes).toBeGreaterThan(text.length + 1);
    // Eviction by bytes reads the same count: three-byte glyphs fill it three times as fast.
    const small = createLogRing({ maxBytes: 3_000 });
    for (let index = 0; index < 10; index += 1) small.write(...line(sized(index, 900, "語")));
    expect(small.size().bytes).toBeLessThanOrEqual(3_000);
    expect(small.size().lines).toBe(3);
  });

  it("sizes an answer exactly: a budget its JSON fills holds every line, a byte less does not", () => {
    const ring = createLogRing();
    for (let index = 0; index < 5; index += 1) ring.write(...line(sized(index, 300, "é")));
    const whole = ring.read({});
    const exact = bytesOf(whole);
    expect(ring.read({ maxBytes: exact })).toEqual(whole);
    const short = ring.read({ maxBytes: exact - 1 });
    expect(short.entries).toEqual(whole.entries.slice(1));
    expect(short.gap).toBe(true);
    expect(bytesOf(short)).toBeLessThanOrEqual(exact - 1);
  });

  it("tails 600 lines of 5 KiB inside a 2 MiB frame: the newest that fit, and a gap", () => {
    const ring = createLogRing();
    for (let index = 0; index < 600; index += 1) ring.write(...line(sized(index, 5 * 1024)));
    const page = ring.read({ limit: 500, maxBytes: FRAME_BUDGET });
    expect(bytesOf(page)).toBeLessThanOrEqual(FRAME_BUDGET);
    expect(page.entries.length).toBeGreaterThan(350);
    expect(page.entries.length).toBeLessThan(500);
    expect(page.gap).toBe(true);
    expect(page.entries.at(-1)!.record.msg).toBe(sized(599, 5 * 1024));
    expect(page.cursor).toBe(page.entries.at(-1)!.cursor);
    // Unbounded (the desktop's IPC), the count alone limits it, as before.
    expect(ring.read({ limit: 500 })).toMatchObject({ gap: false });
    expect(ring.read({ limit: 500 }).entries).toHaveLength(500);
  });

  it("answers past a line no answer can carry with no lines, a gap, and the newest cursor", () => {
    const ring = createLogRing();
    ring.write(...line(sized(0, 2_000)));
    expect(ring.read({ maxBytes: 500 })).toEqual({
      entries: [],
      gap: true,
      cursor: `${ring.instance}:1`,
    });
    // A budget that is no number bounds nothing.
    expect(ring.read({ maxBytes: 0 }).entries).toHaveLength(1);
  });

  it("follows in batches inside the budget, each with its own newest cursor", async () => {
    const ring = createLogRing();
    const batches: HostLogsBatch[] = [];
    ring.follow({ maxBytes: 4_000 }, (batch) => batches.push(batch));
    for (let index = 0; index < 3; index += 1) ring.write(...line(sized(index, 1_000)));
    await tick();
    for (let index = 3; index < 6; index += 1) ring.write(...line(sized(index, 1_000)));
    await tick();
    expect(batches.flatMap(msgs)).toEqual([0, 1, 2, 3, 4, 5].map((index) => sized(index, 1_000)));
    for (const batch of batches) {
      expect(bytesOf(batch)).toBeLessThanOrEqual(4_000);
      expect(batch.cursor).toBe(batch.entries.at(-1)!.cursor);
      expect(batch.gap).toBe(false);
    }
  });

  it("holds one budget unsent: a burst past it keeps the newest and says the rest are missing", async () => {
    const ring = createLogRing();
    const batches: HostLogsBatch[] = [];
    ring.follow({ maxBytes: FRAME_BUDGET }, (batch) => batches.push(batch));
    for (let index = 0; index < 600; index += 1) ring.write(...line(sized(index, 5 * 1024, "ü")));
    await tick();
    expect(batches).toHaveLength(1);
    const [burst] = batches;
    expect(burst!.gap).toBe(true);
    expect(bytesOf(burst)).toBeLessThanOrEqual(FRAME_BUDGET);
    expect(burst!.entries.at(-1)!.record.msg).toBe(sized(599, 5 * 1024, "ü"));
    // The next batch is whole again.
    ring.write(...line("calm"));
    await tick();
    expect(batches[1]).toMatchObject({ gap: false });
    expect(msgs(batches[1]!)).toEqual(["calm"]);
  });

  it("never sends a line no batch can carry; the next batch says it is missing", async () => {
    const ring = createLogRing();
    const batches: HostLogsBatch[] = [];
    ring.follow({ maxBytes: 600 }, (batch) => batches.push(batch));
    ring.write(...line(sized(0, 1_000)));
    await tick();
    expect(batches).toEqual([]);
    ring.write(...line("fits"));
    await tick();
    expect(batches).toMatchObject([{ gap: true }]);
    expect(msgs(batches[0]!)).toEqual(["fits"]);
  });

  it("bounds unsent lines by count too, and compacts what it dropped", async () => {
    const ring = createLogRing({ maxLines: 3 });
    const batches: HostLogsBatch[] = [];
    ring.follow({}, (batch) => batches.push(batch));
    for (let index = 0; index < 3_000; index += 1) ring.write(...line(`n${index}`));
    await tick();
    expect(batches).toHaveLength(1);
    expect(msgs(batches[0]!)).toEqual(["n2997", "n2998", "n2999"]);
    expect(batches[0]!.gap).toBe(true);
  });

  it("splits a burst of small lines by count, each batch carrying its own cursor", async () => {
    const ring = createLogRing();
    const batches: HostLogsBatch[] = [];
    ring.follow({ maxBytes: FRAME_BUDGET }, (batch) => batches.push(batch));
    for (let index = 0; index < LOG_PAGE_LIMIT + 1; index += 1) ring.write(...line(`n${index}`));
    await tick();
    expect(batches.map((batch) => batch.entries.length)).toEqual([LOG_PAGE_LIMIT, 1]);
    expect(batches[0]!.cursor).toBe(batches[0]!.entries.at(-1)!.cursor);
    expect(batches[0]!.cursor).not.toBe(batches[1]!.cursor);
  });

  it("bounds a follower's backlog like a read", () => {
    const ring = createLogRing();
    ring.write(...line("start"));
    const cursor = ring.read({}).cursor;
    for (let index = 0; index < 10; index += 1) ring.write(...line(sized(index, 1_000)));
    const batches: HostLogsBatch[] = [];
    ring.follow({ after: cursor, maxBytes: 3_500 }, (batch) => batches.push(batch));
    expect(batches).toHaveLength(1);
    expect(batches[0]!.gap).toBe(true);
    expect(bytesOf(batches[0])).toBeLessThanOrEqual(3_500);
    expect(msgs(batches[0]!).at(-1)).toBe(sized(9, 1_000));
  });
});

/* ------------------------------------- what a follower retains (VC-712, B1) */

/** The engine's own collector, reached without a flag on the command line. */
function collector(): () => void {
  setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
}

describe("what a follower retains (VC-712)", () => {
  for (const budget of [64 * 1024, FRAME_BUDGET]) {
    it(`keeps no line it dropped past its ${budget}-byte budget reachable`, async () => {
      // The burst under test happens before the follower's one flush: hold the flush back.
      vi.useFakeTimers({ toFake: ["setImmediate"] });
      const ring = createLogRing();
      const refs: WeakRef<LogRecord>[] = [];
      const log = createLogger({
        component: "probe",
        level: "debug",
        sink: {
          write(record, text) {
            if (record.level === "error") refs.push(new WeakRef(record));
            ring.write(record, text);
          },
        },
      });
      const stop = ring.follow({ maxBytes: budget, minLevel: "error" }, () => {});
      for (let index = 0; index < 1_000; index += 1) {
        const tag = String(index).padStart(5, "0");
        log.error(
          `n${index}`,
          Object.fromEntries(
            Array.from({ length: 8 }, (_, field) => [`p${field}`, tag + "x".repeat(1_895)]),
          ),
        );
      }
      // Every large line leaves the ring too; these never reach the error-only follower.
      for (let index = 0; index < 12_000; index += 1) log.info(`clear${index}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const gc = collector();
      gc();
      gc();
      const retained = refs
        .map((ref) => ref.deref())
        .filter((record): record is LogRecord => record !== undefined)
        .reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0);
      expect(retained).toBeLessThanOrEqual(budget);
      stop();
      vi.useRealTimers();
    });
  }
});
