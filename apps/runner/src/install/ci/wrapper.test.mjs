import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const entry of ["release", "current", "absolute-bin-link", "relative-bin-link"]) {
  test(`fixture wrapper resolves ${entry} and preserves arguments and exit codes`, () => {
    const root = mkdtempSync(join(tmpdir(), "volli installer wrapper "));
    roots.push(root);
    const release = join(root, "releases", "fixture release");
    mkdirSync(join(release, "bin"), { recursive: true });
    mkdirSync(join(release, "lib/runner"), { recursive: true });
    copyFileSync(join(import.meta.dirname, "wrapper.sh"), join(release, "bin/volli-runner"));
    symlinkSync(process.execPath, join(release, "bin/node"));
    writeFileSync(
      join(release, "lib/install-runtime-fixture.mjs"),
      'console.log(JSON.stringify({route:"fixture", args:process.argv.slice(2)}));',
    );
    writeFileSync(
      join(release, "lib/runner/runner.cjs"),
      'console.log(JSON.stringify({route:"real-cli", args:process.argv.slice(2)})); process.exit(3);',
    );
    symlinkSync("releases/fixture release", join(root, "current"));
    mkdirSync(join(root, "published bin"));
    const published = join(root, "published bin/volli-runner");
    symlinkSync(
      entry === "relative-bin-link"
        ? "../current/bin/volli-runner"
        : join(root, "current/bin/volli-runner"),
      published,
    );
    const cli =
      entry === "release"
        ? join(release, "bin/volli-runner")
        : entry === "current"
          ? join(root, "current/bin/volli-runner")
          : published;
    for (const [command, route, status] of [
      ["run", "fixture", 0],
      ["status", "real-cli", 3],
    ]) {
      const args = [command, "--data-dir", join(root, "private data"), "literal $value %20"];
      const result = spawnSync("sh", [cli, ...args], { encoding: "utf8", cwd: root });
      assert.equal(result.error, undefined);
      assert.equal(result.status, status, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { route, args });
    }
  });
}
