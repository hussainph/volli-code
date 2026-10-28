import { ConvexError } from "convex/values";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  intakeError,
  withIntakeDiagnostics,
  type IntakeErrorCode,
} from "../functions/lib/sessionIntakeDiagnostics";

const SESSION = "c0000000-0000-4000-8000-000000000001";
const PRIVATE = "private-message-and-credential";
const args = { sessionId: SESSION, generation: 1, events: [PRIVATE, "é"] };

afterEach(() => vi.restoreAllMocks());

const codes: IntakeErrorCode[] = [
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
];

test.each(codes)("logs %s once with sizes and the committed head, never content", async (code) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    withIntakeDiagnostics(args, "accept", async (diagnostics) => {
      diagnostics.phase = "derive";
      diagnostics.acceptedThrough = 12;
      diagnostics.firstSequence = 13;
      diagnostics.lastSequence = 17;
      throw intakeError(code, PRIVATE, 99); // 99 is speculative, not the committed cursor.
    }),
  ).rejects.toMatchObject({ data: { code, acceptedThrough: 12 } });
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
    event: "session_intake_rejected",
    operation: "accept",
    sessionId: SESSION,
    code,
    phase: "derive",
    acceptedThrough: 12,
    expectedSequence: 13,
    firstSequence: 13,
    lastSequence: 17,
    eventCount: 2,
    totalBytes: new TextEncoder().encode(PRIVATE).length + 2,
    maxEventBytes: new TextEncoder().encode(PRIVATE).length,
    unexpected: false,
  });
  expect(log.mock.calls[0]![0]).not.toContain(PRIVATE);
});

test.each(["unauthenticated", "not_a_runner", "revoked", "preview_access_required"])(
  "logs %s before a head is known without looking one up or inventing head 0",
  async (code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      withIntakeDiagnostics(args, "accept", async () => {
        throw new ConvexError({ code, message: "Authorization refused." });
      }),
    ).rejects.toMatchObject({ data: { code, acceptedThrough: null } });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
      phase: "authenticate",
      code,
      acceptedThrough: null,
      expectedSequence: null,
    });
  },
);

test.each([
  [new SyntaxError(PRIVATE), "syntax"],
  [new TypeError(PRIVATE), "type"],
  [new RangeError(PRIVATE), "range"],
  [new Error(PRIVATE), "error"],
  [PRIVATE, "non_error"],
  [{ data: { code: PRIVATE }, message: PRIVATE }, "non_error"],
] as const)("catches and sanitizes unexpected thrown values (%s)", async (error, kind) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let failure: unknown;
  try {
    await withIntakeDiagnostics(args, "accept", async () => {
      throw error;
    });
  } catch (caught) {
    failure = caught;
  }
  expect(failure).toBeInstanceOf(ConvexError);
  expect(failure).toMatchObject({ data: { code: "accept_failed", acceptedThrough: null } });
  expect(JSON.stringify(failure)).not.toContain(PRIVATE);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
    code: "accept_failed",
    unexpected: true,
    errorKind: kind,
  });
  expect(log.mock.calls[0]![0]).not.toContain(PRIVATE);
});

test("keeps only allowlisted source locations, not exception text, paths or function names", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const cause = new SyntaxError(PRIVATE);
  cause.stack = `SyntaxError: ${PRIVATE}\n at ${PRIVATE} (/private/${PRIVATE}/sessionIntake.ts:12:3)\n at ${PRIVATE} (/private/${PRIVATE}.ts:99:7)`;
  await expect(
    withIntakeDiagnostics(args, "accept", async () => {
      throw intakeError("corrupt_state", "Stored fold is unreadable.", null, cause);
    }),
  ).rejects.toMatchObject({ data: { code: "corrupt_state" } });
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
    errorKind: "syntax",
    locations: [{ file: "sessionIntake", line: 12, column: 3 }],
  });
  expect(log.mock.calls[0]![0]).not.toContain(PRIVATE);
});

test("unreadable exception stacks cannot break the error boundary", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new Error(PRIVATE);
  Object.defineProperty(error, "stack", {
    get() {
      throw new Error(PRIVATE);
    },
  });
  await expect(
    withIntakeDiagnostics(args, "accept", async () => {
      throw error;
    }),
  ).rejects.toMatchObject({ data: { code: "accept_failed" } });
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0]).locations).toEqual([]);
});

test("invalid Session ids and unknown typed codes cannot inject content into logs", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    withIntakeDiagnostics({ ...args, sessionId: PRIVATE }, "accept", async (diagnostics) => {
      diagnostics.kind = PRIVATE;
      throw new ConvexError({ code: PRIVATE, message: PRIVATE, acceptedThrough: -1 });
    }),
  ).rejects.toBeInstanceOf(ConvexError);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
    code: "other_rejection",
    kind: "other",
    sessionId: null,
    acceptedThrough: null,
    expectedSequence: null,
  });
  expect(log.mock.calls[0]![0]).not.toContain(PRIVATE);
});

test("catch-up failures name the missing sequence, not an uncommitted head", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    withIntakeDiagnostics({ sessionId: SESSION }, "catch_up", async (diagnostics) => {
      diagnostics.expectedSequence = 3;
      throw intakeError("corrupt_history", "Missing accepted fact.");
    }),
  ).rejects.toMatchObject({ data: { code: "corrupt_history", acceptedThrough: null } });
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
    operation: "catch_up",
    expectedSequence: 3,
    eventCount: 0,
    totalBytes: 0,
    maxEventBytes: 0,
  });
});

test("a successful invocation logs no rejection", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(withIntakeDiagnostics(args, "accept", async () => 17)).resolves.toBe(17);
  expect(log).not.toHaveBeenCalled();
});
