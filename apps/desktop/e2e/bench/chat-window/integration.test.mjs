import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { serve, request } from "../../volli-drive/lib/protocol.mjs";
import { benchSettings, parseBenchArgs } from "./settings.mjs";
import { runGuardedSide, serialComparison } from "./guarded-run.mjs";
import { prepareSources, verifySource } from "./sources.mjs";
import { tracePhases } from "./trace-summary.mjs";
import { measureChatWindow } from "./measure.mjs";
import { guardedChatWindowBench } from "../../volli-drive/lib/chat-window-bench.mjs";
import { stopResult } from "../../volli-drive/lib/stop-result.mjs";
const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../../../..", import.meta.url));
async function scratch(fn) {
  await mkdir(join(repo, ".scratch"), { recursive: true });
  const dir = await mkdtemp(join(repo, ".scratch/chat-bench-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const cleanStop = stopResult(
  {
    scratchRemoved: true,
    leftovers: [],
    keychainViolations: [],
    electron: { close: { kind: "graceful" } },
  },
  { manifestPath: "manifest.json", evidence: "evidence" },
);
const settings = benchSettings({ arm: "draft", draftKeys: 2 });
const draft = {
  errors: [],
  steps: [],
  draftTyping: { ok: true, typedCharacters: 2, handlerMs: [1, 1], latencyMs: [2, 3] },
  runtime: { electron: "44", chrome: "x", node: "24" },
};

test("existing arm knobs normalize once; wrong-arm/unknown/credential switches fail closed", () => {
  const parsed = parseBenchArgs([
    "--arm",
    "draft",
    "--sessions",
    "2",
    "--draft-ballast",
    "8000",
    "--draft-trace",
    "trace.json",
    "--phases",
    "--compare",
    "tag-a",
    "tag-b",
  ]);
  assert.equal(parsed.settings.sessions, 2);
  assert.equal(parsed.settings.draftBallast, 8000);
  assert.equal(parsed.settings.phases, true);
  assert.deepEqual(parsed.compare, ["tag-a", "tag-b"]);
  for (const args of [
    ["--model", "env"],
    ["--app", "unsafe"],
    ["--arm", "bogus"],
    ["--sessions", "NaN"],
    ["--arm", "stream", "--draft-trace", "x"],
    ["--compare", "a"],
    ["--draft-keys", "2.5"],
  ])
    assert.throws(() => parseBenchArgs(args));
});

test("fresh guarded lifecycle crosses the actual NDJSON codec and always cleans before next side", async () =>
  scratch(async (dir) => {
    const calls = [];
    let live = false,
      count = 0;
    // Relative Unix socket stays below macOS sun_path's length limit while
    // remaining under this workspace's scratch directory.
    const relativeSocket = join(relative(process.cwd(), dir), "d.sock");
    const server = await serve(relativeSocket, async (cmd, args) => {
      calls.push(cmd);
      if (cmd === "launch") {
        assert.equal(live, false);
        live = true;
        return { id: `vd-abcde${count++}` };
      }
      if (cmd === "doctor") {
        assert.ok(live);
        return { ok: true };
      }
      if (cmd === "chat-window-bench") {
        assert.deepEqual(args.settings, settings);
        return draft;
      }
      if (cmd === "stop") {
        live = false;
        return cleanStop;
      }
      throw new Error("unexpected command");
    });
    const drive = (args) =>
      request(relativeSocket, args[0], {
        settings: args[0] === "chat-window-bench" ? JSON.parse(args[3]) : undefined,
      });
    try {
      const reports = await serialComparison(["a", "b"], (source) =>
        runGuardedSide({ drive, settings, source }),
      );
      assert.equal(reports.length, 2);
      assert.equal(reports[0].driver.guard.ok, true);
      assert.notEqual(reports[0].driver.id, reports[1].driver.id);
      assert.deepEqual(calls, [
        "launch",
        "doctor",
        "chat-window-bench",
        "doctor",
        "stop",
        "launch",
        "doctor",
        "chat-window-bench",
        "doctor",
        "stop",
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }));

test("doctor refusal, renderer failure and incomplete input all stop the owned instance", async () => {
  for (const failAt of ["doctor", "chat-window-bench", "input", "cleanup"]) {
    const calls = [];
    const drive = async ([cmd]) => {
      calls.push(cmd);
      if (cmd === "launch") return { id: "vd-abcdef" };
      if (cmd === "stop")
        return failAt === "cleanup" ? { ...cleanStop, leftovers: [1] } : cleanStop;
      if (cmd === failAt) throw new Error("refused");
      if (cmd === "doctor") return { ok: true };
      return failAt === "input" ? { ...draft, draftTyping: { typedCharacters: 0 } } : draft;
    };
    await assert.rejects(runGuardedSide({ drive, settings, source: {} }));
    assert.equal(calls.at(-1), "stop");
  }
  const calls = [];
  await assert.rejects(
    runGuardedSide({
      settings,
      drive: async ([cmd, id]) => {
        calls.push([cmd, id]);
        if (cmd === "launch") throw new Error("launch failed; evidence .scratch/vd-abcdef");
        return cleanStop;
      },
    }),
  );
  assert.deepEqual(calls.at(-1), ["stop", "vd-abcdef"]);
});

test("exclusive trace phases use only measured pid/windows, excluding setup and nested double counts", () => {
  const base = { pid: 3, tid: 9 };
  const events = [
    { ...base, ph: "M", name: "thread_name", args: { name: "CrRendererMain" } },
    { ...base, ph: "R", name: "chat-bench:start", ts: 1000 },
    { ...base, ph: "R", name: "chat-bench:end", ts: 11000 },
    { ...base, ph: "X", name: "FunctionCall", ts: 0, dur: 12000 },
    { ...base, ph: "X", name: "Layout", ts: 2000, dur: 3000 },
    { ...base, ph: "X", name: "Paint", ts: 6000, dur: 1000 },
    { ...base, ph: "X", name: "Layerize", ts: 8000, dur: 1000 },
    { pid: 4, tid: 8, ph: "X", name: "FunctionCall", ts: 0, dur: 99999 },
  ];
  const summary = tracePhases({ traceEvents: events }, 3);
  assert.equal(summary.script, 5);
  assert.equal(summary.styleLayout, 3);
  assert.equal(summary.paint, 1);
  assert.equal(summary.compositePreparation, 1);
  assert.equal(summary.measuredMs, 10);
  assert.throws(() => tracePhases(events, 4), /thread missing/);
  assert.throws(() => tracePhases(events.slice(0, 2), 3), /incomplete/);
  assert.throws(() => tracePhases(events, 3, 2), /incomplete/);
});

test("source archives preserve exact commits, identical separately hashed driver overlay, no legacy host", async () =>
  scratch(async (dir) => {
    const source = join(dir, "repo");
    await mkdir(join(source, "apps/desktop/e2e/bench/chat-window"), { recursive: true });
    const git = (args) =>
      exec("git", args, {
        cwd: source,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    await git(["init", "-q"]);
    await git(["config", "user.name", "Bench Test"]);
    await git(["config", "user.email", "bench@volli.test"]);
    await writeFile(join(source, "product.txt"), "before");
    await writeFile(
      join(source, "apps/desktop/e2e/bench/chat-window/electron-main.cjs"),
      "unsafe old host",
    );
    await writeFile(join(source, "apps/desktop/e2e/chat-window-bench.mjs"), "old launcher");
    await git(["add", "."]);
    await git(["-c", "commit.gpgsign=false", "commit", "-qm", "before"]);
    const before = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(source, "product.txt"), "after");
    await git(["add", "."]);
    await git(["-c", "commit.gpgsign=false", "commit", "-qm", "after"]);
    const after = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await rm(join(source, "apps/desktop/e2e/bench/chat-window/electron-main.cjs"));
    await writeFile(
      join(source, "apps/desktop/e2e/chat-window-bench.mjs"),
      "guarded controller overlay",
    );
    const sides = await prepareSources(source, [before, after], join(dir, "snapshots"));
    assert.deepEqual(
      sides.map((side) => side.metadata.commit),
      [before, after],
    );
    assert.deepEqual(sides[0].metadata.overlay, sides[1].metadata.overlay);
    for (const [index, side] of sides.entries()) {
      assert.equal(
        await readFile(join(side.dir, "product.txt"), "utf8"),
        index ? "after" : "before",
      );
      assert.equal(
        existsSync(join(side.dir, "apps/desktop/e2e/bench/chat-window/electron-main.cjs")),
        false,
      );
      assert.equal(
        await readFile(join(side.dir, "apps/desktop/e2e/chat-window-bench.mjs"), "utf8"),
        "guarded controller overlay",
      );
      await verifySource(side.dir, side.metadata);
    }
    await writeFile(join(sides[0].dir, "product.txt"), "unreported change");
    await assert.rejects(verifySource(sides[0].dir, sides[0].metadata), /source changed/);
  }));

test("no direct Electron entry; supervisor retains gate, fixed recipe, timeout and native quiet policy", async () => {
  const host = fileURLToPath(new URL("./electron-main.cjs", import.meta.url));
  assert.equal(existsSync(host), false);
  const runner = await readFile(new URL("../../chat-window-bench.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(runner, /spawn\(|node_modules.*electron|ELECTRON_DISABLE_SECURITY_WARNINGS/);
  const helper = await readFile(
    new URL("../../volli-drive/lib/chat-window-bench.mjs", import.meta.url),
    "utf8",
  );
  assert.match(helper, /focusable: false/);
  assert.match(helper, /window\.setIgnoreMouseEvents\(true\)/);
  assert.match(helper, /window\.showInactive\(\)/);
  assert.doesNotMatch(helper, /window\.focus\(|contents\.focus\(/);
  assert.match(helper, /expire\("chat-window-bench exceeded 300s"\)/);
});

test("measurement sequence retains all arms, trusted inputs and legacy report fields without app lifecycle", async () => {
  for (const arm of ["draft", "reveal", "stream", "transcript"]) {
    const expressions = [],
      inputs = [],
      batches = [],
      pauses = [];
    const recipe = benchSettings({
      arm,
      draftKeys: 2,
      revealSwitches: 2,
      revealPlanes: 1,
      streamSamples: 2,
    });
    const report = await measureChatWindow({
      settings: recipe,
      pause: async (ms) => {
        pauses.push(ms);
      },
      rendererRssMb: async () => 123,
      contents: {
        debugger: { sendCommand: async () => {} },
        sendInputEvent: async (event) => {
          inputs.push(event);
        },
        sendInputEvents: async (events) => {
          batches.push(events);
          inputs.push(...events);
        },
        executeJavaScript: async (expression) => {
          expressions.push(expression);
          if (expression.includes("uncaught")) return [];
          if (expression.includes("showDraft") || expression.includes("showReveal"))
            return { nodes: 100 };
          if (expression.includes("stopTyping")) return draft.draftTyping;
          if (expression.includes("stopReveal")) return { latencyMs: [3, 4], handlerMs: [1, 1] };
          if (expression.includes("streamAndScroll")) return { ok: true, liveCodeBlocks: 1 };
          if (expression.includes("getBoundingClientRect")) return { x: 10, y: 20 };
          if (expression.includes("nodes()")) return 100;
          return true;
        },
      },
    });
    assert.equal(report.sessions, 10);
    assert.equal(report.turns, 2000);
    assert.equal(report.failure, undefined);
    assert.ok(report.steps.length >= 1);
    assert.equal(report.steps[0].rendererRssMb, 123);
    assert.ok(pauses.includes(2500), "retains warmup");
    if (arm === "draft") {
      assert.equal(inputs.filter((event) => event.type === "char").length, 2);
      assert.deepEqual(report.draftTyping.latencyMs, [2, 3]);
      assert.equal(batches.length, 2);
      assert.ok(
        batches.every(
          (batch) => batch.map((event) => event.type).join(",") === "keyDown,char,keyUp",
        ),
      );
    } else if (arm === "reveal") assert.ok(inputs.some((event) => event.type === "mouseDown"));
    else assert.equal(report.streamingSamples.length, 2);
    if (["draft", "reveal"].includes(arm)) {
      assert.equal(
        expressions.filter((expression) => expression.includes("chat-bench:start")).length,
        1,
      );
      assert.equal(
        expressions.filter((expression) => expression.includes("chat-bench:end")).length,
        1,
      );
    }
  }
});

test("driver command refuses non-local, real-model or unhealthy instances before any live resource", async () => {
  for (const spec of [
    { fixture: "empty", model: "env" },
    { fixture: "basic", model: "fake" },
    { fixture: "empty", model: "fake", cloud: {} },
    { fixture: "empty", model: "fake", deployment: {} },
    { fixture: "empty", model: "fake", remoteAcceptance: {} },
  ])
    await assert.rejects(guardedChatWindowBench({ spec }), /empty, local, fake-model/);
  await assert.rejects(
    guardedChatWindowBench({
      spec: { fixture: "empty", model: "fake" },
      doctor: async () => ({ ok: false, problems: ["trap missing"] }),
    }),
    /guard failed: trap missing/,
  );
});

test("real stop receipt is required; partial input/paint probes fail closed for draft and reveal", async () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const run = (recipe, report, stop = cleanStop) =>
    runGuardedSide({
      settings: recipe,
      drive: async ([cmd]) => {
        if (cmd === "launch") return { id: "vd-abcdef" };
        if (cmd === "doctor") return { ok: true };
        if (cmd === "stop") return stop;
        return report;
      },
    });
  assert.equal(cleanStop.manifest, "manifest.json");
  assert.equal(cleanStop.cleanup.electron.close.kind, "graceful");
  await assert.rejects(
    run(settings, draft, { manifest: "manifest.json", evidence: "evidence", leftovers: [] }),
    /cleanup/,
  );
  for (const probe of [
    { ...draft.draftTyping, handlerMs: [1] },
    { ...draft.draftTyping, latencyMs: [1] },
    { ...draft.draftTyping, latencyMs: [1, NaN] },
    { ...draft.draftTyping, ok: false },
  ])
    await assert.rejects(run(settings, { ...draft, draftTyping: probe }), /trusted keys/);
  const reveal = benchSettings({ arm: "reveal", revealSwitches: 2 });
  for (const probe of [
    undefined,
    { ok: false },
    { ok: true, handlerMs: [], latencyMs: [] },
    { ok: true, handlerMs: [1, 1], latencyMs: [2] },
  ])
    await assert.rejects(run(reveal, { ...draft, revealSwitch: probe }), /trusted clicks/);
  await run(reveal, { ...draft, revealSwitch: { ok: true, handlerMs: [1, 1], latencyMs: [2, 3] } });
});

test("interruption still invokes the driver's owned stop exactly once", async () => {
  const signals = new EventEmitter();
  let stops = 0;
  await assert.rejects(
    runGuardedSide({
      settings,
      signals,
      drive: async ([cmd]) => {
        if (cmd === "launch") return { id: "vd-abcdef" };
        if (cmd === "doctor") return { ok: true };
        if (cmd === "stop") {
          stops++;
          return cleanStop;
        }
        signals.emit("SIGTERM");
        return draft;
      },
    }),
    /interrupted/,
  );
  assert.equal(stops, 1);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
