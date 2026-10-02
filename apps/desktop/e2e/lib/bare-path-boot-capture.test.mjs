import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import capture from "./bare-path-boot-capture.cjs";

const { installBootCapture, readBootCapture, wrapperGenerationOutcome, WRAPPER_READY_MARKER } =
  capture;
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const callback = () => {};

function fixture(t, directory) {
  if (directory === undefined) {
    const root = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
    mkdirSync(root, { recursive: true });
    directory = mkdtempSync(join(root, "bare-path-capture-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
  }
  const app = new EventEmitter();
  const forwarded = [];
  const stream = (name) => ({
    write(...args) {
      forwarded.push({ name, receiver: this, args });
      return false;
    },
  });
  const stdout = stream("stdout");
  const stderr = stream("stderr");
  const restore = installBootCapture({ directory, app, stdout, stderr, initialPath: BARE_PATH });
  t.after(restore);
  return { app, stdout, stderr, forwarded, directory, read: () => readBootCapture(directory) };
}

test("readiness emitted before a late Playwright listener is retained", (t) => {
  const run = fixture(t);
  run.app.emit("browser-window-created");
  run.stdout.write(`${WRAPPER_READY_MARKER}\n`);
  // launch() has not returned yet. A listener installed now has no old bytes.
  const lateListenerOutput = "";
  assert.equal(wrapperGenerationOutcome({ stdout: lateListenerOutput, stderr: "" }), null);
  assert.deepEqual(wrapperGenerationOutcome(run.read()), { kind: "ready" });
  assert.equal(run.read().initialPath, BARE_PATH);
});

test("post-window PATH evidence uses the actual window event, not client attachment", (t) => {
  const run = fixture(t);
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

test("split markers survive interleaved descriptors and failure always wins", (t) => {
  const run = fixture(t);
  run.stdout.write("[volli] harness runtime ");
  run.stderr.write("[volli] failed to generate harness ");
  assert.equal(wrapperGenerationOutcome(run.read()), null);
  run.stdout.write("ready\n");
  run.stderr.write("wrappers: genuine write error\n");
  assert.deepEqual(wrapperGenerationOutcome(run.read()), {
    kind: "failed",
    offending: "[volli] failed to generate harness wrappers: genuine write error",
  });
});

test("early wrapper failures cannot disappear before client attachment", (t) => {
  const run = fixture(t);
  run.stderr.write("[volli] failed to generate harness wrappers: refused symlink\n");
  assert.deepEqual(wrapperGenerationOutcome(run.read()), {
    kind: "failed",
    offending: "[volli] failed to generate harness wrappers: refused symlink",
  });
});

test("a pending or failed upstream boot never manufactures readiness", (t) => {
  const run = fixture(t);
  assert.equal(wrapperGenerationOutcome(run.read()), null);
  run.stderr.write("[volli] failed to generate CLI shim: disk error\n");
  assert.equal(wrapperGenerationOutcome(run.read()), null);
});

test("capture forwards the original write arguments, receiver, callback and backpressure", (t) => {
  const run = fixture(t);
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

test("a new capture cannot inherit a prior launch's ready marker", (t) => {
  const first = fixture(t);
  first.stdout.write(`${WRAPPER_READY_MARKER}\n`);
  const next = fixture(t, first.directory);
  assert.equal(wrapperGenerationOutcome(next.read()), null);
});
