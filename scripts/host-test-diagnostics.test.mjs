import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";

const { createBoundedCapture } = createRequire(import.meta.url)("./bounded-test-capture.cjs");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = join(root, "packages/host-core");
const preload = join(root, "scripts/host-test-diagnostics.cjs");

function temporaryRoot(t) {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const temporary = mkdtempSync(join(root, ".tmp/host-test-diagnostics-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  return temporary;
}

function fixture(t, source, { enabled = true, cwd = host } = {}) {
  const temporary = temporaryRoot(t);
  const output = join(temporary, "events");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require="${preload}"`,
      VOLLI_TEST_DIAGNOSTICS: enabled ? output : "",
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

test("the same preload and active-test vocabulary cover desktop fork processes", (t) => {
  const config = readFileSync(join(root, "apps/desktop/vite.config.ts"), "utf8");
  assert.ok(config.includes('setupFiles: [...diagnosticSetup, "test-setup.ts"]'));
  assert.ok(config.includes('setupFiles: [...diagnosticSetup, "src/main/test-setup.ts"]'));
  assert.ok(config.includes("../../scripts/test-active-diagnostics.ts"));
  const { result, events } = fixture(
    t,
    `
    import { channel } from 'node:diagnostics_channel';
    channel('volli.test').publish({ event: 'test-start', id: 'desktop-test',
      file: 'desktop-fixture.test.ts', name: 'desktop active test' });
  `,
    { cwd: join(root, "apps/desktop") },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events.find((event) => event.event === "process-exit").active, [
    { id: "desktop-test", file: "desktop-fixture.test.ts", name: "desktop active test" },
  ]);
});

test("records synchronous active-test breadcrumbs, memory, and a real fork exit signal", (t) => {
  const { result, events } = fixture(
    t,
    `
      import { channel } from 'node:diagnostics_channel';
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      const diagnostic = channel('volli.test');
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
  const markers = [...source.matchAll(/event: ["'](restore-[^"']+)["']/gu)].map(
    (match) => match[1],
  );
  assert.equal(markers.length, 5, "keep each crash/cancellation boundary observable");
  const { result, events } = fixture(
    t,
    `
      import { channel } from 'node:diagnostics_channel';
      const diagnostic = channel('volli.test');
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
    const diagnostic = channel('volli.test');
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
  assert.deepEqual(Object.keys(start.versions).toSorted(), ["modules", "napi", "node", "uv", "v8"]);
  assert.deepEqual(Object.keys(start.memory).toSorted(), [
    "arrayBuffers",
    "external",
    "heapTotal",
    "heapUsed",
    "rss",
  ]);
});

test("both capture generations stay byte-bounded and retain a marked useful tail", (t) => {
  const path = join(temporaryRoot(t), "capture.log");
  const marker = "CAPTURE TRUNCATED\n";
  const append = createBoundedCapture(path, { maxBytes: 128, marker });
  append("FIRST\n");
  for (let i = 0; i < 30; i++) append(`line-${i}: ${"x".repeat(30)}\n`);
  append("LAST\n");
  const current = readFileSync(path, "utf8");
  const previous = readFileSync(`${path}.previous`, "utf8");
  assert.ok(Buffer.byteLength(current) <= 128);
  assert.ok(Buffer.byteLength(previous) <= 128);
  assert.ok(current.startsWith(marker));
  assert.ok(current.endsWith("LAST\n"));
  assert.doesNotMatch(current + previous, /FIRST/);
  append(Buffer.from(`${"y".repeat(4096)}TAIL`));
  assert.ok(statSync(path).size <= 128);
  assert.ok(readFileSync(path, "utf8").endsWith("TAIL"));
  assert.throws(() => createBoundedCapture(path, { maxBytes: 1, marker }), /Capture bound/);
});

test("bounded JSONL keeps whole records and marks an oversized omitted entry", (t) => {
  const path = join(temporaryRoot(t), "events.jsonl");
  const marker = `${JSON.stringify({ event: "capture-truncated" })}\n`;
  const append = createBoundedCapture(path, { maxBytes: 128, marker, wholeRecords: true });
  for (let i = 0; i < 30; i++) append(`${JSON.stringify({ event: "sample", i })}\n`);
  append(`${JSON.stringify({ event: "oversized", bytes: "x".repeat(4096) })}\n`);
  for (const file of [path, `${path}.previous`]) {
    const bytes = readFileSync(file, "utf8");
    assert.ok(Buffer.byteLength(bytes) <= 128);
    const records = bytes
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.event === "capture-truncated"));
    assert.ok(records.every((record) => record.event !== "oversized"));
  }
});

test("the real preload enforces its per-observer byte bound under sustained events", (t) => {
  const { result, events, files, temporary } = fixture(
    t,
    `
    import { channel } from 'node:diagnostics_channel';
    const diagnostic = channel('volli.test');
    for (let i = 0; i < 6000; i++) diagnostic.publish({ event: 'restore-cancel-request' });
  `,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(events.some((event) => event.event === "capture-truncated"));
  const captures = files.filter(
    (file) => file.endsWith(".jsonl") || file.endsWith(".jsonl.previous"),
  );
  assert.equal(captures.length, 2);
  assert.ok(captures.every((file) => statSync(join(temporary, file)).size <= 1024 * 1024));
  assert.ok(events.some((event) => event.event === "process-exit"));
});

test("read-only symbolization pins provenance and checks identity before using symbols", () => {
  const source = readFileSync(join(root, "scripts/symbolize-worker-stack.sh"), "utf8");
  assert.ok(source.includes("24.22.1-39619001896/node-24.22.1-linux-x64.tar.gz"));
  assert.ok(source.includes("13c8f1384f72ada969d164b8de7ebacd55f3fb18a97ea86abd9b7ebdb6c77c26"));
  assert.ok(source.indexOf("archive_checksum_mismatch") < source.indexOf("tar -xOzf"));
  assert.ok(
    source.indexOf('cmp -s "$work/node" "$job_node"') < source.indexOf("addr2line -C -f -e"),
  );
  assert.match(source, /readelf -n "\$job_node"/u);
  assert.match(source, /nm -n -C "\$job_node"/u);
  assert.match(source, /diagnostic_status=failed/u);
  assert.match(source, /unattributed_or_partial_no_cause_inferred/u);
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:exec\s+)?["']?\$work\/node/u);
});

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const outputCapture = join(root, "scripts/capture-test-output.cjs");

test("bounded coverage capture drains input and preserves pipefail exit and signal status", (t) => {
  const temporary = temporaryRoot(t);
  for (const code of [0, 7, 143]) {
    const path = join(temporary, `coverage-${code}.log`);
    const source =
      code === 143
        ? 'process.stdout.write(Buffer.alloc(16384, 120), () => process.stdout.write("TAIL", () => process.kill(process.pid, "SIGTERM")))'
        : `process.stdout.write(Buffer.alloc(16384, 120)); process.stdout.write("TAIL"); process.exitCode = ${code}`;
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(source)} | ${shellQuote(process.execPath)} ${shellQuote(outputCapture)} ${shellQuote(path)} 256`;
    const result = spawnSync("bash", ["-o", "pipefail", "-c", command], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, code, result.stderr);
    assert.ok(result.stdout.endsWith("TAIL"));
    assert.ok(readFileSync(path, "utf8").endsWith("TAIL"));
    assert.match(readFileSync(path, "utf8"), /CAPTURE TRUNCATED/);
    assert.ok(statSync(path).size <= 256);
    assert.ok(statSync(`${path}.previous`).size <= 256);
    assert.doesNotMatch(result.stderr, /EPIPE|broken pipe/iu);
  }
});

test("a closed console or failed capture cannot give the producer EPIPE", (t) => {
  const temporary = temporaryRoot(t);
  for (const path of [join(temporary, "coverage.log"), join(temporary, "missing/coverage.log")]) {
    const { result } = fixture(
      t,
      `
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      const child = spawn(process.execPath, [${JSON.stringify(outputCapture)}, ${JSON.stringify(path)}, '256']);
      child.stdout.destroy();
      child.stderr.resume();
      child.stdin.on('error', () => { throw new Error('producer pipe closed'); });
      const exit = once(child, 'exit');
      child.stdin.end(Buffer.concat([Buffer.alloc(256 * 1024, 120), Buffer.from('TAIL')]));
      const [code] = await exit;
      if (code !== 0) throw new Error('capture changed exit status');
    `,
    );
    assert.equal(result.status, 0, result.stderr);
  }
  assert.ok(readFileSync(join(temporary, "coverage.log"), "utf8").endsWith("TAIL"));
});
