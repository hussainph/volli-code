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
  "other",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

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
};

export type ActivityDescriptor = {
  kind: ActivityKind;
  /** The harness's own tool id. Always kept, for `"other"` rows and diagnostics. */
  nativeToolName: string;
  subject: ActivitySubject;
  outcome: ActivityOutcome | null;
  startedAt: number | null;
  endedAt: number | null;
};

export const EMPTY_ACTIVITY_SUBJECT: ActivitySubject = {
  label: null,
  path: null,
  lineRange: null,
};

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === "string" && (ACTIVITY_KINDS as readonly string[]).includes(value);
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
  return {
    kind: raw.kind,
    nativeToolName,
    subject: readSubject(raw.subject),
    outcome: readOutcome(raw.outcome),
    startedAt: optionalNumber(raw.startedAt),
    endedAt: optionalNumber(raw.endedAt),
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

function readSubject(value: unknown): ActivitySubject {
  if (!isRecord(value)) return EMPTY_ACTIVITY_SUBJECT;
  return {
    label: optionalString(value.label),
    path: optionalString(value.path),
    lineRange: readLineRange(value.lineRange),
  };
}

function readLineRange(value: unknown): { start: number; end: number } | null {
  if (!isRecord(value)) return null;
  const start = optionalNumber(value.start);
  const end = optionalNumber(value.end);
  if (start === null || end === null) return null;
  return end >= start ? { start, end } : null;
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
