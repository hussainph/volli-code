/**
 * Private VC-1150 helper: the discriminator's TIMES, from host records only.
 *
 * Code Mode pins `Date.now()`/`performance.now()` per run for replay
 * determinism (agent-runtime codemode/journal.ts `determinismPrelude`), so a
 * program's own clock reads are one constant and can never be a measurement.
 * The host already records real wall-clock times for every call a program
 * makes, through existing read-only boundaries; this module only reads them:
 *
 *  - Nested call spans. Each nested call (`<outer>:<program digest>:<n>`,
 *    codemode/tool.ts) is observed by the runtime (pi/runtime.ts
 *    observeToolActivity) with `host.now()` at its start and end, carried as
 *    `startedAt`/`endedAt` in the descriptor (pi/activity.ts). A settled
 *    activity becomes ITS OWN assistant message (session-engine
 *    observation-translation.ts `#activityObservation`): one transcript
 *    artifact, referenced by one `transcript.referenced` ledger event. The
 *    artifact is `<userData>/session-transcripts/<hex>.json.gz` holding the
 *    canonical JSON whose SHA-256 is the reference id (host-core
 *    session-runtime/transcript-artifacts.ts).
 *  - Browser trace steps (shared/browser-trace.ts), already read by the probe:
 *    per tab, the action, the generation answered at, and `at` = main-process
 *    `Date.now()` when the call settled.
 *
 * A span covers slot admission and result shaping as well as the Browser call,
 * so it is a LONGER, stricter bound than the call alone. Anything missing,
 * duplicated with a different span, or ambiguous fails closed with an
 * allowlisted phase and counts; no page, tool or artifact text leaves here.
 * Reading these files never touches the picture store.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const ACTIVITY_TOOL_NAME = "volli.activity";
const ACTIVITY_METADATA_KEY = "volli.activity";
const MEDIA_TYPE = "application/vnd.volli.ui-message+json";
const REFERENCE = /^sha256:([a-f0-9]{64})$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NESTED = /^([^:]+):(\d+)$/;

/** Fixed phase plus counts; never artifact, page or tool text. */
export class HostEvidenceError extends Error {
  constructor(phase, fact = {}) {
    super(phase);
    this.name = "HostEvidenceError";
    this.evidence = { phase, ...fact };
  }
}
const fail = (phase, fact) => {
  throw new HostEvidenceError(phase, fact);
};

/** The one read-only SELECT for the fixture Session's transcript references. */
export function transcriptReferenceSql(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    fail("timing:session-id");
  }
  return (
    "SELECT sequence, json_extract(payload, '$.turnId') AS turnId, " +
    "json_extract(payload, '$.reference.id') AS id, " +
    "json_extract(payload, '$.reference.digest') AS digest, " +
    "json_extract(payload, '$.reference.mediaType') AS mediaType " +
    `FROM session_events WHERE session_id = '${sessionId}' ` +
    "AND json_extract(payload, '$.kind') = 'transcript.referenced' ORDER BY sequence"
  );
}

/** Ledger rows -> validated references, in ledger order. */
export function transcriptReferences(rows) {
  if (!Array.isArray(rows) || rows.length === 0) fail("timing:references", { rows: 0 });
  return rows.map((row) => {
    const match = REFERENCE.exec(row?.id ?? "");
    if (!match || row.digest !== row.id || row.mediaType !== MEDIA_TYPE) {
      fail("timing:reference-shape", { rows: rows.length });
    }
    return { sequence: row.sequence, turnId: row.turnId ?? null, id: row.id, hex: match[1] };
  });
}

/**
 * One referenced artifact, verified like the store verifies it: the compressed
 * name is authoritative when present; the canonical bytes must hash to the id.
 */
export function readTranscriptArtifact(directory, reference, readFileSync) {
  let bytes;
  try {
    bytes = gunzipSync(readFileSync(join(directory, `${reference.hex}.json.gz`)));
  } catch (error) {
    if (error?.code !== "ENOENT") fail("timing:artifact-unreadable");
    try {
      bytes = readFileSync(join(directory, `${reference.hex}.json`));
    } catch {
      fail("timing:artifact-missing");
    }
  }
  if (createHash("sha256").update(bytes).digest("hex") !== reference.hex) {
    fail("timing:artifact-digest");
  }
  let artifact;
  try {
    artifact = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("timing:artifact-json");
  }
  if (
    artifact?.version !== 1 ||
    !Array.isArray(artifact.message?.parts) ||
    artifact.turnId !== reference.turnId
  ) {
    fail("timing:artifact-shape");
  }
  return artifact;
}

/**
 * Every settled activity span in these artifacts, by activity id. A settled
 * activity is `output-available` (never preliminary) or `output-error`; its
 * descriptor must carry finite, ordered host times. The same activity seen
 * twice must be the same span.
 */
export function settledSpans(artifacts) {
  const spans = new Map();
  for (const artifact of artifacts) {
    for (const part of artifact.message.parts) {
      if (part?.type !== "dynamic-tool" || part.toolName !== ACTIVITY_TOOL_NAME) continue;
      const settled =
        (part.state === "output-available" && part.preliminary !== true) ||
        part.state === "output-error";
      if (!settled) continue;
      const descriptor = part.toolMetadata?.[ACTIVITY_METADATA_KEY];
      const span = {
        id: part.toolCallId,
        turnId: artifact.turnId,
        tool: descriptor?.nativeToolName,
        ok: part.state === "output-available",
        tabId: typeof part.input?.tabId === "string" ? part.input.tabId : null,
        startedAt: descriptor?.startedAt,
        endedAt: descriptor?.endedAt,
      };
      if (
        typeof span.id !== "string" ||
        typeof span.tool !== "string" ||
        !Number.isFinite(span.startedAt) ||
        !Number.isFinite(span.endedAt) ||
        span.endedAt < span.startedAt
      ) {
        fail("timing:span-shape", { spans: spans.size });
      }
      const seen = spans.get(span.id);
      if (seen && JSON.stringify(seen) !== JSON.stringify(span)) {
        fail("timing:span-conflict", { spans: spans.size });
      }
      spans.set(span.id, span);
    }
  }
  return spans;
}

const one = (rows, phase, fact) => {
  if (rows.length !== 1) fail(phase, { ...fact, seen: rows.length });
  return rows[0];
};
const within = (at, span) => Number.isFinite(at) && span.startedAt <= at && at <= span.endedAt;

/**
 * Stage 1: the program's calls as host spans, each tied to the one real call
 * it measures — this Code Mode invocation, this tab, in program order.
 *
 * `metrics` is the program's fixed record. Its clock fields must be the
 * pinned constant (a witness that the sandbox clock is still pinned); they are
 * never used as a measurement.
 */
export function nestedSpanTiming({ spans, metrics }) {
  const m = metrics;
  const pinned =
    m.requestedAt === m.answeredAt &&
    m.answeredAt === m.clickRequestedAt &&
    m.clickRequestedAt === m.clickAnsweredAt &&
    m.screenshotMs === 0;
  if (!pinned) fail("timing:program-clock-not-pinned");
  const all = [...spans.values()];
  const outer = one(
    all.filter((span) => span.tool === "codemode"),
    "timing:codemode-span",
  );
  const nested = [];
  for (const span of all) {
    if (!span.id.startsWith(`${outer.id}:`)) continue;
    const match = NESTED.exec(span.id.slice(outer.id.length + 1));
    if (!match || span.turnId !== outer.turnId) fail("timing:nested-id");
    nested.push({ ...span, digest: match[1], n: Number(match[2]) });
  }
  const fact = { nested: nested.length };
  if (nested.length === 0) fail("timing:nested-spans", fact);
  if (new Set(nested.map((span) => span.digest)).size !== 1) fail("timing:nested-digest", fact);
  if (new Set(nested.map((span) => span.n)).size !== nested.length) {
    fail("timing:nested-order", fact);
  }
  if (!nested.every((span) => span.ok)) fail("timing:nested-failed", fact);
  nested.sort((a, b) => a.n - b.n);
  const onTab = (tool) => nested.filter((span) => span.tool === tool && span.tabId === m.tabId);
  const navigate = one(
    nested.filter((span) => span.tool === "browser_navigate"),
    "timing:navigate-span",
    fact,
  );
  const shot = one(onTab("browser_screenshot"), "timing:screenshot-span", fact);
  const read = one(onTab("browser_snapshot"), "timing:snapshot-span", fact);
  const act = one(onTab("browser_act"), "timing:act-span", fact);
  const tabs = one(
    nested.filter((span) => span.tool === "browser_tabs" && span.n > act.n),
    "timing:following-tabs-span",
    fact,
  );
  const order = [navigate, shot, read, act, tabs];
  for (let index = 1; index < order.length; index++) {
    if (order[index - 1].n >= order[index].n) fail("timing:program-order", fact);
    if (order[index - 1].endedAt > order[index].startedAt) fail("timing:span-order", fact);
  }
  if (!(outer.startedAt <= navigate.startedAt && tabs.endedAt <= outer.endedAt)) {
    fail("timing:outer-span", fact);
  }
  return { outerId: outer.id, nested: nested.length, navigate, shot, read, act, tabs };
}

/**
 * Stage 2: this tab's trace steps against those spans. Production records
 * (host-core browser/trace-steps.ts): `open` and `read` carry the generation
 * their answer reported, `click` its answer's (else the request's), and a
 * `screenshot` step NONE (`generation: null`). So the screenshot is pinned to
 * its span by time, and generation continuity by the open, the read just
 * after the screenshot and the click all reporting the navigation's own
 * generation. `steps` are {action, generation, at, outcome}.
 */
export function navigationTiming({ timing, steps, metrics }) {
  const fact = { nested: timing.nested, steps: steps.length };
  const step = (action, span, generation, phase) => {
    const found = one(
      steps.filter((row) => row.action === action),
      `timing:${phase}-trace`,
      fact,
    );
    if (found.outcome !== "ok" || found.generation !== generation || !within(found.at, span)) {
      fail(`timing:${phase}-trace-span`, fact);
    }
    return found;
  };
  step("open", timing.navigate, metrics.generation, "open");
  const shotStep = step("screenshot", timing.shot, null, "screenshot");
  step("read", timing.read, metrics.generation, "read");
  const clickStep = step("click", timing.act, metrics.generation, "click");
  return {
    requestedAt: timing.shot.startedAt,
    answeredAt: timing.shot.endedAt,
    screenshotMs: timing.shot.endedAt - timing.shot.startedAt,
    screenshotTraceAt: shotStep.at,
    clickRequestedAt: timing.act.startedAt,
    clickAnsweredAt: timing.act.endedAt,
    clickTraceAt: clickStep.at,
    tabsRequestedAt: timing.tabs.startedAt,
    tabsAnsweredAt: timing.tabs.endedAt,
    nestedSpans: timing.nested,
  };
}
