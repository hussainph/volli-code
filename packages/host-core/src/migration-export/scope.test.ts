import Database from "better-sqlite3";
import { expect, it } from "vite-plus/test";
import { selectLocalProduct } from "./scope";

it.each(["id TEXT, session_id TEXT", "session_id TEXT", "other TEXT"])(
  "names orphan rows with %s",
  (columns) => {
    const db = new Database(":memory:");
    try {
      db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE parent(id TEXT PRIMARY KEY);
      CREATE TABLE child(${columns}, parent TEXT REFERENCES parent(id));`);
      db.prepare("INSERT INTO child (parent) VALUES ('missing')").run();
      // The fallback rowid still names a row with no product identity column.
      expect(() => selectLocalProduct(db, {})).toThrow(/orphan child 1: missing parent/);
      if (columns.includes("session_id")) {
        db.exec("UPDATE child SET session_id='session-orphan'");
        expect(() => selectLocalProduct(db, {})).toThrow(/orphan child session-orphan/);
      }
    } finally {
      db.close();
    }
  },
);
it("names FK violations in WITHOUT ROWID tables", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=OFF;CREATE TABLE parent(id TEXT PRIMARY KEY);
    CREATE TABLE child(id TEXT PRIMARY KEY,parent TEXT REFERENCES parent(id)) WITHOUT ROWID;
    INSERT INTO child VALUES ('child','missing');`);
    expect(() => selectLocalProduct(db, {})).toThrow(/orphan child null: missing parent/);
  } finally {
    db.close();
  }
});
