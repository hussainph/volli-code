/**
 * Pure projection of Pi tool lifecycle events into Volli activity observations.
 *
 * Pi keeps its event vocabulary private to this adapter. Everything that leaves
 * this module is bounded, JSON-safe Volli data suitable for durable history and
 * renderer consumption.
 */

import type { ActivityDescriptor, ActivityKind, ActivityOutcome } from "@volli/shared";
import type { RuntimeActivityObservation, RuntimeActivityValue } from "../contracts";
import { sanitizeDiagnostic } from "./transcript";

/** Maximum characters retained in a user-facing activity summary or error. */
export const MAX_ACTIVITY_SUMMARY_LENGTH = 300;
/** Maximum characters retained for an individual normalized payload string. */
export const MAX_ACTIVITY_PAYLOAD_STRING_LENGTH = 32 * 1024;
/** Maximum JSON characters retained across one normalized input or output value. */
export const MAX_ACTIVITY_VALUE_TOTAL_LENGTH = 64 * 1024;
/** Maximum characters retained for a normalized object key. */
export const MAX_ACTIVITY_VALUE_KEY_LENGTH = 128;
/** Maximum characters retained for an activity id or native tool name. */
export const MAX_ACTIVITY_IDENTIFIER_LENGTH = 256;
/** Maximum nesting depth in a normalized activity value. */
export const MAX_ACTIVITY_VALUE_DEPTH = 8;
/** Maximum values visited while normalizing one activity value. */
export const MAX_ACTIVITY_VALUE_NODE_COUNT = 128;
/** Maximum own properties retained from one normalized object. */
export const MAX_ACTIVITY_VALUE_OBJECT_KEYS = 32;
/** Maximum entries retained from one normalized array. */
export const MAX_ACTIVITY_VALUE_ARRAY_LENGTH = 64;

export interface PiActivityContext {
  /** Input retained from the start/update event; Pi end events intentionally omit args. */
  input?: unknown;
  startedAt?: unknown;
  observedAt?: unknown;
}

const TOOL_KIND: Record<string, ActivityKind> = {
  read: "read-file",
  edit: "edit-file",
  write: "write-file",
  bash: "run-command",
};

const PREFIXED_SECRET = /\b(?:sk|pk|ghp|gho|xox[a-z]?)[-_][A-Za-z0-9_-]+/gi;
const BEARER_SECRET = /\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const AUTHORIZATION_HEADER_SECRET = /\bauthorization\s*:\s*(basic|bearer)\s+[^\s,;]+/gi;
const NAMED_SECRET =
  /\b(?:api[ _-]?key|token|password|secret|credential)\s*(?:=|:)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const SENSITIVE_KEY = /(?:token|apikey|password|secret|authorization|credential)/i;
const REDACTED_VALUE = "[redacted]";

/**
 * Map the deliberately small Pi tool-event shape without exposing a Pi SDK
 * type. This accepts unknown at the runtime boundary because SDK events and
 * objects crossing that boundary are untrusted; any failed inspection becomes
 * one generic, bounded observation rather than interrupting the Session.
 */
export function mapPiActivity(
  event: unknown,
  context: PiActivityContext,
): RuntimeActivityObservation {
  try {
    const rawEvent = recordOf(event);
    const rawContext = recordOf(context);
    const type = stringOf(readField(rawEvent, "type"));
    if (!isPiToolEvent(type)) return genericObservation();

    const toolName = identifierOf(readField(rawEvent, "toolName"), "unknown");
    const sourceInput =
      type === "tool_execution_end" ? readField(rawContext, "input") : readField(rawEvent, "args");
    const sourceOutput =
      type === "tool_execution_update"
        ? readField(rawEvent, "partialResult")
        : type === "tool_execution_end"
          ? readField(rawEvent, "result")
          : null;
    const input = normalizeInput(sourceInput);
    const output = normalizeActivityValue(sourceOutput);
    const startedAt =
      type === "tool_execution_start"
        ? timestampOf(readField(rawContext, "observedAt"))
        : timestampOf(readField(rawContext, "startedAt"));
    const endedAt =
      type === "tool_execution_end" ? timestampOf(readField(rawContext, "observedAt")) : null;
    const descriptor = descriptorFor(toolName, input, output, sourceOutput, startedAt, endedAt);
    const state = activityState(type, readField(rawEvent, "isError"));
    const base = {
      kind: "activity" as const,
      activityId: identifierOf(readField(rawEvent, "toolCallId"), "unknown"),
      state,
      descriptor,
      input,
      output,
    };

    return state === "failed"
      ? { ...base, state, error: failureText(output, descriptor.outcome?.summary ?? null) }
      : base;
  } catch {
    return genericObservation();
  }
}

function genericObservation(): RuntimeActivityObservation {
  return {
    kind: "activity",
    activityId: "unknown",
    state: "progress",
    descriptor: {
      kind: "other",
      nativeToolName: "unknown",
      subject: { label: "unknown", path: null, lineRange: null },
      outcome: null,
      startedAt: null,
      endedAt: null,
    },
    input: null,
    output: null,
  };
}

function isPiToolEvent(
  type: string | null,
): type is "tool_execution_start" | "tool_execution_update" | "tool_execution_end" {
  return (
    type === "tool_execution_start" ||
    type === "tool_execution_update" ||
    type === "tool_execution_end"
  );
}

function activityState(
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end",
  isError: unknown,
): RuntimeActivityObservation["state"] {
  if (type === "tool_execution_start") return "started";
  if (type === "tool_execution_end") return isError === true ? "failed" : "completed";
  return "progress";
}

function descriptorFor(
  toolName: string,
  input: RuntimeActivityValue,
  output: RuntimeActivityValue,
  rawOutput: unknown,
  startedAt: number | null,
  endedAt: number | null,
): ActivityDescriptor {
  const kind = TOOL_KIND[toolName] ?? "other";
  return {
    kind,
    nativeToolName: toolName,
    subject: subjectFor(kind, input, toolName),
    outcome: endedAt === null ? null : outcomeFor(output, rawOutput),
    startedAt,
    endedAt,
  };
}

function subjectFor(kind: ActivityKind, input: RuntimeActivityValue, toolName: string) {
  const source = recordOf(input);
  if (kind === "run-command") {
    return { label: cleanPayloadText(readField(source, "command")), path: null, lineRange: null };
  }
  const path =
    cleanPayloadText(readField(source, "path")) ?? cleanPayloadText(readField(source, "filePath"));
  return {
    label: path ?? (kind === "other" ? toolName : null),
    path,
    lineRange: kind === "read-file" ? readRange(source) : null,
  };
}

function readRange(input: Record<string, RuntimeActivityValue> | null) {
  const offset = positiveInteger(readField(input, "offset"));
  const limit = positiveInteger(readField(input, "limit"));
  return offset === null || limit === null ? null : { start: offset, end: offset + limit - 1 };
}

function outcomeFor(output: RuntimeActivityValue, rawOutput: unknown): ActivityOutcome {
  const result = recordOf(output);
  const details = recordOf(readField(result, "details")) ?? result;
  const rawResult = recordOf(rawOutput);
  const rawDetails = recordOf(readField(rawResult, "details")) ?? rawResult;
  const patch = cleanPayloadText(readField(details, "patch"));
  const completePatch = stringOf(readField(rawDetails, "patch"));
  return {
    exitCode: finiteNumber(readField(details, "exitCode")),
    matchCount: finiteNumber(readField(details, "matchCount")),
    fileCount: finiteNumber(readField(details, "fileCount")),
    lineCount: finiteNumber(readField(details, "lineCount")),
    bytes: finiteNumber(readField(details, "bytes")),
    addedLines: completePatch === null ? null : countDiffLines(completePatch, "+"),
    removedLines: completePatch === null ? null : countDiffLines(completePatch, "-"),
    diff: patch,
    summary: summaryFor(result),
  };
}

function countDiffLines(diff: string, prefix: "+" | "-"): number {
  let count = 0;
  let lineStart = 0;
  for (let index = 0; index <= diff.length; index += 1) {
    if (index !== diff.length && diff.charCodeAt(index) !== 10) continue;
    if (
      diff.charAt(lineStart) === prefix &&
      !(diff.charAt(lineStart + 1) === prefix && diff.charAt(lineStart + 2) === prefix)
    ) {
      count += 1;
    }
    lineStart = index + 1;
  }
  return count;
}

function summaryFor(result: Record<string, RuntimeActivityValue> | null): string | null {
  const content = readField(result, "content");
  if (!Array.isArray(content)) return cleanSummaryText(readField(result, "summary"));
  const text = content
    .map((block) => {
      const item = recordOf(block);
      return readField(item, "type") === "text" ? cleanPayloadText(readField(item, "text")) : null;
    })
    .filter((value): value is string => value !== null)
    .join("\n");
  return text.length > 0 ? boundSummaryText(text) : cleanSummaryText(readField(result, "summary"));
}

function failureText(output: RuntimeActivityValue, summary: string | null): string {
  if (summary !== null) return sanitizeDiagnostic(summary);
  if (typeof output === "string" && output.length > 0) return sanitizeDiagnostic(output);
  return "Tool execution failed.";
}

function normalizeInput(value: unknown): RuntimeActivityValue {
  const normalized = normalizeActivityValue(value);
  const input = recordOf(normalized);
  if (input === null) return normalized;
  for (const key of ["path", "filePath"] as const) {
    const clean = cleanPayloadText(readField(input, key));
    if (clean !== null) input[key] = clean;
  }
  return input;
}

function normalizeActivityValue(value: unknown): RuntimeActivityValue {
  const normalized = normalizeValue(
    value,
    { nodes: 0, seen: new WeakSet<object>(), remaining: MAX_ACTIVITY_VALUE_TOTAL_LENGTH },
    0,
  );
  return normalized === OMITTED ? null : normalized;
}

const OMITTED = Symbol("activity-value-omitted");

function normalizeValue(
  value: unknown,
  state: { nodes: number; seen: WeakSet<object>; remaining: number },
  depth: number,
): RuntimeActivityValue | typeof OMITTED {
  if (depth > MAX_ACTIVITY_VALUE_DEPTH || state.nodes >= MAX_ACTIVITY_VALUE_NODE_COUNT)
    return normalizedNull(state);
  state.nodes += 1;

  if (typeof value === "string") return normalizedString(value, state);
  if (typeof value === "number")
    return Number.isFinite(value) ? normalizedNumber(value, state) : normalizedNull(state);
  if (typeof value === "boolean") return reserve(state, value ? 4 : 5) ? value : OMITTED;
  if (value === null) return normalizedNull(state);
  if (typeof value !== "object") return normalizedNull(state);
  if (state.seen.has(value)) return normalizedNull(state);
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (!reserve(state, 2)) return OMITTED;
      const length = Math.min(value.length, MAX_ACTIVITY_VALUE_ARRAY_LENGTH);
      const normalized: RuntimeActivityValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const remaining = state.remaining;
        if (normalized.length > 0 && !reserve(state, 1)) break;
        const item = normalizeValue(value[index], state, depth + 1);
        if (item === OMITTED) {
          state.remaining = remaining;
          break;
        }
        normalized.push(item);
      }
      return normalized;
    }

    if (!reserve(state, 2)) return OMITTED;
    const normalized: Record<string, RuntimeActivityValue> = {};
    for (const sourceKey of Object.keys(value).slice(0, MAX_ACTIVITY_VALUE_OBJECT_KEYS)) {
      const key = boundActivityKey(sourceKey);
      if (Object.hasOwn(normalized, key)) continue;
      const remaining = state.remaining;
      if (Object.keys(normalized).length > 0 && !reserve(state, 1)) break;
      if (!reserve(state, JSON.stringify(key).length + 1)) {
        state.remaining = remaining;
        break;
      }
      const item = isSensitiveKey(sourceKey)
        ? normalizedString(REDACTED_VALUE, state)
        : normalizeValue((value as Record<string, unknown>)[sourceKey], state, depth + 1);
      if (item === OMITTED) {
        state.remaining = remaining;
        break;
      }
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: item,
        writable: true,
      });
    }
    return normalized;
  } finally {
    state.seen.delete(value);
  }
}

function reserve(state: { remaining: number }, characters: number): boolean {
  if (characters > state.remaining) return false;
  state.remaining -= characters;
  return true;
}

function normalizedNull(state: { remaining: number }): null | typeof OMITTED {
  return reserve(state, 4) ? null : OMITTED;
}

function normalizedNumber(value: number, state: { remaining: number }): number | typeof OMITTED {
  return reserve(state, JSON.stringify(value).length) ? value : OMITTED;
}

function normalizedString(value: string, state: { remaining: number }): string | typeof OMITTED {
  const bounded = boundPayloadText(value);
  if (JSON.stringify(bounded).length <= state.remaining) {
    state.remaining -= JSON.stringify(bounded).length;
    return bounded;
  }
  if (state.remaining < 3) return OMITTED;

  let low = 0;
  let high = bounded.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(`${bounded.slice(0, middle)}…`).length <= state.remaining) low = middle;
    else high = middle - 1;
  }
  const truncated = `${bounded.slice(0, low)}…`;
  const length = JSON.stringify(truncated).length;
  if (length > state.remaining) return OMITTED;
  state.remaining -= length;
  return truncated;
}

function boundActivityKey(value: string): string {
  return value.length > MAX_ACTIVITY_VALUE_KEY_LENGTH
    ? value.slice(0, MAX_ACTIVITY_VALUE_KEY_LENGTH)
    : value;
}

function isSensitiveKey(value: string): boolean {
  return SENSITIVE_KEY.test(value.replace(/[^a-z]/gi, ""));
}

function boundPayloadText(value: string): string {
  const redacted = redactPayloadSecrets(value);
  return redacted.length > MAX_ACTIVITY_PAYLOAD_STRING_LENGTH
    ? `${redacted.slice(0, MAX_ACTIVITY_PAYLOAD_STRING_LENGTH)}…`
    : redacted;
}

function boundSummaryText(value: string): string {
  const redacted = redactPayloadSecrets(value);
  return redacted.length > MAX_ACTIVITY_SUMMARY_LENGTH
    ? `${redacted.slice(0, MAX_ACTIVITY_SUMMARY_LENGTH)}…`
    : redacted;
}

function redactPayloadSecrets(value: string): string {
  return value
    .replace(PREFIXED_SECRET, "[redacted]")
    .replace(
      AUTHORIZATION_HEADER_SECRET,
      (_match, scheme: string) => `Authorization: ${scheme} [redacted]`,
    )
    .replace(BEARER_SECRET, "Bearer [redacted]")
    .replace(NAMED_SECRET, (match) => {
      const separator = match.search(/(?:=|:)/);
      return `${match.slice(0, separator + 1)} [redacted]`;
    });
}

function cleanPayloadText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = boundPayloadText(value).trim();
  return text.length > 0 ? text : null;
}

function cleanSummaryText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = boundSummaryText(value).trim();
  return text.length > 0 ? text : null;
}

function identifierOf(value: unknown, fallback: string): string {
  const identifier = cleanPayloadText(value);
  if (identifier === null) return fallback;
  return identifier.length > MAX_ACTIVITY_IDENTIFIER_LENGTH
    ? identifier.slice(0, MAX_ACTIVITY_IDENTIFIER_LENGTH)
    : identifier;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function timestampOf(value: unknown): number | null {
  return finiteNumber(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function recordOf(value: unknown): Record<string, RuntimeActivityValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, RuntimeActivityValue>)
    : null;
}

function readField(record: Record<string, RuntimeActivityValue> | null, key: string): unknown {
  return record?.[key];
}
