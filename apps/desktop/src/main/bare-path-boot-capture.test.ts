import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vite-plus/test";
import { fileURLToPath } from "node:url";

import {
  isSmokeBootCapture,
  installBootCapture,
  installSmokeBootCapture,
  readBootCapture,
  wrapperGenerationOutcome,
  WRAPPER_READY_MARKER,
} from "./bare-path-boot-capture";
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const callback = () => {};
const ordinaryWrite = (): boolean => false;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) dispose();
});

function fixture(directory?: string) {
  if (directory === undefined) {
    const root = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
    mkdirSync(root, { recursive: true });
    directory = mkdtempSync(join(root, "bare-path-capture-test-"));
    const ownedDirectory = directory;
    cleanup.push(() => rmSync(ownedDirectory, { recursive: true, force: true }));
  }
  const app = new EventEmitter();
  const captureDirectory = directory;
  const forwarded: { name: string; receiver: unknown; args: unknown[] }[] = [];
  const stream = (name: string): Pick<NodeJS.WritableStream, "write"> => ({
    write(...args: unknown[]) {
      forwarded.push({ name, receiver: this, args });
      return false;
    },
  });
  const stdout = stream("stdout");
  const stderr = stream("stderr");
  const restore = installBootCapture({ directory, app, stdout, stderr, initialPath: BARE_PATH });
  cleanup.push(restore);
  return {
    app,
    stdout,
    stderr,
    forwarded,
    directory,
    read: () => readBootCapture(captureDirectory),
  };
}

test("readiness emitted before a late Playwright listener is retained", () => {
  const run = fixture();
  run.app.emit("browser-window-created");
  run.stdout.write(`${WRAPPER_READY_MARKER}\n`);
  // launch() has not returned yet. A listener installed now has no old bytes.
  const lateListenerOutput = "";
  assert.equal(wrapperGenerationOutcome({ stdout: lateListenerOutput, stderr: "" }), null);
  assert.deepEqual(wrapperGenerationOutcome(run.read()), { kind: "ready" });
  assert.equal(run.read().initialPath, BARE_PATH);
});

test("post-window PATH evidence uses the actual window event, not client attachment", () => {
  const run = fixture();
  run.stdout.write("[volli] PATH kept (too early)\n");
  run.stderr.write("before-window\n");
  assert.equal(run.read().postWindowStdout, "");
  assert.equal(run.read().postWindowStderr, "");
  run.app.emit("browser-window-created");
  run.stdout.write("[volli] PATH adopted from login shell (4 entries)\n");
  run.stderr.write("after-window\n");
  assert.equal(run.read().postWindowStdout, "[volli] PATH adopted from login shell (4 entries)\n");
  assert.equal(run.read().postWindowStderr, "after-window\n");
  assert.match(run.read().stdout, /too early/);
});

test("split markers survive interleaved descriptors and failure always wins", () => {
  const run = fixture();
  run.stdout.write("[desktop] harness runtime ");
  run.stderr.write("[desktop] failed to generate harness ");
  assert.equal(wrapperGenerationOutcome(run.read()), null);
  run.stdout.write("ready\n");
  run.stderr.write("wrappers: genuine write error\n");
  assert.deepEqual(wrapperGenerationOutcome(run.read()), {
    kind: "failed",
    offending: "[desktop] failed to generate harness wrappers: genuine write error",
  });
});

test("early wrapper failures cannot disappear before client attachment", () => {
  const run = fixture();
  run.stderr.write("[desktop] failed to generate harness wrappers: refused symlink\n");
  assert.deepEqual(wrapperGenerationOutcome(run.read()), {
    kind: "failed",
    offending: "[desktop] failed to generate harness wrappers: refused symlink",
  });
});

test("a pending or failed upstream boot never manufactures readiness", () => {
  const run = fixture();
  assert.equal(wrapperGenerationOutcome(run.read()), null);
  run.stderr.write("[volli] failed to generate CLI shim: disk error\n");
  assert.equal(wrapperGenerationOutcome(run.read()), null);
});

test("capture forwards the original write arguments, receiver, callback and backpressure", () => {
  const run = fixture();
  const bytes = Buffer.from("π");
  assert.equal(run.stdout.write(bytes.subarray(0, 1), callback), false);
  assert.equal(run.stdout.write(bytes.subarray(1), callback), false);
  assert.equal(run.stderr.write("hex", "utf8", callback), false);
  assert.equal(run.read().stdout, "π");
  assert.equal(run.read().stderr, "hex");
  assert.equal(run.forwarded[0].receiver, run.stdout);
  assert.deepEqual(run.forwarded[0].args, [bytes.subarray(0, 1), callback]);
  assert.deepEqual(run.forwarded[2].args, ["hex", "utf8", callback]);
});

test("a new capture cannot inherit a prior launch's ready marker", () => {
  const first = fixture();
  first.stdout.write(`${WRAPPER_READY_MARKER}\n`);
  const next = fixture(first.directory);
  assert.equal(wrapperGenerationOutcome(next.read()), null);
});

test("ordinary launches do not patch streams or install a window listener", () => {
  const app = new EventEmitter();
  const stdout = { write: ordinaryWrite };
  const stderr = { write: ordinaryWrite };
  installSmokeBootCapture({ PATH: BARE_PATH }, app, stdout, stderr);
  assert.equal(stdout.write, ordinaryWrite);
  assert.equal(stderr.write, ordinaryWrite);
  assert.equal(app.listenerCount("browser-window-created"), 0);
});

test("restoring capture removes the window listener and original writes", () => {
  const run = fixture();
  const originalWrite = run.stdout.write;
  const restore = installBootCapture({
    directory: run.directory,
    app: run.app,
    stdout: run.stdout,
    stderr: run.stderr,
    initialPath: BARE_PATH,
  });
  restore();
  assert.equal(run.stdout.write, originalWrite);
  assert.equal(run.app.listenerCount("browser-window-created"), 1);
});

test("a smoke's capture is named by its directory variable", () => {
  assert.equal(isSmokeBootCapture({ VOLLI_BARE_PATH_CAPTURE_DIR: "/tmp/x" }), true);
  assert.equal(isSmokeBootCapture({}), false);
});
