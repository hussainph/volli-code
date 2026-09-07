/**
 * The harness-neutral vocabulary for agent activity.
 *
 * A harness adapter classifies its own tool calls into one of these kinds and
 * stamps a descriptor into the tool part's metadata under
 * `ACTIVITY_METADATA_KEY`. The renderer switches on `kind` and never learns a
 * harness's tool names — a second adapter renames every tool and the transcript
 * still reads correctly.
 *
 * Every field beyond `kind` and `nativeToolName` is optional by construction:
 * capability here is negative-friendly, so absent is never zero and the UI must
 * render a complete row with nothing but the kind. `"other"` is a first-class
 * kind, not a degraded path — adapters are expected to fill `subject.label` for
 * it too, so an unrecognized tool still reads as a sentence.
 */

export const ACTIVITY_KINDS = [
  "run-command",
  "read-file",
  "edit-file",
  "write-file",
  "search",
  "list-directory",
  "fetch-url",
  "plan",
  "delegate",
  "browse",
  "other",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * What one browser action was (VC-238), in Volli's words. Kept apart from the
 * harness's tool names: `open` is what `browser_navigate` with a URL means,
 * whatever the tool is called, and the renderer switches on this alone.
 */
export const ACTIVITY_BROWSE_ACTIONS = [
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
  "read",
  "screenshot",
  "console",
  "tabs",
] as const;

export type ActivityBrowseAction = (typeof ACTIVITY_BROWSE_ACTIONS)[number];

/**
 * The browse facet of a descriptor: what a `browse` row says beyond its label.
 *
 * Every field but `action` is nullable, in the descriptor's own spirit: the
 * tab may be gone, the page may have no title, a page-level action has no
 * target, a read takes no picture. `picture` is an opaque host id, never
 * bytes; `target` is the element's accessible name or, failing that, its ref.
 */
export type ActivityBrowse = {
  action: ActivityBrowseAction;
  tabId: string | null;
  url: string | null;
  title: string | null;
  target: string | null;
  picture: string | null;
  errorCount: number | null;
  ownerSessionId: string | null;
  /**
   * The tab's own trouble in Volli's words — a load failure or a crashed page
   * renderer — or null when the page was healthy (§9). A navigation onto a
   * page that fails to load still answers with a snapshot, so the harness
   * calls the tool a success; this is what makes the row's glyph disagree, and
   * it is what the card keeps once the tab itself is gone.
   */
  error: string | null;
  /**
   * The `browser.*` rule that refused this call, or null when it ran. A
   * refusal is a result rather than a failure to the harness, so without this
   * the row would read as a plain success; the card shows the rule and the
   * tool's own words for it.
   */
  refusal: string | null;
};

/** Reserved namespace on `toolMetadata`. Adapters keep their own payload beside it. */
export const ACTIVITY_METADATA_KEY = "volli.activity";

/**
 * What the activity acted on. One short noun phrase, plus optional specifics.
 *
 * These are type aliases rather than interfaces on purpose: a descriptor is
 * stamped into a JSON tool-metadata slot, and only aliases carry the implicit
 * index signature that makes them assignable to a JSON object type. Interfaces
 * would force a cast at every adapter boundary.
 */
export type ActivitySubject = {
  /** A path, a command, a pattern, a URL — whatever names this call best. */
  label: string | null;
  /** Set only when the subject is a workspace file, so the UI can open a tab. */
  path: string | null;
  /** 1-based inclusive line span when the harness reported a partial read. */
  lineRange: { start: number; end: number } | null;
  /**
   * The helper a `delegate` row started, by the name it was given (VC-9).
   * Structured rather than riding `nativeToolName` or free-text `summary`,
   * which the transcript design flagged as the gap.
   */
  agentName?: string | null;
  /** Set only when the subject is a Session, so the UI can open it — the `path` of a `delegate` row. */
  sessionId?: string | null;
};

/** Measured results. Rendered in the row's right-aligned meta slot. */
export type ActivityOutcome = {
  exitCode: number | null;
  matchCount: number | null;
  fileCount: number | null;
  lineCount: number | null;
  bytes: number | null;
  addedLines: number | null;
  removedLines: number | null;
  /** Unified diff when the harness produced one. */
  diff: string | null;
  /** Short and human-readable. The raw output stays on the tool part. */
  summary: string | null;
  /** How many child Sessions a `delegate` row opened (VC-9). */
  childCount?: number | null;
};

export type ActivityDescriptor = {
  kind: ActivityKind;
  /** The harness's own tool id. Always kept, for `"other"` rows and diagnostics. */
  nativeToolName: string;
  subject: ActivitySubject;
  outcome: ActivityOutcome | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Present on `browse` rows only; absent everywhere else, and tolerated absent on read. */
  browse?: ActivityBrowse;
};

export const EMPTY_ACTIVITY_SUBJECT: ActivitySubject = {
  label: null,
  path: null,
  lineRange: null,
  agentName: null,
  sessionId: null,
};

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

export function isActivityBrowseAction(value: unknown): value is ActivityBrowseAction {
  return (
    typeof value === "string" && (ACTIVITY_BROWSE_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Total, validating read of a descriptor from arbitrary tool metadata.
 * Returns `null` rather than throwing: a malformed descriptor must degrade to
 * the generic row, never break the transcript.
 */
export function readActivityDescriptor(metadata: unknown): ActivityDescriptor | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata[ACTIVITY_METADATA_KEY];
  if (!isRecord(raw)) return null;
  if (!isActivityKind(raw.kind)) return null;
  const nativeToolName = optionalString(raw.nativeToolName);
  if (nativeToolName === null) return null;
  const browse = readBrowse(raw.browse);
  return {
    kind: raw.kind,
    nativeToolName,
    subject: readSubject(raw.subject),
    outcome: readOutcome(raw.outcome),
    startedAt: optionalNumber(raw.startedAt),
    endedAt: optionalNumber(raw.endedAt),
    ...(browse === null ? {} : { browse }),
  };
}

/** Elapsed milliseconds, when the harness reported both ends. */
export function activityDuration(descriptor: ActivityDescriptor): number | null {
  const { startedAt, endedAt } = descriptor;
  if (startedAt === null || endedAt === null) return null;
  const elapsed = endedAt - startedAt;
  return elapsed >= 0 ? elapsed : null;
}

/**
 * Kinds that read without mutating. The renderer nests these inside a single
 * collapsed activity row; everything else stays a first-class line.
 */
export function isReadOnlyActivity(kind: ActivityKind): boolean {
  return (
    kind === "read-file" || kind === "search" || kind === "list-directory" || kind === "fetch-url"
  );
}

/**
 * Kinds that left something behind on disk. These are the rows a settled run
 * keeps: the commands it ran and the checks it made are scrollback once the
 * turn has an answer, but an edit is the turn's deliverable, and folding that
 * under a count makes the most important thing in the turn the least visible.
 *
 * Deliberately not the complement of `isReadOnlyActivity` — `run-command`,
 * `delegate`, `plan` and `other` are neither. A command very often does change
 * the disk; the point is that the harness never tells us whether it did, so
 * the transcript cannot claim it as a result.
 */
export function isDurableActivity(kind: ActivityKind): boolean {
  return kind === "edit-file" || kind === "write-file";
}

function readSubject(value: unknown): ActivitySubject {
  if (!isRecord(value)) return EMPTY_ACTIVITY_SUBJECT;
  return {
    label: optionalString(value.label),
    path: optionalString(value.path),
    lineRange: readLineRange(value.lineRange),
    agentName: optionalString(value.agentName),
    sessionId: optionalString(value.sessionId),
  };
}

function readLineRange(value: unknown): { start: number; end: number } | null {
  if (!isRecord(value)) return null;
  const start = optionalNumber(value.start);
  const end = optionalNumber(value.end);
  if (start === null || end === null) return null;
  return end >= start ? { start, end } : null;
}

/**
 * A facet with no readable action is no facet: the row falls back to its label
 * alone. Exported because the adapter reads the same shape out of a browser
 * tool's `details` before stamping it, so one validator serves both ends.
 */
export function readActivityBrowse(value: unknown): ActivityBrowse | null {
  return readBrowse(value);
}

function readBrowse(value: unknown): ActivityBrowse | null {
  if (!isRecord(value) || !isActivityBrowseAction(value.action)) return null;
  return {
    action: value.action,
    tabId: optionalString(value.tabId),
    url: optionalString(value.url),
    title: optionalString(value.title),
    target: optionalString(value.target),
    picture: optionalString(value.picture),
    errorCount: optionalNumber(value.errorCount),
    ownerSessionId: optionalString(value.ownerSessionId),
    error: optionalString(value.error),
    refusal: optionalString(value.refusal),
  };
}

function readOutcome(value: unknown): ActivityOutcome | null {
  if (!isRecord(value)) return null;
  return {
    exitCode: optionalNumber(value.exitCode),
    matchCount: optionalNumber(value.matchCount),
    fileCount: optionalNumber(value.fileCount),
    lineCount: optionalNumber(value.lineCount),
    bytes: optionalNumber(value.bytes),
    addedLines: optionalNumber(value.addedLines),
    removedLines: optionalNumber(value.removedLines),
    diff: optionalString(value.diff),
    summary: optionalString(value.summary),
    childCount: optionalNumber(value.childCount),
  };
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
