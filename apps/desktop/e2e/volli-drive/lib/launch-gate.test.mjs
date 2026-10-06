/**
 * Packed mode is disabled, and no launch path skips the one gate
 * (`assertLaunchable`). Nothing here builds or launches anything: refused
 * launches exit before a build, a reservation or a spawn.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DRIVE = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(DRIVE, "cli.mjs");
const read = (name) => readFileSync(join(DRIVE, name), "utf8");

let root;
before(() => {
  root = mkdtempSync(join(os.tmpdir(), "volli-drive-gate-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("packed mode", () => {
  for (const args of [
    ["--build", "packed"],
    ["--build", "packed", "--app", "/Applications/Volli Code.app/Contents/MacOS/Volli Code"],
    ["--app", "/Applications/Volli Code.app/Contents/MacOS/Volli Code"],
  ]) {
    it(`refuses launch ${args.join(" ")} before building, reserving or spawning`, async () => {
      const home = join(root, `home-${args.length}`);
      const evidence = join(root, `evidence-${args.length}`);
      const result = await execFileAsync(process.execPath, [CLI, "launch", ...args], {
        env: { ...process.env, VOLLI_DRIVE_HOME: home, VOLLI_DRIVE_EVIDENCE: evidence },
      }).catch((error) => error);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /not yet safe; dev builds only/);
      assert.equal(existsSync(join(home, "instances")), false, "no slot was reserved");
      assert.equal(existsSync(evidence), false, "no evidence dir, so no supervisor");
    });
  }

  it("is not offered by help", async () => {
    const { stdout } = await execFileAsync(process.execPath, [CLI, "help"]);
    assert.doesNotMatch(stdout, /--build dev\|packed|--app </);
  });
});

describe("every launch path goes through assertLaunchable", () => {
  it("the supervisor calls it immediately before its one Electron launch", () => {
    const source = read("supervisor.mjs");
    const launches = [...source.matchAll(/\bawait launch\(/g)];
    assert.equal(launches.length, 1, "exactly one Electron launch");
    const lineStart = source.lastIndexOf("\n", launches[0].index);
    const before = source.slice(0, lineStart).trimEnd().split("\n");
    assert.equal(before.at(-1).trim(), "assertLaunchable(spec);");
    // And at the top of boot, before the provider or the environment.
    const boot = source.slice(source.indexOf("async function boot()"));
    assert.ok(boot.indexOf("assertLaunchable(spec)") < boot.indexOf("startFakeProvider"));
  });

  it("the CLI calls it before it reserves a slot or spawns a supervisor", () => {
    const source = read("cli.mjs");
    const launchFn = source.slice(source.indexOf("async function launch("));
    const gate = launchFn.indexOf("assertLaunchable(spec)");
    assert.ok(gate > 0);
    assert.ok(gate < launchFn.indexOf("registry.reserve("));
    assert.ok(gate < launchFn.indexOf("spawn("));
  });

  it("nothing in volli-drive can point smoke-kit at a packed app", () => {
    for (const name of [
      "cli.mjs",
      "supervisor.mjs",
      ...readdirSync(join(DRIVE, "lib"))
        .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
        .map((f) => join("lib", f)),
    ]) {
      const source = read(name);
      assert.doesNotMatch(source, /VOLLI_SMOKE_APP_BINARY\s*=/, name);
      assert.doesNotMatch(source, /executablePath/, name);
    }
  });
});
