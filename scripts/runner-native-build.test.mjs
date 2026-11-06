import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { rebuildSqlite } from "../apps/runner/scripts/rebuild-sqlite.mjs";

function fixture(t, arch = "x64") {
  const scratch = fileURLToPath(new URL("../.tmp/", import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "runner-native-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "prebuilds"));
  const prebuild = join(root, "prebuilds", `linux-${arch}.node`);
  writeFileSync(prebuild, "upstream prebuild needs newer glibc");
  const storeReference = join(root, "store-reference.node");
  linkSync(prebuild, storeReference);
  return { root, prebuild, storeReference };
}

for (const arch of ["x64", "arm64"]) {
  test(`SQLite ${arch} replacement uses a forced release build and preserves store links`, (t) => {
    const f = fixture(t, arch);
    let builds = 0;
    // Simulated compiler seam. Actual compilation and ABI verification run in
    // the bullseye release container; these tests prove filesystem handoff.
    const execute = (command, args, options) => {
      builds++;
      assert.equal(command, "npm");
      assert.deepEqual(args, ["run", "build-release"]);
      assert.deepEqual(options, { cwd: f.root, stdio: "inherit" });
      mkdirSync(join(f.root, "build", "Release"), { recursive: true });
      writeFileSync(
        join(f.root, "build", "Release", "better_sqlite3.node"),
        "rebuilt on the baseline",
      );
    };
    rebuildSqlite(f.root, arch, execute);
    assert.equal(builds, 1);
    assert.equal(readFileSync(f.prebuild, "utf8"), "rebuilt on the baseline");
    assert.equal(readFileSync(f.storeReference, "utf8"), "upstream prebuild needs newer glibc");
    assert.equal(existsSync(join(f.root, "build")), false);
    assert.equal(
      readdirSync(f.root).some((name) => name.startsWith(".runner-sqlite-")),
      false,
    );
  });
}

test("SQLite compiler failure never replaces a prebuild", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      rebuildSqlite(f.root, "x64", () => {
        throw new Error("compiler failed");
      }),
    /compiler failed/,
  );
  assert.equal(readFileSync(f.prebuild, "utf8"), "upstream prebuild needs newer glibc");
});

test("SQLite missing compiler output fails closed and removes staging", (t) => {
  const f = fixture(t);
  assert.throws(() => rebuildSqlite(f.root, "x64", () => {}), /ENOENT/);
  assert.equal(readFileSync(f.prebuild, "utf8"), "upstream prebuild needs newer glibc");
  assert.equal(
    readdirSync(f.root).some((name) => name.startsWith(".runner-sqlite-")),
    false,
  );
});

test("SQLite unsupported architectures never invoke a compiler", (t) => {
  const f = fixture(t);
  assert.throws(
    () => rebuildSqlite(f.root, "armv7", () => assert.fail("unexpected compiler")),
    /Unsupported SQLite arch/,
  );
});
