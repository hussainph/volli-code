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
 * The discriminator's times, each tied to the one real call it measures:
 * this tab, this generation, this Code Mode invocation, in program order.
 *
 * `metrics` is the program's fixed record; its clock fields must be the
 * pinned constant (a witness that the sandbox clock is still pinned) and are
 * never used. `steps` are this tab's trace steps as {action, generation, at,
 * outcome}.
 */
export function navigationTiming({ spans, steps, metrics }) {
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
  if (new Set(nested.map((span) => span.n)).size !== nested.length)
    fail("timing:nested-order", fact);
  if (!nested.every((span) => span.ok)) fail("timing:nested-failed", fact);
  nested.sort((a, b) => a.n - b.n);
  const navigate = one(
    nested.filter((span) => span.tool === "browser_navigate"),
    "timing:navigate-span",
    fact,
  );
  const shot = one(
    nested.filter((span) => span.tool === "browser_screenshot" && span.tabId === m.tabId),
    "timing:screenshot-span",
    fact,
  );
  const act = one(
    nested.filter((span) => span.tool === "browser_act" && span.tabId === m.tabId),
    "timing:act-span",
    fact,
  );
  const tabs = one(
    nested.filter((span) => span.tool === "browser_tabs" && span.n > act.n),
    "timing:following-tabs-span",
    fact,
  );
  if (!(navigate.n < shot.n && shot.n < act.n && act.n < tabs.n))
    fail("timing:program-order", fact);
  if (
    !(
      navigate.endedAt <= shot.startedAt &&
      shot.endedAt <= act.startedAt &&
      act.endedAt <= tabs.startedAt
    )
  ) {
    fail("timing:span-order", fact);
  }
  if (!(outer.startedAt <= navigate.startedAt && tabs.endedAt <= outer.endedAt)) {
    fail("timing:outer-span", fact);
  }
  const shotStep = one(
    steps.filter((step) => step.action === "screenshot"),
    "timing:screenshot-trace",
    fact,
  );
  const clickStep = one(
    steps.filter((step) => step.action === "click"),
    "timing:click-trace",
    fact,
  );
  for (const [step, span, phase] of [
    [shotStep, shot, "timing:screenshot-trace-span"],
    [clickStep, act, "timing:click-trace-span"],
  ]) {
    if (step.outcome !== "ok" || step.generation !== m.generation || !within(step.at, span)) {
      fail(phase, fact);
    }
  }
  return {
    requestedAt: shot.startedAt,
    answeredAt: shot.endedAt,
    screenshotMs: shot.endedAt - shot.startedAt,
    screenshotTraceAt: shotStep.at,
    clickRequestedAt: act.startedAt,
    clickAnsweredAt: act.endedAt,
    clickTraceAt: clickStep.at,
    tabsRequestedAt: tabs.startedAt,
    tabsAnsweredAt: tabs.endedAt,
    nestedSpans: nested.length,
  };
}
