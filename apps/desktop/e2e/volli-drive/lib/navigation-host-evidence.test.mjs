import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";

// The production canonical encoder whose bytes a transcript reference hashes
// (re-exported by session-engine as `canonicalJson`). Import-free TypeScript,
// loaded by Node's type stripping: the real encoder, not a copy.
import { transcriptCanonicalJson } from "../../../../../packages/shared/src/transcript-canonical-json.ts";
import {
  HostEvidenceError,
  navigationTiming,
  nestedSpanTiming,
  readTranscriptArtifact,
  settledSpans,
  transcriptReferences,
  transcriptReferenceSql,
} from "./navigation-host-evidence.mjs";

const TAB = "55916e7a-fa6a-4ae1-8323-13b1052b5edc";
const OUTER = "call_0f1e|fc_9a8b";
const MEDIA = "application/vnd.volli.ui-message+json";
const directory = mkdtempSync(join(tmpdir(), "vc1150-evidence-"));
after(() => rmSync(directory, { recursive: true, force: true }));

/** A settled activity part in session-engine `activityPart` shape. */
function part({
  id,
  tool,
  startedAt,
  endedAt,
  tabId,
  input,
  state = "output-available",
  preliminary,
}) {
  return {
    type: "dynamic-tool",
    toolName: "volli.activity",
    toolCallId: id,
    toolMetadata: {
      "volli.activity": {
        kind: tool === "codemode" ? "other" : "browse",
        nativeToolName: tool,
        subject: { label: null, path: null, lineRange: null },
        outcome: null,
        startedAt,
        endedAt,
      },
    },
    state,
    input: input ?? (tabId === undefined ? {} : { tabId }),
    ...(state === "output-error" ? { errorText: "x" } : { output: { content: [] } }),
    ...(preliminary === undefined ? {} : { preliminary }),
  };
}

/** One settled activity as its own artifact, stored like the production store. */
function store(parts, { turnId = "turn-1", plain = false } = {}) {
  const artifact = {
    version: 1,
    threadId: "thread",
    branchId: "branch",
    attemptId: "attempt:m",
    turnId,
    message: { id: `m-${Math.random()}`, role: "assistant", parts },
  };
  const bytes = Buffer.from(transcriptCanonicalJson(artifact), "utf8");
  const hex = createHash("sha256").update(bytes).digest("hex");
  if (plain) writeFileSync(join(directory, `${hex}.json`), bytes);
  else writeFileSync(join(directory, `${hex}.json.gz`), gzipSync(bytes));
  return { sequence: 1, turnId, id: `sha256:${hex}`, digest: `sha256:${hex}`, mediaType: MEDIA };
}

const nested = (n, tool, startedAt, endedAt, tabId, input) => ({
  id: `${OUTER}:d1g35t:${n}`,
  tool,
  startedAt,
  endedAt,
  tabId,
  input,
});
// The program clicks at the generation of the snapshot it just read; here a
// second navigation bump moved the tab past the navigate answer's (1 -> 2).
const CLICK = { tabId: TAB, generation: 2, kind: "click", ref: "e1" };
const CALLS = [
  { id: OUTER, tool: "codemode", startedAt: 1000, endedAt: 2000 },
  nested(0, "browser_navigate", 1010, 1100),
  nested(1, "browser_tabs", 1100, 1110),
  nested(2, "browser_tabs", 1110, 1120),
  nested(3, "browser_screenshot", 1120, 1300, TAB),
  nested(4, "browser_snapshot", 1300, 1320, TAB),
  nested(5, "browser_act", 1320, 1350, TAB, CLICK),
  nested(6, "browser_tabs", 1350, 1360),
];
// Production trace semantics (host-core browser/trace-steps.ts): a screenshot
// step records no generation; open, read and click carry the answered one.
const STEPS = [
  { action: "open", generation: 1, at: 1099, outcome: "ok" },
  { action: "screenshot", generation: null, at: 1290, outcome: "ok" },
  { action: "read", generation: 2, at: 1319, outcome: "ok" },
  { action: "click", generation: 2, at: 1349, outcome: "ok" },
];
// The program's record: its clock fields are the one pinned run epoch.
const METRICS = {
  tabId: TAB,
  generation: 1,
  requestedAt: 900,
  answeredAt: 900,
  screenshotMs: 0,
  clickRequestedAt: 900,
  clickAnsweredAt: 900,
};

const spansOf = (calls) => {
  const rows = calls.map((call) => store([part(call)]));
  return settledSpans(
    transcriptReferences(rows).map((reference) =>
      readTranscriptArtifact(directory, reference, readFileSync),
    ),
  );
};
const phaseOf = (run) => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof HostEvidenceError, String(error));
    // Facts only: no tool, page, path or artifact text.
    assert.doesNotMatch(JSON.stringify(error.evidence), /browser_|sha256|call_|vc1150|\//);
    return error.evidence.phase;
  }
  assert.fail("expected a fail-closed phase");
};

const both = (spans, steps = STEPS, metrics = METRICS) =>
  navigationTiming({ timing: nestedSpanTiming({ spans, metrics }), steps, metrics });

test("host spans and trace replace every program clock read", () => {
  const timing = both(spansOf(CALLS));
  assert.deepEqual(timing, {
    requestedAt: 1120,
    answeredAt: 1300,
    screenshotMs: 180,
    screenshotTraceAt: 1290,
    clickRequestedAt: 1320,
    clickAnsweredAt: 1350,
    clickTraceAt: 1349,
    tabsRequestedAt: 1350,
    tabsAnsweredAt: 1360,
    navigationGeneration: 1,
    actionGeneration: 2,
    nestedSpans: 7,
  });
});

test("the reference SELECT is exact to the fixture Session and refuses other ids", () => {
  const sql = transcriptReferenceSql("2f4c-session_1");
  assert.match(
    sql,
    /WHERE session_id = '2f4c-session_1' AND json_extract\(payload, '\$\.kind'\) = 'transcript\.referenced'/,
  );
  assert.match(sql, /^SELECT /);
  assert.equal(
    phaseOf(() => transcriptReferenceSql("x' OR '1'='1")),
    "timing:session-id",
  );
  assert.equal(
    phaseOf(() => transcriptReferenceSql(null)),
    "timing:session-id",
  );
});

test("ledger references are validated, and artifacts verified like the store does", () => {
  const good = store([part(CALLS[1])]);
  assert.equal(
    phaseOf(() => transcriptReferences([])),
    "timing:references",
  );
  assert.equal(
    phaseOf(() => transcriptReferences([{ ...good, digest: "sha256:" + "0".repeat(64) }])),
    "timing:reference-shape",
  );
  assert.equal(
    phaseOf(() => transcriptReferences([{ ...good, mediaType: "text/plain" }])),
    "timing:reference-shape",
  );
  assert.equal(
    phaseOf(() => transcriptReferences([{ ...good, id: "abc" }])),
    "timing:reference-shape",
  );
  const [reference] = transcriptReferences([good]);
  // A plain legacy artifact is read when no compressed name exists.
  const legacy = transcriptReferences([store([part(CALLS[2])], { plain: true })])[0];
  assert.equal(readTranscriptArtifact(directory, legacy, readFileSync).message.parts.length, 1);
  // Corrupt compressed bytes are authoritative: never fall back past them.
  const hex = reference.hex;
  writeFileSync(join(directory, `${hex}.json`), readFileSync(join(directory, `${hex}.json.gz`)));
  writeFileSync(join(directory, `${hex}.json.gz`), Buffer.from("not gzip"));
  assert.equal(
    phaseOf(() => readTranscriptArtifact(directory, reference, readFileSync)),
    "timing:artifact-unreadable",
  );
  // Bytes that do not hash to their name, a missing file, a different turn.
  const other = transcriptReferences([store([part(CALLS[3])])])[0];
  writeFileSync(join(directory, `${other.hex}.json.gz`), gzipSync(Buffer.from("{}")));
  assert.equal(
    phaseOf(() => readTranscriptArtifact(directory, other, readFileSync)),
    "timing:artifact-digest",
  );
  assert.equal(
    phaseOf(() =>
      readTranscriptArtifact(directory, { ...other, hex: "f".repeat(64) }, readFileSync),
    ),
    "timing:artifact-missing",
  );
  const turn = transcriptReferences([store([part(CALLS[4])])])[0];
  assert.equal(
    phaseOf(() => readTranscriptArtifact(directory, { ...turn, turnId: "turn-2" }, readFileSync)),
    "timing:artifact-shape",
  );
});

test("one final settled span per call: duplicates agree, conflicts and bad spans fail", () => {
  const twice = spansOf([CALLS[1], CALLS[1]]);
  assert.equal(twice.size, 1);
  assert.equal(
    phaseOf(() => spansOf([CALLS[1], { ...CALLS[1], endedAt: 1101 }])),
    "timing:span-conflict",
  );
  assert.equal(
    phaseOf(() => spansOf([{ ...CALLS[1], endedAt: 1000 }])),
    "timing:span-shape",
  );
  assert.equal(
    phaseOf(() => spansOf([{ ...CALLS[1], endedAt: null }])),
    "timing:span-shape",
  );
  // Live (unsettled) parts are not spans at all.
  const live = settledSpans([
    { turnId: "turn-1", message: { parts: [part({ ...CALLS[1], preliminary: true })] } },
    { turnId: "turn-1", message: { parts: [part({ ...CALLS[1], state: "input-available" })] } },
  ]);
  assert.equal(live.size, 0);
});

test("exact correlation: one call per role, this tab, this generation, in order", () => {
  const without = (index) => CALLS.filter((_, at) => at !== index);
  const replace = (index, call) => CALLS.map((one, at) => (at === index ? call : one));
  const timing = (calls, steps = STEPS, metrics = METRICS) =>
    phaseOf(() => both(spansOf(calls), steps, metrics));
  assert.equal(
    timing(CALLS, STEPS, { ...METRICS, answeredAt: 901 }),
    "timing:program-clock-not-pinned",
  );
  assert.equal(
    timing(CALLS, STEPS, { ...METRICS, screenshotMs: 1 }),
    "timing:program-clock-not-pinned",
  );
  assert.equal(
    timing([...CALLS, { id: "call_2", tool: "codemode", startedAt: 1, endedAt: 2 }]),
    "timing:codemode-span",
  );
  assert.equal(timing(without(4)), "timing:screenshot-span");
  assert.equal(
    timing([...CALLS, nested(7, "browser_screenshot", 1360, 1370, TAB)]),
    "timing:screenshot-span",
  );
  assert.equal(
    timing(replace(6, nested(5, "browser_act", 1320, 1350, "another-tab"))),
    "timing:act-span",
  );
  assert.equal(timing(without(7)), "timing:following-tabs-span");
  assert.equal(timing(replace(1, { ...CALLS[1], id: `${OUTER}:other:0` })), "timing:nested-digest");
  // Position n is part of the id: two calls at one position are one id with
  // two different spans, refused before ordering is even considered.
  assert.equal(
    timing(replace(7, { ...CALLS[7], id: `${OUTER}:d1g35t:5` })),
    "timing:span-conflict",
  );
  assert.equal(timing(replace(1, { ...CALLS[1], id: `${OUTER}:bad` })), "timing:nested-id");
  assert.equal(
    timing(replace(4, nested(3, "browser_screenshot", 1050, 1300, TAB))),
    "timing:span-order",
  );
  assert.equal(timing(replace(0, { ...CALLS[0], endedAt: 1355 })), "timing:outer-span");
  assert.equal(timing(without(5)), "timing:snapshot-span");
  // A nested call that failed is not a measurement.
  const failedSpans = settledSpans(
    CALLS.map((call, index) => ({
      turnId: "turn-1",
      message: { parts: [part({ ...call, ...(index === 4 ? { state: "output-error" } : {}) })] },
    })),
  );
  assert.equal(
    phaseOf(() => both(failedSpans)),
    "timing:nested-failed",
  );
  const step = (index, change) =>
    STEPS.map((one, at) => (at === index ? { ...one, ...change } : one));
  assert.equal(timing(CALLS, step(1, { at: 1301 })), "timing:screenshot-trace-span");
  // A screenshot step that claims a generation is not the production shape.
  assert.equal(timing(CALLS, step(1, { generation: 1 })), "timing:screenshot-trace-span");
  // Continuity: the open, the read after the screenshot and the click.
  assert.equal(timing(CALLS, step(0, { generation: 2 })), "timing:open-trace-span");
  assert.equal(timing(CALLS, step(0, { at: 1101 })), "timing:open-trace-span");
  // The read and the click carry the ACT's generation, not the navigation's.
  assert.equal(timing(CALLS, step(2, { generation: 1 })), "timing:read-trace-span");
  assert.equal(timing(CALLS, step(3, { generation: 1 })), "timing:click-trace-span");
  assert.equal(timing(CALLS, step(3, { generation: 3 })), "timing:click-trace-span");
  // The recorded act request itself must be a click with a ref at a generation.
  const act = (input) => replace(6, nested(5, "browser_act", 1320, 1350, TAB, input));
  assert.equal(timing(act({ ...CLICK, kind: "type" })), "timing:act-input");
  assert.equal(timing(act({ ...CLICK, ref: undefined })), "timing:act-input");
  assert.equal(timing(act({ ...CLICK, generation: 2.5 })), "timing:act-input");
  assert.equal(timing(act({ tabId: TAB })), "timing:act-input");
  assert.equal(
    timing(
      CALLS,
      STEPS.filter((one) => one.action !== "read"),
    ),
    "timing:read-trace",
  );
  assert.equal(timing(CALLS, step(1, { outcome: "refused" })), "timing:screenshot-trace-span");
  assert.equal(timing(CALLS, step(3, { at: 1319 })), "timing:click-trace-span");
  assert.equal(
    timing(
      CALLS,
      STEPS.filter((one) => one.action !== "click"),
    ),
    "timing:click-trace",
  );
  assert.equal(timing(CALLS, [...STEPS, STEPS[1]]), "timing:screenshot-trace");
});
