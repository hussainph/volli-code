/**
 * VC-291 analyzer — run with `node --test apps/desktop/e2e/lib/`.
 *
 * Two of these fixtures are regressions, not hypotheticals: the blank run and
 * the aborted run are the shapes the first analyzer reported as PASS.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { REQUIRED_BOUNDARIES, analyzeEvidence, summarize } from "./vc291-analysis.mjs";
import { REQUIRED_EXPECTED_KEYS, expectedSeedLines } from "./vc291-seed.mjs";

const GOOD_REFERENCE = `${expectedSeedLines("/tmp/wd").join("\n")}\n`;

const allFound = () => Object.fromEntries(REQUIRED_EXPECTED_KEYS.map((k) => [k, true]));
const noneFound = () => Object.fromEntries(REQUIRED_EXPECTED_KEYS.map((k) => [k, false]));

const checkpoint = (t, role, markers, extra = {}) => ({
  t,
  role,
  grid: "51 86",
  scroll: { paneId: "pane-1", top: 100, max: 100, height: 800, client: 700 },
  anchoredAtBottom: true,
  shots: { markers, steps: 4 },
  ...extra,
});

const boundaries = (count, markers = allFound()) =>
  Array.from({ length: count }, (_, i) => checkpoint(`boundary-${i + 1}`, "boundary", markers));

/** A run that should pass: complete seed, complete boundaries, complete final. */
const goodRun = (overrides = {}) => ({
  case: "focus",
  run: 1,
  surface: "ticket",
  seededPaneId: "pane-1",
  referenceToken: "tokfocus1",
  events: [
    checkpoint("seed-post", "seed", allFound()),
    ...boundaries(REQUIRED_BOUNDARIES.focus),
    checkpoint("focus-post", "final", allFound()),
  ],
  ...overrides,
});

const matrixOf = (runs, meta = {}) => ({
  meta: { backend: { webgpu: true, webgl2: false }, consoleAll: [], ...meta },
  runs,
});

const refs = (entries) => new Map(entries);
const goodRefs = () =>
  refs([["focus-r1", { path: "/tmp/volli-reflow-tokfocus1-1.txt", text: GOOD_REFERENCE }]]);
const EXPECT = { cases: ["focus"], runsPerCase: 1, backend: "webgpu" };

const analyze = (matrix, references = goodRefs(), expect = EXPECT) =>
  analyzeEvidence({ dir: "matrix-focus", matrix, references, expect });

test("a complete run passes", () => {
  const result = analyze(matrixOf([goodRun()]));
  assert.deepEqual(result.rows[0].failures, []);
  assert.equal(result.rows[0].verdict, "PASS");
  assert.equal(result.ok, true);
});

test("REGRESSION: a run whose pane rendered nothing FAILS instead of passing vacuously", () => {
  // The old analyzer computed "markers lost = after minus before" and read
  // 0 → 0 as "lost nothing". A pane that painted nothing measures nothing.
  const blank = goodRun({
    events: [
      checkpoint("seed-post", "seed", noneFound()),
      ...boundaries(REQUIRED_BOUNDARIES.focus, noneFound()),
      checkpoint("focus-post", "final", noneFound()),
    ],
  });
  const result = analyze(matrixOf([blank]));
  assert.equal(result.rows[0].verdict, "FAIL");
  assert.ok(
    result.rows[0].failures.some((f) => f.includes("found NO expected lines")),
    `expected a vacuity failure, got ${JSON.stringify(result.rows[0].failures)}`,
  );
  assert.equal(result.ok, false);
});

test("a partial seed sweep FAILS: an incomplete baseline cannot support a later claim", () => {
  const partial = goodRun({
    events: [
      checkpoint("seed-post", "seed", { ...allFound(), long15: false, pwd: false }),
      ...boundaries(REQUIRED_BOUNDARIES.focus),
      checkpoint("focus-post", "final", allFound()),
    ],
  });
  const row = analyze(matrixOf([partial])).rows[0];
  assert.equal(row.verdict, "FAIL");
  assert.ok(row.failures.some((f) => f.includes("incomplete, missing: long15,pwd")));
});

test("REGRESSION: an aborted run with a fatal in metadata FAILS", () => {
  const aborted = goodRun({ error: "divider not hittable; action aborted" });
  const result = analyze(matrixOf([aborted], { fatal: "TypeError: boom\n  at x" }));
  assert.equal(result.rows[0].verdict, "FAIL");
  assert.ok(result.rows[0].failures.some((f) => f.includes("run recorded an error")));
  assert.ok(result.problems.some((p) => p.includes("aborted with a fatal error")));
  assert.equal(result.ok, false);
});

test("a stale or shared reference file FAILS", () => {
  const stale = analyze(
    matrixOf([goodRun()]),
    refs([["focus-r1", { path: "/tmp/volli-reflow-tokfocus0-9.txt", text: GOOD_REFERENCE }]]),
  );
  assert.ok(stale.rows[0].failures.some((f) => f.includes("stale pointer")));

  // Two runs pointed at one file — exactly what the uncleaned pointer produced.
  const shared = analyzeEvidence({
    dir: "matrix-focus",
    matrix: matrixOf([goodRun(), goodRun({ run: 2, referenceToken: "tokfocus2" })]),
    references: refs([
      ["focus-r1", { path: "/tmp/shared.txt", text: GOOD_REFERENCE }],
      ["focus-r2", { path: "/tmp/shared.txt", text: GOOD_REFERENCE }],
    ]),
    expect: { cases: ["focus"], runsPerCase: 2, backend: "webgpu" },
  });
  assert.ok(shared.rows[1].failures.some((f) => f.includes("shared with focus-r1")));
  assert.equal(shared.ok, false);
});

test("a malformed reference file FAILS even when every screen check passed", () => {
  const result = analyze(
    matrixOf([goodRun()]),
    refs([
      [
        "focus-r1",
        { path: "/tmp/volli-reflow-tokfocus1-1.txt", text: "REFLOW-BEGIN\nREFLOW-END\n" },
      ],
    ]),
  );
  assert.equal(result.rows[0].verdict, "FAIL");
  assert.ok(result.rows[0].failures.some((f) => f.includes("not the intended sequence")));
});

test("a missing reference file FAILS", () => {
  const result = analyze(matrixOf([goodRun()]), refs([]));
  assert.ok(result.rows[0].failures.some((f) => f.includes("no reference file")));
});

test("missing pre or post checkpoints FAIL", () => {
  const noSeed = goodRun({
    events: [
      ...boundaries(REQUIRED_BOUNDARIES.focus),
      checkpoint("focus-post", "final", allFound()),
    ],
  });
  assert.ok(
    analyze(matrixOf([noSeed])).rows[0].failures.some((f) => f.includes("no seed checkpoint")),
  );

  const noFinal = goodRun({
    events: [checkpoint("seed-post", "seed", allFound()), ...boundaries(REQUIRED_BOUNDARIES.focus)],
  });
  assert.ok(
    analyze(matrixOf([noFinal])).rows[0].failures.some((f) => f.includes("no final checkpoint")),
  );
});

test("too few action boundaries FAILS — endpoints alone are not the ticket's matrix", () => {
  const thin = goodRun({
    events: [
      checkpoint("seed-post", "seed", allFound()),
      ...boundaries(2),
      checkpoint("focus-post", "final", allFound()),
    ],
  });
  const row = analyze(matrixOf([thin])).rows[0];
  assert.equal(row.verdict, "FAIL");
  assert.ok(
    row.failures.some((f) =>
      f.includes("only 2 action-boundary checkpoint(s), the ticket requires 10"),
    ),
  );
});

test("a boundary missing grid, scroll, pane identity or the anchor result FAILS", () => {
  for (const [field, patch] of [
    ["grid", { grid: "NO-RESPONSE" }],
    ["scroll", { scroll: undefined }],
    ["anchoredAtBottom", { anchoredAtBottom: undefined }],
  ]) {
    const bad = boundaries(REQUIRED_BOUNDARIES.focus);
    Object.assign(bad[3], patch);
    if (patch.anchoredAtBottom === undefined && "anchoredAtBottom" in patch)
      delete bad[3].anchoredAtBottom;
    if (patch.scroll === undefined && "scroll" in patch) delete bad[3].scroll;
    const run = goodRun({
      events: [
        checkpoint("seed-post", "seed", allFound()),
        ...bad,
        checkpoint("f", "final", allFound()),
      ],
    });
    const row = analyze(matrixOf([run])).rows[0];
    assert.equal(row.verdict, "FAIL", `${field} should have failed the run`);
  }
});

test("a shell that stopped answering FAILS", () => {
  const wedged = goodRun();
  wedged.events.push({ t: "probe", grid: "NO-RESPONSE" });
  const row = analyze(matrixOf([wedged])).rows[0];
  assert.ok(row.failures.some((f) => f.includes("did not answer REFLOW-CHECK")));
});

test("measuring a pane other than the seeded one FAILS", () => {
  const drifted = goodRun();
  drifted.events[5].scroll = { ...drifted.events[5].scroll, paneId: "pane-9" };
  const row = analyze(matrixOf([drifted])).rows[0];
  assert.ok(row.failures.some((f) => f.includes("measured a pane other than the seeded one")));
});

test("a wrong or unconfirmed backend FAILS the evidence set", () => {
  const wrong = analyzeEvidence({
    dir: "matrix-gpu",
    matrix: matrixOf([goodRun()]),
    references: goodRefs(),
    expect: { cases: ["focus"], runsPerCase: 1, backend: "webgl2" },
  });
  assert.ok(
    wrong.problems.some((p) => p.includes("expected the webgl2 backend, probe reported WebGPU")),
  );
  assert.equal(wrong.ok, false);

  const none = analyzeEvidence({
    dir: "matrix-x",
    matrix: {
      meta: { backend: { webgpu: false, webgl2: false }, consoleAll: [] },
      runs: [goodRun()],
    },
    references: goodRefs(),
    expect: EXPECT,
  });
  assert.ok(none.problems.some((p) => p.includes("no terminal backend was confirmed")));
});

test("missing cases and missing run counts FAIL the evidence set", () => {
  const missingCase = analyzeEvidence({
    dir: "matrix-focus",
    matrix: matrixOf([goodRun()]),
    references: goodRefs(),
    expect: { cases: ["focus", "resize"], runsPerCase: 1, backend: "webgpu" },
  });
  assert.ok(missingCase.problems.some((p) => p.includes("case resize produced no runs")));

  const shortRuns = analyzeEvidence({
    dir: "matrix-focus",
    matrix: matrixOf([goodRun()]),
    references: goodRefs(),
    expect: { cases: ["focus"], runsPerCase: 3, backend: "webgpu" },
  });
  assert.ok(shortRuns.problems.some((p) => p.includes("has 1 run(s), expected 3")));
  assert.ok(shortRuns.problems.some((p) => p.includes("missing run 2")));
});

test("a GPU-pressure row below its live-terminal floor FAILS and does not overstate the row", () => {
  const gpu = goodRun({
    events: [
      checkpoint("seed-post", "seed", allFound()),
      { t: "pressure-panes-created", liveTerminalHosts: 9, backOnSeededPane: true },
      ...boundaries(REQUIRED_BOUNDARIES.focus),
      checkpoint("focus-post", "final", allFound()),
    ],
  });
  const result = analyzeEvidence({
    dir: "matrix-gpu-webgl2",
    matrix: matrixOf([gpu], { backend: { webgpu: false, webgl2: true } }),
    references: goodRefs(),
    expect: { cases: ["focus"], runsPerCase: 1, backend: "webgl2", minLiveTerminals: 17 },
  });
  assert.ok(result.rows[0].failures.some((f) => f.includes("only 9 live terminals")));
});

test("console warnings from every level are counted, not just errors", () => {
  const result = analyze(
    matrixOf([goodRun()], {
      consoleAll: [
        {
          type: "warning",
          text: "WARNING: Too many active WebGL contexts. Oldest context will be lost.",
        },
        { type: "log", text: "noise" },
        { type: "error", text: "boom" },
      ],
    }),
  );
  assert.equal(result.contextWarnings, 1);
  assert.deepEqual(result.consoleByLevel, { warning: 1, log: 1, error: 1 });
  assert.ok(result.notes.some((n) => n.includes("GPU context/device message")));
});

test("the anchor result is recorded per checkpoint rather than eyeballed", () => {
  const drifting = goodRun();
  drifting.events[4].anchoredAtBottom = false;
  drifting.events[4].scroll = { ...drifting.events[4].scroll, top: 1624, max: 2100 };
  const row = analyze(matrixOf([drifting])).rows[0];
  // Un-anchoring is a finding, not an evidence failure: the run still passes
  // for retention, and the drift is reported with the boundary that began it.
  assert.equal(row.verdict, "PASS");
  assert.equal(row.unanchoredCount, 1);
  assert.equal(row.firstUnanchored, "boundary-4");
});

test("summarize refuses an empty evidence set", () => {
  const empty = analyzeEvidence({
    dir: "matrix-nothing",
    matrix: matrixOf([]),
    references: refs([]),
    expect: EXPECT,
  });
  const folded = summarize([empty]);
  assert.equal(folded.ok, false);
  assert.equal(folded.total, 0);
  assert.ok(folded.problems.some((p) => p.includes("no runs")));
});

test("summarize is ok only when every row passed and no set had a problem", () => {
  const good = analyze(matrixOf([goodRun()]));
  assert.equal(summarize([good]).ok, true);
  const bad = analyze(matrixOf([goodRun({ error: "nope" })]));
  assert.equal(summarize([good, bad]).ok, false);
  assert.equal(summarize([good, bad]).failed, 1);
});
