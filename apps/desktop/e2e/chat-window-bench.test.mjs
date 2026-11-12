import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGuardedSide, validateDiagramProbe } from "./bench/chat-window/guarded-run.mjs";
import { benchSettings, parseBenchArgs } from "./bench/chat-window/settings.mjs";
import { diagramCadencePlugin, readBenchCadence } from "./bench/chat-window/production.mjs";
import { measureChatWindow } from "./bench/chat-window/measure.mjs";
import { stopResult } from "./volli-drive/lib/stop-result.mjs";

const sample = () => ({
  ok: true,
  streamContent: "diagram",
  codeFenceOpened: true,
  codeFenceClosed: true,
  streamedWhileWorking: true,
  streamedWhileTurnActive: true,
  liveDiagramSvgs: 1,
  visibleDiagramFrames: 50,
  distinctVisibleDiagramSources: 8,
  maxDiagramLabels: 18,
  settledDiagramSvgs: 1,
  settledDiagramLabels: 18,
  scrollDistancePx: 500,
  refreshIntervalMs: 16.7,
});
const report = () => ({ streamingSamples: [sample()], errors: [], errorDetails: [] });

test("accepts a visible, changing diagram streamed through a working Turn", () => {
  assert.doesNotThrow(() => validateDiagramProbe(report(), 1));
});

for (const [name, patch] of [
  ["failed sample", { ok: false }],
  ["wrong content", { streamContent: "code" }],
  ["no fence", { codeFenceOpened: false }],
  ["unclosed fence", { codeFenceClosed: false }],
  ["not working", { streamedWhileWorking: false }],
  ["idle Turn", { streamedWhileTurnActive: false }],
  ["no SVG", { liveDiagramSvgs: 0 }],
  ["hidden SVG", { visibleDiagramFrames: 0 }],
  ["unchanging SVG", { distinctVisibleDiagramSources: 1 }],
  ["missing live nodes", { maxDiagramLabels: 1 }],
  ["missing settled SVG", { settledDiagramSvgs: 0 }],
  ["incomplete settled graph", { settledDiagramLabels: 1 }],
  ["no scroll", { scrollDistancePx: 0 }],
  ["no refresh calibration", { refreshIntervalMs: null }],
  ["nonfinite count", { distinctVisibleDiagramSources: Infinity }],
  ["nonfinite scroll", { scrollDistancePx: Infinity }],
  ["nonfinite calibration", { refreshIntervalMs: Infinity }],
]) {
  test(`rejects ${name}, even when sample.ok claims success`, () => {
    const value = report();
    Object.assign(value.streamingSamples[0], patch);
    assert.throws(() => validateDiagramProbe(value, 1), /SVG contract/);
  });
}

test("rejects missing samples and renderer failures", () => {
  assert.throws(() => validateDiagramProbe(report(), 2), /missing samples/);
  for (const patch of [
    { streamingSamples: undefined },
    { errors: ["console error"] },
    { errorDetails: [{ message: "unhandled rejection" }] },
    { failure: "host failed" },
  ]) {
    assert.throws(() => validateDiagramProbe({ ...report(), ...patch }, 1), /renderer errors/);
  }
});

test("diagram settings are explicit, normalized and arm-bound; source comparison remains separate", () => {
  assert.equal(benchSettings().streamContent, "code");
  assert.equal(benchSettings().diagramSampleMs, null);
  for (const cadence of ["0", "100"]) {
    const parsed = parseBenchArgs([
      "--arm",
      "stream",
      "--stream-content",
      "diagram",
      "--diagram-sample-ms",
      cadence,
      "--stream-samples",
      "5",
      "--skip-build",
      "--compare",
      "a",
      "b",
    ]);
    assert.equal(parsed.settings.diagramSampleMs, Number(cadence));
    assert.equal(parsed.settings.streamSamples, 5);
    assert.equal(parsed.skipBuild, true, "reuse is safe only with matching build/artifact proof");
    assert.deepEqual(parsed.compare, ["a", "b"]);
  }
  for (const input of [
    { streamContent: "other" },
    { streamContent: "diagram", arm: "draft" },
    { streamContent: "diagram", arm: "reveal" },
    { diagramSampleMs: 0 },
    { streamContent: "diagram", diagramSampleMs: 50 },
    { streamContent: "diagram", diagramSampleMs: "" },
    { streamContent: "diagram", diagramSampleMs: false },
  ])
    assert.throws(() => benchSettings(input));
});

test("island A/B arm is explicit, validated and applied before the stream", async () => {
  assert.equal(benchSettings().island, "on");
  assert.equal(parseBenchArgs(["--arm", "stream", "--island", "hidden"]).settings.island, "hidden");
  assert.throws(() => benchSettings({ island: "frozen" }));
  const expressions = [];
  await measureChatWindow({
    settings: benchSettings({ arm: "stream", island: "shimmer-off", streamSamples: 1 }),
    pause: async () => {},
    rendererRssMb: async () => 123,
    contents: {
      async executeJavaScript(expression) {
        expressions.push(expression);
        if (expression.includes("uncaught")) return [];
        return 1;
      },
    },
  });
  const arm = expressions.indexOf('window.chatBench.islandArm("shimmer-off")');
  assert.ok(arm >= 0);
  assert.ok(arm < expressions.findIndex((expression) => expression.includes("streamAndScroll")));
});

test("cadence overlay is read-only, scoped, exact and refuses missing/changed production wiring", () => {
  const id = "/snapshot/apps/desktop/src/renderer/src/components/ui/ai-elements/pele-diagram.tsx";
  const source = "const SAMPLE_MS = 100;\nexport const probe = SAMPLE_MS;";
  for (const cadence of [0, 100]) {
    const plugin = diagramCadencePlugin(cadence);
    plugin.buildStart();
    assert.equal(plugin.transform(source, "/other.tsx"), undefined);
    assert.throws(() => plugin.generateBundle.call({ emitFile() {} }), /did not run/);
    assert.throws(() => plugin.transform("const SAMPLE_MS = 200;", id), /constant changed/);
    assert.throws(() => plugin.transform(source + source, id), /constant changed/);
    assert.equal(plugin.transform(source, id), source.replace("= 100;", `= ${cadence};`));
    let artifact;
    plugin.generateBundle.call({
      emitFile(value) {
        artifact = value;
      },
    });
    assert.equal(artifact.fileName, ".chat-window-cadence.json");
    assert.deepEqual(JSON.parse(artifact.source), { version: 1, diagramSampleMs: cadence });
    plugin.buildStart();
    assert.throws(() => plugin.generateBundle.call({ emitFile() {} }), /did not run/);
  }
  assert.equal(source, "const SAMPLE_MS = 100;\nexport const probe = SAMPLE_MS;");
  const product = diagramCadencePlugin(null);
  assert.equal(product.transform(source, id), undefined);
  let artifact;
  product.generateBundle.call({
    emitFile(value) {
      artifact = JSON.parse(value.source);
    },
  });
  assert.deepEqual(artifact, { version: 1, diagramSampleMs: null });
  assert.throws(() => diagramCadencePlugin(50), /invalid/);
});

test("artifact rejects stale cadence and missing/malformed proof before a live window", async () => {
  const root = new URL("../../../.scratch/", import.meta.url);
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(new URL("chat-bench-cadence-", root).pathname);
  try {
    await assert.rejects(readBenchCadence(dir, 0), /ENOENT/);
    for (const cadence of [null, 0, 100]) {
      await writeFile(
        join(dir, ".chat-window-cadence.json"),
        JSON.stringify({ version: 1, diagramSampleMs: cadence }),
      );
      assert.deepEqual(await readBenchCadence(dir, cadence), {
        version: 1,
        diagramSampleMs: cadence,
      });
      await assert.rejects(readBenchCadence(dir, cadence === 0 ? 100 : 0), /does not match/);
    }
    for (const artifact of [
      "{}",
      "{",
      '{"version":2,"diagramSampleMs":0}',
      '{"version":1,"diagramSampleMs":50}',
    ]) {
      await writeFile(join(dir, ".chat-window-cadence.json"), artifact);
      await assert.rejects(readBenchCadence(dir, 0));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diagram content reaches the main measurement pipeline without replacing other arms", async () => {
  const expressions = [];
  const value = await measureChatWindow({
    settings: benchSettings({ arm: "stream", streamContent: "diagram", streamSamples: 1 }),
    pause: async () => {},
    rendererRssMb: async () => 123,
    contents: {
      async executeJavaScript(expression) {
        expressions.push(expression);
        if (expression.includes("streamAndScroll")) return sample();
        if (expression.includes("uncaught")) return [];
        return 1;
      },
    },
  });
  assert.equal(value.failure, undefined);
  assert.ok(expressions.includes('window.chatBench.streamAndScroll(0, 120, 30, "diagram")'));
  validateDiagramProbe(value, 1);
});

test("guarded diagram result bypasses only the code assertion, retains cleanup and validates SVG/artifact", async () => {
  const recipe = benchSettings({
    arm: "stream",
    streamContent: "diagram",
    diagramSampleMs: 0,
    streamSamples: 1,
  });
  const cleanStop = stopResult(
    {
      scratchRemoved: true,
      leftovers: [],
      keychainViolations: [],
      electron: { close: { kind: "graceful" } },
    },
    { manifestPath: "manifest.json", evidence: "evidence" },
  );
  for (const kind of ["valid", "static", "cadence", "missing-artifact"]) {
    const calls = [];
    const result = { ...report(), benchCadence: { version: 1, diagramSampleMs: 0 } };
    if (kind === "static") result.streamingSamples[0].distinctVisibleDiagramSources = 1;
    if (kind === "cadence") result.benchCadence.diagramSampleMs = 100;
    if (kind === "missing-artifact") delete result.benchCadence;
    const run = runGuardedSide({
      settings: recipe,
      drive: async (args) => {
        calls.push(args[0]);
        if (args[0] === "launch") return { id: "vd-abcdef" };
        if (args[0] === "doctor") return { ok: true };
        if (args[0] === "stop") return cleanStop;
        assert.deepEqual(JSON.parse(args[3]), recipe);
        return result;
      },
    });
    if (kind === "valid") await run;
    else await assert.rejects(run, kind === "static" ? /SVG contract/ : /cadence artifact/);
    assert.deepEqual(calls, ["launch", "doctor", "chat-window-bench", "doctor", "stop"]);
  }
});
