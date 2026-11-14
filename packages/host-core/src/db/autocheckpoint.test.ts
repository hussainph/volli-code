import Database from "better-sqlite3";
import { describe, expect, it } from "vite-plus/test";
import { holdAutocheckpoint, WAL_AUTOCHECKPOINT_PAGES } from "./autocheckpoint";

const threshold = (db: Database.Database) => db.pragma("wal_autocheckpoint", { simple: true });

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

  it("releases quietly once the connection has closed", () => {
    const db = new Database(":memory:");
    const release = holdAutocheckpoint(db);
    db.close();
    expect(release).not.toThrow();
  });
});
