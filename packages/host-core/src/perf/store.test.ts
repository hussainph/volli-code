import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { LogRecord } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { installHostLog } from "../log/root";
import {
  openPerfStore,
  PERF_FIELD_MAX,
  PERF_READ_CHUNK,
  PERF_STORE_BOUNDS,
  PERF_STORE_SCHEMA_VERSION,
  perfStorePath,
  type PerfStallInput,
  type PerfStore,
  type PerfStoreOptions,
} from "./store";

let dir = "";
let clock = 0;
let records: LogRecord[] = [];
let undoLog: () => void = () => {};
const opened: PerfStore[] = [];
/** The periodic writes a store armed, driven by hand. */
let ticks: (() => void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-perf-"));
  clock = 1_800_000_000_000;
  records = [];
  ticks = [];
  undoLog = installHostLog({ level: "debug", sink: { write: (record) => records.push(record) } });
});

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  undoLog();
  rmSync(dir, { recursive: true, force: true });
});

function open(options: Partial<PerfStoreOptions> = {}): PerfStore {
  const store = openPerfStore({
    path: perfStorePath(dir),
    version: "0.3.0",
    now: () => clock,
    every: (run) => {
      ticks.push(run);
      return () => {
        ticks = ticks.filter((tick) => tick !== run);
      };
    },
    ...options,
  });
  if (store === null) throw new Error("perf store did not open");
  opened.push(store);
  return store;
}

function stall(overrides: Partial<PerfStallInput> = {}): PerfStallInput {
  return {
    at: clock,
    process: "main",
    kind: "door",
    door: "ipc",
    operation: "volli:board-load",
    durationMs: 250,
    ...overrides,
  };
}

// Frozen v1 SQL: compatibility must exercise the old reader/writer against
// SQLite itself, not the current schema constant or a mocked row codec.
const V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    version TEXT NOT NULL,
    build TEXT
  );
  CREATE TABLE IF NOT EXISTS stalls (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    process TEXT NOT NULL,
    kind TEXT NOT NULL,
    door TEXT NOT NULL,
    operation TEXT NOT NULL,
    label TEXT,
    session_id TEXT,
    window_id INTEGER,
    duration_ms INTEGER NOT NULL,
    hint TEXT
  );
  CREATE INDEX IF NOT EXISTS stalls_at ON stalls (at);
`;
const V1_INSERT = `INSERT INTO stalls
  (run_id, at, process, kind, door, operation, label, session_id, window_id, duration_ms, hint)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const V1_SELECT = `SELECT s.at, s.process, s.kind, s.door, s.operation, s.label, s.session_id,
  s.window_id, s.duration_ms, s.hint, r.version, r.build
  FROM stalls s JOIN runs r ON r.id = s.run_id ORDER BY s.at DESC, s.id DESC`;
const BREAKDOWN = {
  scriptTotalMs: 140,
  blockingMs: 100,
  renderMs: 90,
  styleLayoutMs: 70,
  scriptFile: "chat-plane.tsx",
  scriptFunction: "ChatPlaneContent",
  scriptInvoker: "user-callback",
  scriptMs: 80,
};

describe("the perf store", () => {
  it("lives in the profile as perf.db", () => {
    expect(perfStorePath("/profile")).toBe("/profile/perf.db");
  });

  it("buffers a stall until its periodic write, and a read flushes first", () => {
    const store = open();
    store.record(stall());
    // Nothing on disk yet: a second connection to the file sees no row.
    const other = open();
    expect(other.stalls({})).toEqual([]);
    expect(ticks).toHaveLength(2);
    ticks[0]!();
    expect(other.stalls({})).toHaveLength(1);
    store.record(stall({ operation: "volli:second" }));
    expect(store.stalls({}).map((row) => row.operation)).toEqual([
      "volli:second",
      "volli:board-load",
    ]);
  });

  it("reads rows back newest first with their run's version and build", () => {
    const store = open({ build: "abc1234" });
    store.record(stall({ at: clock - 2, durationMs: 210, sessionId: "session-1", hint: "ipc/x" }));
    store.record(
      stall({
        at: clock - 1,
        process: "renderer",
        kind: "frame",
        door: "renderer",
        operation: "long-animation-frame",
        label: "pane-switch",
        windowId: 3,
        durationMs: 320.6,
      }),
    );
    expect(store.stalls({})).toEqual([
      {
        at: clock - 1,
        process: "renderer",
        kind: "frame",
        door: "renderer",
        operation: "long-animation-frame",
        label: "pane-switch",
        sessionId: null,
        windowId: 3,
        durationMs: 321,
        hint: null,
        version: "0.3.0",
        build: "abc1234",
      },
      {
        at: clock - 2,
        process: "main",
        kind: "door",
        door: "ipc",
        operation: "volli:board-load",
        label: null,
        sessionId: "session-1",
        windowId: null,
        durationMs: 210,
        hint: "ipc/x",
        version: "0.3.0",
        build: "abc1234",
      },
    ]);
  });

  it("round-trips optional frame breakdowns through both readers without filling missing values", async () => {
    const store = open();
    store.record(stall({ process: "renderer", kind: "frame", ...BREAKDOWN }));
    store.record(stall({ at: clock + 1, process: "renderer", kind: "frame", scriptTotalMs: 0 }));
    expect(store.stalls({})).toEqual([
      expect.objectContaining({ scriptTotalMs: 0 }),
      expect.objectContaining(BREAKDOWN),
    ]);
    const seen: unknown[] = [];
    await store.scanStalls({}, (page) => seen.push(...page));
    expect(seen).toEqual(store.stalls({}).toReversed());
    for (const field of Object.keys(BREAKDOWN).filter((key) => key !== "scriptTotalMs")) {
      expect(store.stalls({})[0]).not.toHaveProperty(field);
    }
  });

  it("creates v2 idempotently and never downgrades a future schema version", () => {
    open().close();
    open().close();
    const db = new Database(perfStorePath(dir));
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(PERF_STORE_SCHEMA_VERSION);
      expect(PERF_STORE_SCHEMA_VERSION).toBe(2);
      const columns = db.pragma("table_info(stalls)") as { name: string; notnull: number }[];
      for (const name of [
        "script_total_ms",
        "blocking_ms",
        "render_ms",
        "style_layout_ms",
        "script_file",
        "script_function",
        "script_invoker",
        "script_ms",
      ]) {
        expect(columns.filter((column) => column.name === name)).toEqual([
          expect.objectContaining({ notnull: 0 }),
        ]);
      }
      db.exec("ALTER TABLE stalls ADD COLUMN future_field TEXT; PRAGMA user_version = 99");
      open().close();
      expect(db.pragma("user_version", { simple: true })).toBe(99);
      expect(db.prepare("SELECT future_field FROM stalls").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("upgrades v1, supports v1 SQL read/write after upgrade, then reopens v2 losslessly", () => {
    const legacy = new Database(perfStorePath(dir));
    try {
      legacy.exec(`${V1_SCHEMA} PRAGMA user_version = 1;`);
      const runId = legacy
        .prepare("INSERT INTO runs (started_at, last_seen_at, version, build) VALUES (?, ?, ?, ?)")
        .run(clock, clock, "v1", null).lastInsertRowid;
      const writeV1 = (at: number) =>
        legacy
          .prepare(V1_INSERT)
          .run(
            runId,
            at,
            "renderer",
            "frame",
            "renderer",
            "long-animation-frame",
            "idle",
            null,
            1,
            250,
            null,
          );
      writeV1(clock - 1);
      const upgraded = open({ version: "v2" });
      upgraded.record(stall({ process: "renderer", kind: "frame", ...BREAKDOWN }));
      upgraded.close();
      expect(legacy.pragma("user_version", { simple: true })).toBe(2);
      // An old build executes its create-if-absent SQL and explicit-column
      // reader/writer unchanged against the expanded layout.
      legacy.exec(V1_SCHEMA);
      expect(legacy.prepare(V1_SELECT).all()).toEqual([
        expect.objectContaining({ at: clock, duration_ms: 250, version: "v2" }),
        expect.objectContaining({ at: clock - 1, duration_ms: 250, version: "v1" }),
      ]);
      writeV1(clock + 1);
    } finally {
      legacy.close();
    }
    const reopened = open();
    const rows = reopened.stalls({});
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject(BREAKDOWN);
    for (const row of [rows[0], rows[2]]) {
      for (const field of Object.keys(BREAKDOWN)) expect(row).not.toHaveProperty(field);
    }
    reopened.close();
    // A second upgrade/open remains a no-op for both data and schema.
    expect(open().stalls({})).toEqual(rows);
  });

  it("sanitizes optional attribution and bounds durations before persisting", () => {
    const store = open();
    store.record(
      stall({
        process: "renderer",
        kind: "frame",
        scriptTotalMs: 140.6,
        blockingMs: -2,
        renderMs: Number.POSITIVE_INFINITY,
        styleLayoutMs: Number.NaN,
        scriptFile: "file:///Users/private/renderer.js?token=secret#fragment",
        scriptFunction: "private user content",
        scriptInvoker: "private user content",
        scriptMs: 1_000_000,
      }),
    );
    const [row] = store.stalls({});
    expect(row).toMatchObject({
      scriptTotalMs: 141,
      blockingMs: 0,
      scriptFile: "renderer.js",
      scriptInvoker: "other",
      scriptMs: 600_000,
    });
    for (const field of ["renderMs", "styleLayoutMs", "scriptFunction"]) {
      expect(row).not.toHaveProperty(field);
    }
    const db = new Database(perfStorePath(dir));
    try {
      expect(
        db.prepare("SELECT script_file, script_function, script_invoker FROM stalls").get(),
      ).toEqual({ script_file: "renderer.js", script_function: null, script_invoker: "other" });
    } finally {
      db.close();
    }
  });

  it("filters by time, process, door, operation, label and build, and limits", () => {
    const store = open({ build: "abc1234" });
    store.record(stall({ at: clock - 10_000 }));
    store.record(stall({ door: "socket", operation: "ticket.list" }));
    store.record(
      stall({ process: "renderer", door: "renderer", operation: "keydown", label: "draft-typing" }),
    );
    const ops = (filter: Parameters<PerfStore["stalls"]>[0], limit?: number) =>
      store.stalls(filter, limit).map((row) => `${row.door}/${row.operation}`);
    expect(ops({ since: clock - 5_000 })).toEqual(["renderer/keydown", "socket/ticket.list"]);
    expect(ops({ process: "renderer" })).toEqual(["renderer/keydown"]);
    expect(ops({ door: "socket" })).toEqual(["socket/ticket.list"]);
    expect(ops({ operation: "ticket.list" })).toEqual(["socket/ticket.list"]);
    expect(ops({ operation: "ipc/volli:board-load" })).toEqual(["ipc/volli:board-load"]);
    expect(ops({ label: "draft-typing" })).toEqual(["renderer/keydown"]);
    for (const version of ["0.3.0", "abc1234", "0.3.0+abc1234"]) {
      expect(ops({ version })).toHaveLength(3);
    }
    expect(ops({ version: "0.2.9" })).toEqual([]);
    expect(ops({}, 1)).toEqual(["renderer/keydown"]);
  });

  it("reads a whole window in chunks, yielding the loop between them", async () => {
    const store = open({ bounds: { maxPending: PERF_READ_CHUNK * 3 } });
    const total = PERF_READ_CHUNK * 2 + 5;
    for (let index = 0; index < total; index += 1) {
      store.record(stall({ at: clock + index, process: index % 2 === 0 ? "main" : "renderer" }));
    }
    const read = async (filter: Parameters<PerfStore["scanStalls"]>[0]) => {
      const chunks: number[] = [];
      let turns = 0;
      const counting = setInterval(() => (turns += 1), 0);
      await store.scanStalls(filter, (rows) => chunks.push(rows.length));
      clearInterval(counting);
      return { chunks, turns };
    };
    const all = await read({});
    // Two full chunks, then the short one: the loop ran between them.
    expect(all.chunks).toEqual([PERF_READ_CHUNK, PERF_READ_CHUNK, 5]);
    expect(all.turns).toBeGreaterThan(0);
    expect((await read({ since: clock + total - 3 })).chunks).toEqual([3]);
    expect((await read({ since: clock + total })).chunks).toEqual([]);
    expect((await read({ process: "renderer" })).chunks).toEqual([PERF_READ_CHUNK, 2]);
  });

  it("reads nothing from an empty store, and stops a read the store's close interrupts", async () => {
    const store = open({ bounds: { maxPending: PERF_READ_CHUNK * 2 } });
    const seen: number[] = [];
    await store.scanStalls({}, (rows) => seen.push(rows.length));
    expect(seen).toEqual([]);
    for (let index = 0; index < PERF_READ_CHUNK + 1; index += 1) store.record(stall());
    store.flush();
    const read = store.scanStalls({}, (rows) => seen.push(rows.length));
    // The first chunk is read before the scan first yields.
    store.close();
    await read;
    expect(seen).toEqual([PERF_READ_CHUNK]);
  });

  it("clips identifiers and floors durations", () => {
    const store = open();
    store.record(stall({ operation: "x".repeat(PERF_FIELD_MAX + 50), durationMs: -3, label: "" }));
    const [row] = store.stalls({});
    expect(row!.operation).toHaveLength(PERF_FIELD_MAX);
    expect(row!.durationMs).toBe(0);
    expect(row!.label).toBeNull();
  });

  it("keeps at most maxRows, dropping the oldest first", () => {
    const store = open({ bounds: { maxRows: 3 } });
    for (let index = 0; index < 5; index += 1) {
      store.record(stall({ at: clock + index, operation: `op-${index}` }));
    }
    store.flush();
    expect(store.stalls({}).map((row) => row.operation)).toEqual(["op-4", "op-3", "op-2"]);
    expect(store.stats()).toMatchObject({ rows: 3, maxRows: 3, oldestAt: clock + 2 });
  });

  it("deletes rows past maxAge, and runs no row needs", () => {
    const old = open({ version: "0.2.0" });
    old.record(stall({ at: clock }));
    old.close();
    clock += PERF_STORE_BOUNDS.maxAgeMs + 1;
    const store = open();
    store.record(stall({ at: clock, operation: "fresh" }));
    expect(store.stalls({}).map((row) => row.operation)).toEqual(["fresh"]);
    expect(store.runs().map((run) => run.version)).toEqual(["0.3.0"]);
  });

  it("applies the age bound at most once per pruneEveryMs", () => {
    const store = open({ bounds: { maxAgeMs: 1_000, pruneEveryMs: 10_000 } });
    store.record(stall({ at: clock, operation: "first" }));
    store.flush();
    clock += 2_000;
    store.record(stall({ at: clock, operation: "second" }));
    // The first is past the age now, but the prune ran at open, under 10 s ago.
    expect(store.stalls({})).toHaveLength(2);
    clock += 10_000;
    expect(store.stalls({}).map((row) => row.operation)).toEqual([]);
  });

  it("counts what the buffer drops once it is full", () => {
    const store = open({ bounds: { maxPending: 2 } });
    for (let index = 0; index < 5; index += 1) store.record(stall());
    expect(store.stats()).toMatchObject({ rows: 2, dropped: 3 });
  });

  it("records one run per open: started, last seen, version and build", () => {
    const first = open({ version: "0.3.0" });
    clock += 30_000;
    first.close();
    clock += 1_000;
    const second = open({ version: "0.3.1" });
    second.setBuild("feature-x");
    clock += 5_000;
    expect(second.runs()).toEqual([
      { startedAt: clock - 36_000, lastSeenAt: clock - 6_000, version: "0.3.0", build: null },
      { startedAt: clock - 5_000, lastSeenAt: clock, version: "0.3.1", build: "feature-x" },
    ]);
  });

  it("refreshes a run's last-seen time on the heartbeat while nothing stalls", () => {
    const first = open();
    clock += PERF_STORE_BOUNDS.heartbeatMs;
    ticks[0]!();
    const second = open({ version: "0.3.1" });
    expect(second.runs()[0]!.lastSeenAt).toBe(clock);
    first.close();
  });

  it("writes what is buffered on close, then ignores everything", () => {
    const store = open();
    store.record(stall());
    store.close();
    store.close();
    store.record(stall());
    store.setBuild("late");
    const reader = open();
    expect(reader.stalls({})).toHaveLength(1);
    expect(reader.runs()[0]!.build).toBeNull();
    expect(ticks).toHaveLength(1);
  });

  it("returns null, logged once, when the file cannot be opened", () => {
    mkdirSync(join(dir, "perf.db"));
    expect(openPerfStore({ path: perfStorePath(dir), version: "0.3.0" })).toBeNull();
    expect(records.filter((record) => record.msg === "perf store unavailable")).toEqual([
      expect.objectContaining({ component: "perf-store", stage: "open" }),
    ]);
  });

  it("defers a write that finds the file locked, never waiting on main's thread", () => {
    const store = open();
    const blocker = new Database(perfStorePath(dir));
    blocker.exec("BEGIN EXCLUSIVE");
    store.record(stall());
    const startedAt = performance.now();
    ticks[0]!();
    ticks[0]!();
    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(
      records.filter((record) => record.msg === "perf store busy: write deferred"),
    ).toHaveLength(1);
    blocker.exec("COMMIT");
    blocker.close();
    expect(store.stalls({})).toHaveLength(1);
  });

  it("stops writing, logged once, when a write fails for good", () => {
    const store = open();
    const vandal = new Database(perfStorePath(dir));
    vandal.exec("DROP TABLE stalls");
    vandal.close();
    store.record(stall());
    store.flush();
    store.record(stall());
    store.flush();
    store.setBuild("ignored");
    expect(records.filter((record) => record.msg === "perf store unavailable")).toEqual([
      expect.objectContaining({ stage: "write" }),
    ]);
  });

  it("logs, and keeps running, when the build label cannot be written", () => {
    const store = open();
    const vandal = new Database(perfStorePath(dir));
    vandal.exec("DROP TABLE runs");
    vandal.close();
    store.setBuild("abc");
    expect(records.some((record) => record.msg === "perf store build label not recorded")).toBe(
      true,
    );
  });
});
