import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isUpdatingPage, seedDatabase, seedDatabaseProblems } from "./seed-database.mjs";

const HEADER = Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(84)]);

test("a closed database seeds an instance; anything else is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vd-seed-"));
  try {
    const db = join(dir, "volli.db.backup-v68");
    await writeFile(db, HEADER);
    assert.deepEqual(await seedDatabaseProblems(db), []);
    assert.match((await seedDatabaseProblems("relative.db"))[0], /absolute/);
    assert.match((await seedDatabaseProblems(join(dir, "missing")))[0], /not a regular file/);
    const text = join(dir, "notes.txt");
    await writeFile(text, "hello");
    assert.match((await seedDatabaseProblems(text))[0], /not a SQLite database/);
    await writeFile(`${db}-wal`, "frames");
    assert.match((await seedDatabaseProblems(db))[0], /-wal holds data/);
    await writeFile(`${db}-wal`, "");
    assert.deepEqual(await seedDatabaseProblems(db), []);

    const target = join(dir, "seeded.db");
    await seedDatabase(db, target);
    assert.deepEqual(await readFile(target), HEADER);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const copied = join(dir, "copied.db");
    await seedDatabase(db, copied, "linux");
    assert.deepEqual(await readFile(copied), HEADER);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only the upgrade page is the upgrade page", () => {
  assert.equal(isUpdatingPage("volli-app://bundle/updating.html?appearance=dark"), true);
  assert.equal(isUpdatingPage("http://localhost:5173/updating.html"), true);
  assert.equal(isUpdatingPage("volli-app://bundle/index.html"), false);
  assert.equal(isUpdatingPage("about:blank"), false);
  assert.equal(isUpdatingPage("not a url"), false);
});
