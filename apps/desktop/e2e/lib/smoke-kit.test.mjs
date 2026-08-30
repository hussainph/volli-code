import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CLOSE_APP_BOUNDED_MAX_MS,
  closeAppBounded,
  createDeadline,
  createRunner,
  evidenceDir,
  sleep,
  summarizeTurnFrames,
} from "./smoke-kit.mjs";

test("evidenceDir honours an explicit dir and creates nothing itself", async () => {
  const named = join(os.tmpdir(), "volli-evidence-dir-test-not-created");
  await fs.rm(named, { recursive: true, force: true });

  assert.equal(await evidenceDir("probe", named), named);
  // CI names the dir it will upload; whether it exists yet is the capture
  // path's business (every probe mkdir -p's before it writes).
  await assert.rejects(fs.stat(named), { code: "ENOENT" });
});

test("evidenceDir derives an unpredictable private dir and announces it", async (context) => {
  const errors = [];
  context.mock.method(console, "error", (line) => errors.push(line));

  const first = await evidenceDir("probe", undefined);
  const second = await evidenceDir("probe", undefined);
  context.after(async () => {
    await fs.rm(first, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
  });

  // Under os.tmpdir() (never the repo), prefixed by the probe, and never the
  // same name twice — a name a local attacker can predict is a name they can
  // pre-create as a symlink before the failing run writes into it.
  assert.equal(dirname(first), os.tmpdir());
  assert.match(first, /volli-probe-evidence-[^/]+$/u);
  assert.notEqual(first, second);
  // mkdtemp's 0700: nobody else can read a screenshot of the developer's app.
  assert.equal((await fs.stat(first)).mode & 0o777, 0o700);
  assert.deepEqual(errors, [`  evidence dir: ${first}`, `  evidence dir: ${second}`]);
});

test("createRunner must summarizes a required failure before throwing", async (context) => {
  const lines = [];
  context.mock.method(console, "log", (line) => lines.push(line));
  const { must, results } = createRunner();

  await assert.rejects(
    must("2c", "required probe", async () => ({ ok: false, detail: "missing evidence" })),
    /required check 2c failed; refusing dependent smoke actions/,
  );

  assert.deepEqual(results, [{ n: "2c", ok: false }]);
  assert.deepEqual(lines, [
    "  [FAIL] 2c. required probe — missing evidence",
    "\n1 CHECK(S) FAILED: 2c",
  ]);
});

class FakeChild extends EventEmitter {
  constructor({ onSignal } = {}) {
    super();
    this.pid = 4242;
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
    this.onSignal = onSignal;
  }

  exit({ code = null, signal = null } = {}) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  kill(signal) {
    this.signals.push(signal);
    return this.onSignal?.(signal, this) ?? false;
  }
}

function appWith(child, close) {
  return { close, process: () => child };
}

function turnFrame(sequence, kind, turnId) {
  return { event: { sequence, payload: { kind, turnId } } };
}

const FAST_CLOSE = {
  closeGraceMs: 20,
  termGraceMs: 20,
  killGraceMs: 20,
  naturalExitRaceMs: 10,
};

test("closeAppBounded exposes the full default shutdown budget", () => {
  assert.equal(CLOSE_APP_BOUNDED_MAX_MS, 6_000);
});

test("closeAppBounded gives a late resolved close its full natural-exit grace before TERM", async () => {
  let resolveClose;
  const signals = [];
  const closeGraceMs = 3_000;
  const naturalExitRaceMs = 125;
  const child = new FakeChild({
    onSignal(signal, process) {
      signals.push({ signal, at: performance.now() });
      if (signal === "SIGKILL") process.exit({ signal });
      return true;
    },
  });

  const closing = closeAppBounded(
    appWith(
      child,
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        }),
    ),
    { closeGraceMs, naturalExitRaceMs, termGraceMs: 20, killGraceMs: 20 },
  );
  await Promise.resolve();
  await sleep(160);
  const closeResolvedAt = performance.now();
  resolveClose();

  // A broken implementation escalates in the close-resolution microtask.
  // Check well inside the grace window before awaiting the eventual fallback.
  await sleep(60);
  assert.deepEqual(child.signals, []);
  const outcome = await closing;

  assert.equal(outcome.kind, "sigkill");
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(
    signals[0].at - closeResolvedAt >= naturalExitRaceMs - 30,
    `SIGTERM arrived ${Math.round(signals[0].at - closeResolvedAt)}ms after app.close resolved`,
  );
  assert.deepEqual(outcome.closeFailures, [
    "app.close resolved without observed exit",
    "SIGTERM exit timed out after 20ms",
  ]);
});

test("deadline owns its absolute expiry and per-action timeout clamp", () => {
  const deadline = createDeadline({
    label: "q2 overlay",
    expiresAt: 1_100,
    timeoutCeilingMs: 25,
    clock: { now: () => 1_000 },
  });

  assert.equal(deadline.label, "q2 overlay");
  assert.equal(deadline.expiresAt, 1_100);
  assert.equal(deadline.timeout("default action"), 25);
  assert.equal(deadline.timeout("short action", 10), 10);
});

test("deadline aggregate watchdog rejects a pending operation at the absolute expiry", async () => {
  let timer = null;
  const deadline = createDeadline({
    label: "q1 Steer",
    expiresAt: 1_050,
    timeoutCeilingMs: 20,
    clock: {
      now: () => 1_000,
      setTimeout(callback, delay) {
        timer = { callback, delay };
        return 1;
      },
      clearTimeout() {},
    },
  });

  const result = deadline.run(() => new Promise(() => {}));
  assert.equal(timer.delay, 50);
  timer.callback();
  await assert.rejects(result, /q1 Steer deadline expired/);
});

test("turn summary requires one correlated completion and no interruption", () => {
  assert.deepEqual(
    summarizeTurnFrames([
      turnFrame(1, "turn.started", "turn-1"),
      turnFrame(2, "turn.completed", "turn-1"),
    ]),
    {
      startedIds: ["turn-1"],
      completedIds: ["turn-1"],
      interruptedIds: [],
      exactlyOneCompletedTurn: true,
    },
  );
  assert.equal(
    summarizeTurnFrames([
      turnFrame(1, "turn.started", "turn-1"),
      turnFrame(2, "turn.completed", "turn-2"),
    ]).exactlyOneCompletedTurn,
    false,
  );
  assert.equal(
    summarizeTurnFrames([
      turnFrame(1, "turn.started", "turn-1"),
      turnFrame(2, "turn.interrupted", "turn-1"),
      turnFrame(3, "turn.completed", "turn-1"),
    ]).exactlyOneCompletedTurn,
    false,
  );
});

test("closeAppBounded returns graceful only after the child exit is observed", async () => {
  const child = new FakeChild();
  const outcome = await closeAppBounded(
    appWith(child, async () => child.exit({ code: 0 })),
    FAST_CLOSE,
  );

  assert.deepEqual(outcome, {
    kind: "graceful",
    pid: 4242,
    exit: { code: 0, signal: null },
    closeFailures: [],
  });
  assert.deepEqual(child.signals, []);
});

for (const [label, close] of [
  ["rejection", async () => Promise.reject(new Error("window would not close"))],
  ["timeout", async () => new Promise(() => {})],
]) {
  test(`closeAppBounded sends SIGTERM after app.close ${label}`, async () => {
    const child = new FakeChild({
      onSignal(signal, process) {
        if (signal === "SIGTERM") process.exit({ signal });
        return true;
      },
    });

    const outcome = await closeAppBounded(appWith(child, close), FAST_CLOSE);

    assert.equal(outcome.kind, "sigterm");
    assert.deepEqual(child.signals, ["SIGTERM"]);
  });
}

for (const [label, onSignal] of [
  ["returns false", () => false],
  ["throws ESRCH", () => Object.assign(new Error("already gone"), { code: "ESRCH" })],
]) {
  test(`closeAppBounded allows natural exit when SIGTERM ${label}`, async () => {
    const child = new FakeChild({
      onSignal(signal) {
        const result = onSignal(signal);
        if (signal === "SIGTERM") setTimeout(() => child.exit({ code: 0 }), 1);
        if (result instanceof Error) throw result;
        return result;
      },
    });

    const outcome = await closeAppBounded(
      appWith(child, async () => Promise.reject(new Error("close rejected"))),
      FAST_CLOSE,
    );

    assert.equal(outcome.kind, "natural-after-close");
    assert.deepEqual(child.signals, ["SIGTERM"]);
  });
}

test("closeAppBounded escalates an ignored SIGTERM to SIGKILL", async () => {
  const child = new FakeChild({
    onSignal(signal, process) {
      if (signal === "SIGKILL") process.exit({ signal });
      return true;
    },
  });

  const outcome = await closeAppBounded(
    appWith(child, async () => Promise.reject(new Error("close rejected"))),
    FAST_CLOSE,
  );

  assert.equal(outcome.kind, "sigkill");
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("closeAppBounded rejects when the child survives every shutdown attempt", async () => {
  const child = new FakeChild({ onSignal: () => true });

  await assert.rejects(
    closeAppBounded(
      appWith(child, async () => Promise.reject(new Error("close rejected"))),
      FAST_CLOSE,
    ),
    /remained live after SIGKILL/,
  );
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});
