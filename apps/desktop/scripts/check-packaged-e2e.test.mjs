import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { checkPackagedE2e } from "./check-packaged-e2e.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const packagingRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { createPackage } = packagingRequire("@electron/asar");
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const script = join(import.meta.dirname, "check-packaged-e2e.mjs");

function write(path, content = "fixture") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function fixture(t, archivePaths = ["dist-electron/main.cjs", "package.json"]) {
  // Everything, including disposable test artifacts, stays inside the worktree.
  const root = mkdtempSync(join(repositoryRoot, ".packaged-e2e-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  for (const path of archivePaths) write(join(source, path));
  const app = join(root, "Volli Code.app");
  const resources = join(app, "Contents/Resources");
  mkdirSync(resources, { recursive: true });
  const archive = join(resources, "app.asar");
  await createPackage(source, archive);
  write(join(resources, "THIRD-PARTY-NOTICES.txt"));
  write(join(resources, "app.asar.unpacked/node_modules/node-pty/pty.node"));
  return { root, source, app, resources, archive };
}

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("clean actual archive plus unpacked and extra resources passes (also CLI)", async (t) => {
  const { app, resources } = await fixture(t, [
    "dist-electron/main.cjs",
    "package.json",
    "dist/e2e-helper.js",
    "node_modules/not-e2e/index.js",
  ]);
  write(join(resources, "e2e-guide.txt"));
  write(join(resources, "licensing/README.md"));
  const result = checkPackagedE2e(app);
  assert.equal(result.appPath, app);
  assert.equal(result.archives, 1);
  assert.ok(result.archiveEntries >= 4);
  assert.ok(result.looseEntries >= 5);
  const outcome = run("--app", app);
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /check-packaged-e2e: OK/);
});

for (const path of [
  "e2e/volli-drive/lib/fake-provider.mjs",
  "apps/desktop/e2e/volli-drive/lib/sshd-fixture.mjs",
  "node_modules/kept/e2e/fixture.json",
  "dist/E2E/fixture.json",
  "dist/e2e",
]) {
  test(`rejects planted archive path ${path}`, async (t) => {
    const { app } = await fixture(t, ["package.json", path]);
    assert.throws(
      () => checkPackagedE2e(app),
      (error) => {
        assert.match(error.message, /forbidden e2e paths/);
        assert.ok(error.message.includes(`app.asar:/${path}`), error.message);
        return true;
      },
    );
    const outcome = run("--app", app);
    assert.equal(outcome.status, 1);
    assert.match(outcome.stderr, /forbidden e2e paths/);
  });
}

for (const path of [
  "e2e/volli-drive/lib/fake-provider.mjs",
  "fixtures/e2e/volli-drive/lib/sshd-fixture.mjs",
  "app.asar.unpacked/node_modules/kept/e2e/fixture.json",
  "E2E/fixture.json",
  "e2e",
]) {
  test(`rejects planted loose resource path ${path}`, async (t) => {
    const { app, resources } = await fixture(t);
    write(join(resources, path));
    assert.throws(
      () => checkPackagedE2e(app),
      (error) => {
        assert.match(error.message, /forbidden e2e paths/);
        assert.ok(error.message.includes(`Contents/Resources/${path}`), error.message);
        return true;
      },
    );
  });
}

test("rejects an empty e2e directory even without files", async (t) => {
  const { app, resources } = await fixture(t);
  mkdirSync(join(resources, "e2e"));
  assert.throws(() => checkPackagedE2e(app), /Contents\/Resources\/e2e/);
});

test("checks loose paths outside Resources too", async (t) => {
  const { app } = await fixture(t);
  write(join(app, "Contents/e2e/fake-provider.mjs"));
  assert.throws(() => checkPackagedE2e(app), /Contents\/e2e/);
});

test("checks additional resource archives, not just app.asar", async (t) => {
  const { app, root, resources } = await fixture(t);
  const source = join(root, "extra-source");
  write(join(source, "e2e/sshd-fixture.mjs"));
  await createPackage(source, join(resources, "extra.asar"));
  assert.throws(() => checkPackagedE2e(app), /extra\.asar:\/e2e/);
});

test("checks symlink names and targets without following framework cycles", async (t) => {
  const { app, resources } = await fixture(t);
  symlinkSync(".", join(resources, "cycle"));
  assert.equal(checkPackagedE2e(app).archives, 1);
  symlinkSync("e2e/fake-provider.mjs", join(resources, "provider"));
  assert.throws(() => checkPackagedE2e(app), /provider -> e2e\/fake-provider\.mjs/);
  rmSync(join(resources, "provider"));
  symlinkSync("THIRD-PARTY-NOTICES.txt", join(resources, "e2e"));
  assert.throws(() => checkPackagedE2e(app), /Contents\/Resources\/e2e/);
});

test("missing app fails rather than reporting an empty clean scan", async (t) => {
  const { app, root } = await fixture(t);
  const missing = join(root, "missing.app");
  assert.throws(() => checkPackagedE2e(missing), /ENOENT/);
  const outcome = run("--app", missing);
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /ENOENT/);
  rmSync(app, { recursive: true });
});

test("missing app.asar fails even if loose resources are clean", async (t) => {
  const { app, archive } = await fixture(t);
  rmSync(archive);
  assert.throws(() => checkPackagedE2e(app), /ENOENT/);
  assert.equal(run("--app", app).status, 1);
});

test("a file in place of the app or a directory in place of app.asar fails", async (t) => {
  const { app, archive, root } = await fixture(t);
  const notApp = join(root, "not.app");
  write(notApp);
  assert.throws(() => checkPackagedE2e(notApp), /not a directory/);
  rmSync(archive);
  mkdirSync(archive);
  assert.throws(() => checkPackagedE2e(app), /archive is not a file/);
});

test("corrupt archive fails closed", async (t) => {
  const { app, archive } = await fixture(t);
  writeFileSync(archive, "not an asar archive");
  assert.throws(() => checkPackagedE2e(app));
  assert.equal(run("--app", app).status, 1);
});

for (const args of [["--app"], ["--dir", "."], ["--app", ".", "ignored"]]) {
  test(`CLI rejects malformed arguments ${args.join(" ")}`, () => {
    const outcome = run(...args);
    assert.equal(outcome.status, 1);
    assert.match(outcome.stderr, /Usage:/);
  });
}
