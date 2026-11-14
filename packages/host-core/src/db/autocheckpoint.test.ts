import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { holdAutocheckpoint, WAL_AUTOCHECKPOINT_PAGES } from "./autocheckpoint";

const threshold = (db: Database.Database) => db.pragma("wal_autocheckpoint", { simple: true });

/** Makes `db.pragma` throw SQLITE_BUSY for `source` the next `times` calls. */
function failNext(db: Database.Database, source: string, times: number) {
  const pragma = db.pragma.bind(db);
  let left = times;
  return vi.spyOn(db, "pragma").mockImplementation((text, options) => {
    if (text === source && left > 0) {
      left -= 1;
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }
    return pragma(text, options);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("holdAutocheckpoint", () => {
  it("stops the automatic checkpoint until the last hold is released", () => {
    const db = new Database(":memory:");
    db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    const first = holdAutocheckpoint(db);
    const second = holdAutocheckpoint(db);
    expect(threshold(db)).toBe(0);
    first();
    first();
    expect(threshold(db)).toBe(0);
    second();
    expect(threshold(db)).toBe(WAL_AUTOCHECKPOINT_PAGES);
    const again = holdAutocheckpoint(db);
    expect(threshold(db)).toBe(0);
    again();
    expect(threshold(db)).toBe(WAL_AUTOCHECKPOINT_PAGES);
    db.close();
  });

  it("throws and holds nothing when the pause cannot be set", () => {
    const db = new Database(":memory:");
    db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    failNext(db, "wal_autocheckpoint = 0", 1);
    expect(() => holdAutocheckpoint(db)).toThrow("locked");
    expect(threshold(db)).toBe(WAL_AUTOCHECKPOINT_PAGES);
    // The failed hold left no count behind: the next hold and release work.
    const release = holdAutocheckpoint(db);
    expect(threshold(db)).toBe(0);
    release();
    expect(threshold(db)).toBe(WAL_AUTOCHECKPOINT_PAGES);
    db.close();
  });

  it("retries a failed restore until it takes", () => {
    vi.useFakeTimers();
    const db = new Database(":memory:");
    const release = holdAutocheckpoint(db);
    failNext(db, `wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`, 2);
    expect(release).not.toThrow();
    expect(threshold(db)).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(threshold(db)).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(threshold(db)).toBe(WAL_AUTOCHECKPOINT_PAGES);
    expect(vi.getTimerCount()).toBe(0);
    db.close();
  });

  it("lets a new hold take over a pending restore", () => {
    vi.useFakeTimers();
    const db = new Database(":memory:");
    const first = holdAutocheckpoint(db);
    failNext(db, `wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`, 1);
    first();
    const second = holdAutocheckpoint(db);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(threshold(db)).toBe(0);
    second();
    expect(threshold(db)).toBe(WAL_AUTOCHECKPOINT_PAGES);
    db.close();
  });

  it("stops retrying once the connection has closed", () => {
    vi.useFakeTimers();
    const db = new Database(":memory:");
    const release = holdAutocheckpoint(db);
    failNext(db, `wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`, 1);
    release();
    db.close();
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
