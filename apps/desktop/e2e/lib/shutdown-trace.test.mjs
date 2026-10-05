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
      "native-exit-started-after-drain",
      "native-exit-returned",
      "process-exit",
      "quit",
      "child-exit",
    ],
  );
  assert.ok(entries.every((entry) => Number.isInteger(entry.at) && entry.pid === process.pid));
  assert.equal(entries.at(-1).code, 0);
});
