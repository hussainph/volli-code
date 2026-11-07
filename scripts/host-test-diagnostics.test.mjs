import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = join(root, "packages/host-core");
const preload = join(root, "scripts/host-test-diagnostics.cjs");

function fixture(t, source, { enabled = true, cwd = host } = {}) {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const temporary = mkdtempSync(join(root, ".tmp/host-test-diagnostics-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const output = join(temporary, "events");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require="${preload}"`,
      VOLLI_HOST_TEST_DIAGNOSTICS: enabled ? output : "",
      VOLLI_DIAGNOSTIC_SENTINEL: "not-for-diagnostics",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.ifError(result.error);
  const files = readdirSync(temporary, { recursive: true });
  const events = files
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      readFileSync(join(temporary, file), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  return { result, events, files, temporary };
}

test("the preload is inert when disabled or outside host-core", (t) => {
  for (const options of [{ enabled: false }, { cwd: root }]) {
    const { result, events, files } = fixture(t, "process.exitCode = 7", options);
    assert.equal(result.status, 7);
    assert.deepEqual(events, []);
    assert.deepEqual(files, []);
  }
});

test("records synchronous active-test breadcrumbs, memory, and a real fork exit signal", (t) => {
  const { result, events } = fixture(
    t,
    `
      import { channel } from 'node:diagnostics_channel';
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      const diagnostic = channel('volli.host-core.test');
      const identity = { id: 'test-1', file: 'fixture.test.ts', name: 'signal case' };
      diagnostic.publish({ event: 'test-start', ...identity });
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      await once(child, 'spawn');
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await exit;
      diagnostic.publish({ event: 'test-finished', ...identity });
    `,
  );
  assert.equal(result.status, 0, result.stderr);
  const start = events.find((event) => event.event === "child-start");
  const exit = events.find((event) => event.event === "child-exit");
  assert.equal(exit.childPid, start.childPid);
  assert.equal(exit.childId, start.childId);
  assert.equal(exit.code, null);
  assert.equal(exit.signal, "SIGTERM");
  assert.deepEqual(exit.active, [{ id: "test-1", file: "fixture.test.ts", name: "signal case" }]);
  assert.ok(exit.memory.rss > 0);
  assert.ok(exit.memory.heapUsed > 0);
  assert.equal(typeof exit.availableMemory, "number");
  assert.ok(events.find((event) => event.event === "process-start").cgroup["memory.events"]);
  assert.deepEqual(events.find((event) => event.event === "process-exit").active, []);
  assert.doesNotMatch(JSON.stringify(events), /not-for-diagnostics|NODE_OPTIONS|setInterval/);
});

test("attributes distinct spawn failures even when no child PID exists", (t) => {
  const { result, events } = fixture(
    t,
    `
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      for (let attempt = 0; attempt < 2; attempt++) {
        const child = spawn('/volli-diagnostic-fixture-does-not-exist');
        await once(child, 'error');
      }
    `,
  );
  assert.equal(result.status, 0, result.stderr);
  const errors = events.filter((event) => event.event === "child-error");
  assert.equal(errors.length, 2);
  assert.ok(errors.every((event) => event.errorCode === "ENOENT" && event.childPid === undefined));
  assert.notEqual(errors[0].childId, errors[1].childId);
});

test("every restore lifecycle marker published by the suite reaches the retained JSONL", (t) => {
  const source = readFileSync(join(host, "src/backup/restore-surface.test.ts"), "utf8");
  const markers = [...source.matchAll(/event: ["'](restore-[^"']+)["']/gu)].map((match) => match[1]);
  assert.equal(markers.length, 5, "keep each crash/cancellation boundary observable");
  const { result, events } = fixture(
    t,
    `
      import { channel } from 'node:diagnostics_channel';
      const diagnostic = channel('volli.host-core.test');
      for (const event of ${JSON.stringify(markers)}) diagnostic.publish({ event });
    `,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    events.filter((event) => event.event.startsWith("restore-")).map((event) => event.event),
    markers,
  );
});

test("observes real worker termination without changing its exit code", (t) => {
  const { result, events } = fixture(
    t,
    `
      import { Worker } from 'node:worker_threads';
      import { once } from 'node:events';
      const worker = new Worker('setInterval(() => {}, 1000)', { eval: true, execArgv: [] });
      await once(worker, 'online');
      if (await worker.terminate() !== 1) throw new Error('wrong termination code');
    `,
  );
  assert.equal(result.status, 0, result.stderr);
  const start = events.find((event) => event.event === "worker-start");
  const exit = events.find((event) => event.event === "worker-exit");
  assert.ok(start.workerThreadId > 0);
  assert.equal(exit.workerThreadId, start.workerThreadId);
  assert.equal(exit.code, 1);
  assert.ok(events.some((event) => event.event === "worker-online"));
});

test("monitoring does not consume an unhandled worker error or turn a failure green", (t) => {
  const { result, events } = fixture(
    t,
    `
      import { Worker } from 'node:worker_threads';
      new Worker('throw new Error("fixture failure")', { eval: true, execArgv: [] });
    `,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixture failure/);
  assert.ok(events.some((event) => event.event === "worker-error"));
  assert.ok(events.some((event) => event.event === "uncaught-exception"));
});

test("metadata is allowlisted; no environment, argv, worker payloads, or full reports are collected", (t) => {
  const { result, events, files } = fixture(
    t,
    `
    import { channel } from 'node:diagnostics_channel';
    const diagnostic = channel('volli.host-core.test');
    diagnostic.publish({ event: 'unrecognized-sensitive-event', name: 'not-for-diagnostics' });
    diagnostic.publish({ event: 'restore-cancel-request', argv: ['not-for-diagnostics'],
      environmentVariables: { token: 'not-for-diagnostics' }, workerData: 'not-for-diagnostics' });
    if (process.report.reportOnFatalError) throw new Error('full reports must not be enabled');
  `,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(events.some((event) => event.event === "restore-cancel-request"));
  assert.doesNotMatch(JSON.stringify(events), /not-for-diagnostics|unrecognized-sensitive-event/);
  assert.ok(files.every((file) => file === "events" || file.endsWith(".jsonl")));
  const start = events.find((event) => event.event === "process-start");
  assert.deepEqual(Object.keys(start.versions).sort(), ["modules", "napi", "node", "uv", "v8"]);
  assert.deepEqual(Object.keys(start.memory).sort(), [
    "arrayBuffers",
    "external",
    "heapTotal",
    "heapUsed",
    "rss",
  ]);
});
