import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { REPO } from "./smoke-kit.mjs";
import { installShutdownTrace, sampleStalledClose, traceClose } from "./shutdown-trace.mjs";

test("unset smoke trace performs no evaluation, file IO or sampling timer", async (t) => {
  const app = {
    evaluate: () => {
      throw new Error("unexpected main evaluation");
    },
  };
  t.mock.method(globalThis, "setTimeout", () => {
    throw new Error("unexpected sampling timer");
  });
  traceClose(null, "quit-requested");
  await installShutdownTrace(app, null);
  await sampleStalledClose({}, null)();
});

test("smoke-side breadcrumbs distinguish native exit return from observed child exit", async (t) => {
  await fs.mkdir(join(REPO, ".tmp"), { recursive: true });
  const scratch = await fs.mkdtemp(join(REPO, ".tmp", "shutdown-trace-test-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "trace.jsonl");
  const listeners = new Map();
  let exitListener;
  const originalOn = process.on;
  t.mock.method(process, "on", function (event, listener) {
    if (event !== "exit") return originalOn.call(this, event, listener);
    exitListener = listener;
    return this;
  });
  let exitCode;
  const electronApp = {
    on(event, listener) {
      listeners.set(event, listener);
    },
    exit(code) {
      assert.equal(this, electronApp);
      exitCode = code;
      return "returned";
    },
  };
  await installShutdownTrace({ evaluate: (fn, arg) => fn({ app: electronApp }, arg) }, path);
  traceClose(path, "quit-requested");
  listeners.get("before-quit")();
  assert.equal(electronApp.exit(0), "returned");
  assert.equal(exitCode, 0);
  exitListener();
  listeners.get("quit")();
  traceClose(path, "child-exit", { code: 0, signal: null });
  const entries = (await fs.readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    entries.map((entry) => entry.stage),
    [
      "quit-requested",
      "before-quit",
      "native-exit-started",
      "native-exit-returned",
      "process-exit",
      "quit",
      "child-exit",
    ],
  );
  assert.ok(entries.every((entry) => Number.isInteger(entry.at) && entry.pid === process.pid));
  assert.equal(entries.at(-1).code, 0);
});

test("a failed diagnostic write never prevents the original native exit", async (t) => {
  await fs.mkdir(join(REPO, ".tmp"), { recursive: true });
  const scratch = await fs.mkdtemp(join(REPO, ".tmp", "shutdown-trace-test-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "missing", "trace.jsonl");
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  const originalOn = process.on;
  t.mock.method(process, "on", function (event, listener) {
    return event === "exit" ? this : originalOn.call(this, event, listener);
  });
  let originalExitCalled = false;
  const electronApp = {
    on() {},
    exit(code) {
      originalExitCalled = true;
      assert.equal(code, 0);
      return "returned";
    },
  };
  traceClose(path, "quit-requested");
  await installShutdownTrace({ evaluate: (fn, arg) => fn({ app: electronApp }, arg) }, path);
  assert.equal(electronApp.exit(0), "returned");
  assert.equal(originalExitCalled, true);
  assert.equal(errors.length, 3);
});

test("diagnostic evaluation rejection or timeout cannot fail a launch", async (t) => {
  await fs.mkdir(join(REPO, ".tmp"), { recursive: true });
  const scratch = await fs.mkdtemp(join(REPO, ".tmp", "shutdown-trace-test-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "trace.jsonl");
  await assert.doesNotReject(
    installShutdownTrace(
      {
        evaluate: async () => {
          throw new Error("evaluation unavailable");
        },
      },
      path,
    ),
  );
  await assert.doesNotReject(
    installShutdownTrace(
      {
        evaluate: () => new Promise(() => {}),
      },
      path,
      { timeoutMs: 1 },
    ),
  );
  const entries = (await fs.readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    entries.map(({ stage }) => stage),
    ["trace-install-failed", "trace-install-failed"],
  );
  assert.match(entries[0].error, /evaluation unavailable/);
  assert.match(entries[1].error, /deadline/);
});

test("sampling failure and an unwritable trace cannot reject cleanup", async (t) => {
  await fs.mkdir(join(REPO, ".tmp"), { recursive: true });
  const scratch = await fs.mkdtemp(join(REPO, ".tmp", "shutdown-trace-test-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  let trigger;
  t.mock.method(globalThis, "setTimeout", (fn) => {
    trigger = fn;
    return 1;
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  const finish = sampleStalledClose(
    { pid: 42, exitCode: null, signalCode: null },
    join(scratch, "missing", "trace.jsonl"),
    {
      platform: "darwin",
      runCommand: async () => {
        throw new Error("process inspection failed");
      },
    },
  );
  trigger();
  await assert.doesNotReject(finish());
  assert.equal(errors.length, 1);
});
