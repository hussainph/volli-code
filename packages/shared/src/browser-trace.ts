/**
 * A Browser Trace (VC-453): the replayable record of what one Session did in
 * one Browser Tab it owns — each navigate and act, in the order the host
 * answered them, with the picture the host took after it.
 *
 * The transcript already says THAT a Session browsed; a trace is what lets a
 * person scrub back through WHAT it did once the live picture set has moved
 * on. It is evidence for the person and nothing else: no tool reads it, it is
 * never a Blob, and nothing in it is ever handed back to a model.
 *
 * PORTABLE BY CONSTRUCTION. This is the shape any host writes and any client
 * renders — the desktop today, a cloud venue (VC-198) or a mobile client
 * (VC-199) tomorrow — so it carries JSON and nothing a host owns: no file
 * paths, no Electron handle, no bytes. A frame is named by its picture id and
 * a client asks its host for the pixels, the way the transcript card does.
 *
 * WHO WRITES IT. Only the host, from what the host saw. Two fields are the
 * page's own words — the tab's `title` and the accessible name of an acted-on
 * `target` — and both pass {@link cleanBrowserTraceText} before they are
 * stored: control and direction-override characters out, whitespace
 * collapsed, length bounded. A client draws them as plain text, exactly as the
 * transcript card draws the same two facts, and never as markup. Nothing
 * typed into a page is recorded: a `type` step names the field, never the
 * text, because the text may be a password.
 *
 * Tolerant on read, because it is evidence rather than history: a step this
 * build cannot read costs the person one frame of a replay, never the rest of
 * it. {@link readBrowserTrace} answers null for a record it cannot trust as a
 * whole and drops a single step it cannot read rather than the trace.
 */
import type { ActivityBrowseAction } from "./session-activity";

/** The record's own version. A reader that meets another answers null. */
export const BROWSER_TRACE_VERSION = 1;

/**
 * How many steps one trace keeps. The oldest go first and are counted in
 * {@link BrowserTrace.droppedSteps}, so a replay can say it starts mid-way.
 */
export const BROWSER_TRACE_STEP_LIMIT = 150;

/** The longest page-derived string a step keeps, in code points. */
export const BROWSER_TRACE_TEXT_LIMIT = 240;

/**
 * The actions a trace records: the ones that change the page. Reads —
 * snapshot, console, a tab listing — change nothing and take no picture, and
 * a `browser_screenshot` is already the model's own kept picture.
 */
export const BROWSER_TRACE_ACTIONS = [
  "open",
  "back",
  "forward",
  "reload",
  "click",
  "type",
  "press",
  "select",
  "hover",
  "scroll",
  "wait",
] as const satisfies readonly ActivityBrowseAction[];

export type BrowserTraceAction = (typeof BROWSER_TRACE_ACTIONS)[number];

/**
 * How the call ended. `refused` is the policy answering — the tool returned a
 * refusal and nothing happened. `failed` is the host unable to act at all, or
 * a call withdrawn before it finished.
 */
export const BROWSER_TRACE_OUTCOMES = ["ok", "refused", "failed"] as const;

export type BrowserTraceOutcome = (typeof BROWSER_TRACE_OUTCOMES)[number];

/**
 * One tool call as the host answered it. JSON-safe type aliases rather than
 * interfaces, for the reason `ActivitySubject` gives: the record crosses a
 * transport as a plain JSON object.
 */
export type BrowserTraceStep = {
  /** Position in the trace from 0. Kept across the step bound, so gaps are honest. */
  seq: number;
  action: BrowserTraceAction;
  /**
   * What the action touched: the element's accessible name as the host read
   * it (page text, cleaned), else the ref, key or direction the call named.
   */
  target: string | null;
  url: string | null;
  /** The page's own title, cleaned. */
  title: string | null;
  /** The tab's navigation generation the host answered at, when it had one. */
  generation: number | null;
  /** Epoch milliseconds the call settled. */
  at: number;
  outcome: BrowserTraceOutcome;
  /** The `browser.*` rule that refused the call; null unless `refused`. */
  rule: string | null;
  /** Volli's words for what went wrong: a page that did not load, or a failure. */
  error: string | null;
  /** The frame the host took after the call, or null when it declined to look. */
  pictureId: string | null;
};

export type BrowserTrace = {
  version: typeof BROWSER_TRACE_VERSION;
  /** A UUID the host minted; the durable identity of this record. */
  traceId: string;
  /** The Session whose calls these were. */
  sessionId: string;
  /** The tab they ran in. Launch-local: a tab id is only unique while the host lives. */
  tabId: string;
  startedAt: number;
  updatedAt: number;
  /** Steps the bound let go of, before the first one kept. */
  droppedSteps: number;
  steps: BrowserTraceStep[];
};

export function isBrowserTraceAction(value: unknown): value is BrowserTraceAction {
  return typeof value === "string" && (BROWSER_TRACE_ACTIONS as readonly string[]).includes(value);
}

export function isBrowserTraceOutcome(value: unknown): value is BrowserTraceOutcome {
  return typeof value === "string" && (BROWSER_TRACE_OUTCOMES as readonly string[]).includes(value);
}

/**
 * C0 and C1 controls, zero-width marks, bidi embeddings/overrides/isolates and
 * the BOM: characters that can reorder or hide what a person reads beside
 * them. A page title is the page author's to choose, and this is the one door
 * it takes into a record a person trusts.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu;

/**
 * Page text, made fit to keep: unsafe characters become spaces, runs of
 * whitespace collapse, and anything past `limit` code points is cut with an
 * ellipsis. Null for anything that is not a string or leaves nothing behind.
 */
export function cleanBrowserTraceText(
  value: unknown,
  limit: number = BROWSER_TRACE_TEXT_LIMIT,
): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(UNSAFE_TEXT, " ").replace(/\s+/gu, " ").trim();
  if (text.length === 0) return null;
  const points = Array.from(text);
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : text;
}

/** An empty trace, before its first step. */
export function newBrowserTrace(input: {
  traceId: string;
  sessionId: string;
  tabId: string;
  startedAt: number;
}): BrowserTrace {
  return {
    version: BROWSER_TRACE_VERSION,
    traceId: input.traceId,
    sessionId: input.sessionId,
    tabId: input.tabId,
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    droppedSteps: 0,
    steps: [],
  };
}

/**
 * The trace with one more step, numbered after the last, and the steps the
 * bound let go of so the host can drop their frames with them. Never mutates.
 */
export function appendBrowserTraceStep(
  trace: BrowserTrace,
  step: Omit<BrowserTraceStep, "seq">,
  limit: number = BROWSER_TRACE_STEP_LIMIT,
): { trace: BrowserTrace; dropped: BrowserTraceStep[] } {
  const seq = trace.droppedSteps + trace.steps.length;
  const all = [...trace.steps, { seq, ...step }];
  const excess = Math.max(0, all.length - Math.max(1, limit));
  return {
    trace: {
      ...trace,
      updatedAt: Math.max(trace.updatedAt, step.at),
      droppedSteps: trace.droppedSteps + excess,
      steps: all.slice(excess),
    },
    dropped: all.slice(0, excess),
  };
}

/** Every picture id a trace names, for a host that keeps frames beside it. */
export function browserTracePictureIds(trace: BrowserTrace): string[] {
  return trace.steps.flatMap((step) => (step.pictureId === null ? [] : [step.pictureId]));
}

/* --------------------------------------------------------------- reading */

/**
 * A trace as it stands in storage or on the wire, or null when its header
 * cannot be trusted. A step that does not read is dropped; the rest stand.
 */
export function readBrowserTrace(raw: unknown): BrowserTrace | null {
  if (!isRecord(raw) || raw.version !== BROWSER_TRACE_VERSION) return null;
  const { traceId, sessionId, tabId, startedAt, updatedAt, droppedSteps, steps } = raw;
  if (
    !isText(traceId) ||
    !isText(sessionId) ||
    !isText(tabId) ||
    !isCount(startedAt) ||
    !isCount(updatedAt) ||
    !isCount(droppedSteps) ||
    !Array.isArray(steps)
  ) {
    return null;
  }
  return {
    version: BROWSER_TRACE_VERSION,
    traceId,
    sessionId,
    tabId,
    startedAt,
    updatedAt,
    droppedSteps,
    steps: steps.flatMap((step) => {
      const read = readStep(step);
      return read === null ? [] : [read];
    }),
  };
}

function readStep(raw: unknown): BrowserTraceStep | null {
  if (!isRecord(raw)) return null;
  const { seq, action, generation, at, outcome } = raw;
  if (
    !isCount(seq) ||
    !isBrowserTraceAction(action) ||
    !isCount(at) ||
    !isBrowserTraceOutcome(outcome) ||
    (generation !== null && !isCount(generation))
  ) {
    return null;
  }
  return {
    seq,
    action,
    target: cleanBrowserTraceText(raw.target),
    url: nullableText(raw.url),
    title: cleanBrowserTraceText(raw.title),
    generation,
    at,
    outcome,
    rule: nullableText(raw.rule),
    error: nullableText(raw.error),
    pictureId: nullableText(raw.pictureId),
  };
}

/* ---------------------------------------------------------------- replay */

/** One step of a Session's replay, with the trace it came from. */
export type BrowserTraceFrame = {
  traceId: string;
  tabId: string;
  step: BrowserTraceStep;
};

/**
 * A Session's traces as one replay: every kept step across its tabs, in the
 * order the calls settled. Within one trace a tie keeps the recorded order;
 * across two tabs a tie (the same millisecond) breaks by trace id — stable,
 * so every client replays it alike, though not necessarily in call order.
 */
export function browserTraceTimeline(traces: readonly BrowserTrace[]): BrowserTraceFrame[] {
  return traces
    .flatMap((trace) =>
      trace.steps.map((step) => ({ traceId: trace.traceId, tabId: trace.tabId, step })),
    )
    .toSorted(
      (left, right) =>
        left.step.at - right.step.at ||
        (left.traceId === right.traceId
          ? left.step.seq - right.step.seq
          : left.traceId < right.traceId
            ? -1
            : 1),
    );
}

/**
 * Where a replay opens: the step that took `pictureId` (the card it was
 * opened from), else that tab's latest step, else the latest step of all.
 * Zero for an empty timeline, which a viewer draws as its empty state.
 */
export function browserTraceStartIndex(
  timeline: readonly BrowserTraceFrame[],
  focus: { pictureId?: string | null; tabId?: string | null },
): number {
  const { pictureId = null, tabId = null } = focus;
  if (pictureId !== null) {
    const index = timeline.findIndex((frame) => frame.step.pictureId === pictureId);
    if (index >= 0) return index;
  }
  if (tabId !== null) {
    const index = timeline.findLastIndex((frame) => frame.tabId === tabId);
    if (index >= 0) return index;
  }
  return Math.max(0, timeline.length - 1);
}

/* --------------------------------------------------------------- helpers */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableText(value: unknown): string | null {
  return isText(value) ? value : null;
}
