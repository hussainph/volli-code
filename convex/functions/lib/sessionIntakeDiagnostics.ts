/** Typed intake failures and one content-free log at the transaction boundary. */
import { ConvexError, type Value } from "convex/values";
import { SESSION_PROJECTION_EVENT_KINDS } from "@volli/shared";
import { isUuid } from "@volli/shared/cloud";

const INTAKE_ERROR_CODES = [
  "invalid_request",
  "event_too_large",
  "batch_too_large",
  "unknown_session",
  "not_found",
  "fenced",
  "not_your_runner",
  "out_of_order",
  "conflict",
  "corrupt_history",
  "corrupt_state",
  "fold_failed",
  "accept_failed",
] as const;
type IntakeErrorCode = (typeof INTAKE_ERROR_CODES)[number];

// Keep original exceptions only in memory for sanitized diagnostics. They never
// become ConvexError data or a serialized `cause` that could disclose content.
const causes = new WeakMap<Error, unknown>();

export function intakeError(
  code: IntakeErrorCode,
  message: string,
  acceptedThrough: number | null = null,
  cause?: unknown,
) {
  const error = new ConvexError({ code, message, acceptedThrough });
  if (cause !== undefined) causes.set(error, cause);
  return error;
}

/** Static phases, not event kinds, ids, messages, or other caller-supplied text. */
export interface IntakeDiagnostics {
  phase:
    | "measure"
    | "authenticate"
    | "head"
    | "validate"
    | "birth"
    | "claim"
    | "duplicates"
    | "write"
    | "cleanup"
    | "read_state"
    | "fold"
    | "derive"
    | "store_state"
    | "listing"
    | "catch_up";
  /** The committed head BEFORE this transaction; speculative writes must never advance it. */
  acceptedThrough: number | null;
  expectedSequence: number | null;
  firstSequence: number | null;
  lastSequence: number | null;
  sequence: number | null;
  kind: string | null;
  hasStateDoc: boolean | null;
  stateBytes: number | null;
  eventBytes: readonly number[];
}

// Only product-owned codes go into the log. An arbitrary thrown object's data
// (including its code, message, name and stack) may contain private content.
const LOG_CODES = new Set<string>([
  ...INTAKE_ERROR_CODES,
  "corrupt_board",
  "unauthenticated",
  "not_a_runner",
  "revoked",
  "preview_access_required",
  "parent_not_found",
  "invalid_job",
  "id_taken",
  "wrong_runner",
  "not_a_member",
  "runner_unavailable",
]);
const LOG_KINDS = new Set<string>(SESSION_PROJECTION_EVENT_KINDS);
const SOURCE_FILES = new Set([
  "sessions",
  "sessionIntake",
  "sessionIntakeDiagnostics",
  "sessionDerived",
  "runnerAuth",
  "auth",
  "visibility",
  "attention",
  "delegations",
  "watches",
  "jobs",
  "board",
  "streamChunks",
  "session-state",
  "session-ledger",
]);

function sourceLocations(error: unknown) {
  try {
    if (!(error instanceof Error)) return [];
    const stack = error.stack;
    if (typeof stack !== "string") return [];
    // Strip the WHOLE header, including multiline private messages that look
    // like stack frames. Unknown/custom stack formats supply no locations.
    const { message, name } = error;
    const header = message ? `${name}: ${message}` : name;
    if (!stack.startsWith(header)) return [];
    // No exception message, function name, absolute path, or raw stack is logged.
    // Keep only allowlisted source basenames and numeric locations, if supplied
    // by the runtime. Some platform errors have no JS stack at all.
    return stack
      .slice(header.length)
      .split("\n")
      .slice(0, 12)
      .flatMap((line) => {
        const match = /(?:^|[\s/(])([A-Za-z_-]+)\.(?:js|ts):(\d+):(\d+)\)?$/.exec(line.trim());
        return match && SOURCE_FILES.has(match[1]!)
          ? [{ file: match[1]!, line: Number(match[2]), column: Number(match[3]) }]
          : [];
      })
      .slice(0, 5);
  } catch {
    // Even an unusual thrown Error with an unreadable stack stays typed.
    return [];
  }
}

/**
 * One structured line per rejected execution attempt. Throwing rolls back ALL
 * writes; logs are the evidence, not a receipt in the failed transaction.
 * Auth failures never read the Session head. Unknown heads stay null, not 0.
 * Platform argument validation and commit-time OCC failures occur outside the
 * handler and cannot be caught here; their platform request logs still apply.
 */
export async function withIntakeDiagnostics<T>(
  args: { sessionId: string; generation?: number; events?: readonly string[] },
  operation: "accept" | "catch_up",
  run: (diagnostics: IntakeDiagnostics) => Promise<T>,
): Promise<T> {
  let measured = false;
  const diagnostics: IntakeDiagnostics = {
    phase: "measure",
    acceptedThrough: null,
    expectedSequence: null,
    firstSequence: null,
    lastSequence: null,
    sequence: null,
    kind: null,
    hasStateDoc: null,
    stateBytes: null,
    eventBytes: [],
  };
  try {
    diagnostics.eventBytes = (args.events ?? []).map(
      (text) => new TextEncoder().encode(text).length,
    );
    measured = true;
    diagnostics.phase = operation === "accept" ? "authenticate" : "catch_up";
    return await run(diagnostics);
  } catch (error) {
    const data: Value = error instanceof ConvexError ? error.data : null;
    const typed =
      data !== null &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      !(data instanceof ArrayBuffer) &&
      typeof (data as Record<string, Value>).code === "string"
        ? (data as Record<string, Value>)
        : null;
    const code = typed === null ? "accept_failed" : (typed.code as string);
    const reportedHead = typed?.acceptedThrough;
    const head =
      diagnostics.acceptedThrough ??
      (typeof reportedHead === "number" && Number.isSafeInteger(reportedHead) && reportedHead >= 0
        ? reportedHead
        : null);
    const original = error instanceof Error && causes.has(error) ? causes.get(error) : error;
    console.error(
      JSON.stringify({
        event: "session_intake_rejected",
        operation,
        sessionId: isUuid(args.sessionId) ? args.sessionId : null,
        code: LOG_CODES.has(code) ? code : "other_rejection",
        phase: diagnostics.phase,
        acceptedThrough: head,
        expectedSequence: diagnostics.expectedSequence ?? (head === null ? null : head + 1),
        firstSequence: diagnostics.firstSequence,
        lastSequence: diagnostics.lastSequence,
        sequence: diagnostics.sequence,
        kind:
          diagnostics.kind === null
            ? null
            : LOG_KINDS.has(diagnostics.kind)
              ? diagnostics.kind
              : "other",
        hasStateDoc: diagnostics.hasStateDoc,
        stateBytes: diagnostics.stateBytes,
        eventCount: args.events?.length ?? 0,
        totalBytes: measured ? diagnostics.eventBytes.reduce((sum, size) => sum + size, 0) : null,
        maxEventBytes: measured
          ? diagnostics.eventBytes.reduce((max, size) => Math.max(max, size), 0)
          : null,
        unexpected: typed === null,
        errorKind:
          original instanceof SyntaxError
            ? "syntax"
            : original instanceof TypeError
              ? "type"
              : original instanceof RangeError
                ? "range"
                : original instanceof Error
                  ? "error"
                  : "non_error",
        locations: sourceLocations(original),
      }),
    );
    // Preserve typed refusals and their existing additive data. Unexpected
    // failures remain transient, as bare server errors were, with no raw
    // exception text exposed to clients. The drain keeps the facts for retry.
    if (typed !== null) throw new ConvexError({ ...typed, acceptedThrough: head });
    throw intakeError("accept_failed", "Session facts could not be accepted. Retry shortly.", head);
  }
}
