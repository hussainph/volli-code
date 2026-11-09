import assert from "node:assert/strict";
import test from "node:test";
import { validateDiagramProbe } from "./chat-window-bench.mjs";

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
