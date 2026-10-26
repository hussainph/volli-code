/**
 * Fixtures for the cloud Session view's tests: backend answers in the exact
 * JSON shapes `sessions.snapshot`, `sessions.history` and `streamChunks.since`
 * return.
 */
import type { UIMessage } from "ai";

export const SESSION_ID = "0b9d6a3e-1f2c-4d5e-8a7b-9c0d1e2f3a4b";
export const PROJECT_ID = "7c1e2d3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

export function digestOf(n: number): string {
  return `sha256:${n.toString(16).padStart(64, "0")}`;
}

export const SESSION_ROW = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  ticketId: null,
  role: "project",
  parentSessionId: null,
  title: "Cloud chat",
  createdAt: 1,
};

/** The renderer-safe `CloudSessionView` JSON `sessions.snapshot` sends as `state`. */
export function viewJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: SESSION_ROW,
    status: "open",
    latestTurnId: null,
    latestTurnOrigin: null,
    turnActive: false,
    lastTurnOutcome: null,
    lastTurnStopDetail: null,
    liveAttachment: null,
    pendingExecutorStartId: null,
    attention: { active: [], primary: null, dropped: 0 },
    interactions: { active: [], dropped: 0 },
    needsUser: false,
    signal: null,
    stopped: null,
    modelSelection: { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "high" },
    modelTier: null,
    modelAuto: null,
    usage: {},
    todoList: null,
    latestReply: null,
    resumedAfterStop: false,
    lastActivityAt: 5,
    bornTicketless: true,
    throughSequence: 0,
    truncated: false,
    ...overrides,
  };
}

export function snapshotAnswer(
  foldedThrough: number,
  view: Record<string, unknown> | null = viewJson({ throughSequence: foldedThrough }),
): unknown {
  return {
    session: { id: SESSION_ID },
    foldedThrough,
    catchingUp: false,
    state: view === null ? null : JSON.stringify(view),
  };
}

function envelope(sequence: number, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `event-${sequence}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: sequence,
    recordedAt: sequence,
    provenance: { source: { kind: "system", id: "session-runtime", detail: null }, venue: null },
    payload,
  };
}

/** A `transcript.referenced` fact naming body `n`. */
export function referencedEvent(sequence: number, body = sequence): Record<string, unknown> {
  return envelope(sequence, {
    kind: "transcript.referenced",
    attachmentId: null,
    turnId: null,
    reference: { id: `artifact-${body}`, mediaType: null, digest: digestOf(body) },
  });
}

export function turnEvent(sequence: number, kind: "turn.started" | "turn.completed") {
  return envelope(sequence, { kind, attachmentId: "attach-1", turnId: "turn-1" });
}

/** The two facts that end an attachment without a turn end. */
export function attachmentEndedEvent(
  sequence: number,
  kind: "attachment.closed" | "attachment.failed",
): Record<string, unknown> {
  return envelope(
    sequence,
    kind === "attachment.closed"
      ? { kind, attachmentId: "attach-1", outcome: "failed" }
      : {
          kind,
          attachment: {
            id: "attach-1",
            sessionId: SESSION_ID,
            venue: { id: "runner-1", kind: "local" },
            continuity: "fresh",
          },
          failure: { code: "adapter_unavailable", detail: null, diagnostic: null },
        },
  );
}

export interface HistoryRow {
  sequence: number;
  status?: "ok" | "unknown_kind" | "quarantined" | "unreadable";
  event: Record<string, unknown> | null;
}

export function historyAnswer(rows: readonly HistoryRow[], hasMore = false): unknown {
  return {
    events: rows.map((row) => ({
      sequence: row.sequence,
      eventId: `event-${row.sequence}`,
      kind: row.event === null ? "future.kind" : (row.event.payload as { kind: string }).kind,
      status: row.status ?? "ok",
      quarantine: null,
      event: row.event === null ? null : JSON.stringify(row.event),
    })),
    hasMore,
  };
}

export function messageOf(
  id: string,
  text: string,
  role: UIMessage["role"] = "assistant",
): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

/** A body as the runner stages it: the transcript artifact's canonical JSON. */
export function artifactOf(message: UIMessage): Record<string, unknown> {
  return {
    attemptId: "attempt-1",
    branchId: "branch-1",
    message,
    threadId: "thread-1",
    turnId: "turn-1",
    version: 1,
  };
}

export interface ChunkRow {
  seq: number;
  baseline?: boolean;
  throughSequence?: number;
  ops: readonly Record<string, unknown>[];
}

export function chunksAnswer(
  streams: readonly { messageId: string; chunks: readonly ChunkRow[] }[],
): unknown {
  return {
    streams: streams.map((stream) => ({
      messageId: stream.messageId,
      turnId: "turn-1",
      chunks: stream.chunks.map((chunk) => ({
        seq: chunk.seq,
        baseline: chunk.baseline ?? false,
        throughSequence: chunk.throughSequence ?? 0,
        ops: JSON.stringify(chunk.ops),
      })),
    })),
  };
}

export function resetOp(messageId: string, text: string): Record<string, unknown> {
  return {
    op: "reset",
    message: {
      id: messageId,
      role: "assistant",
      parts: [{ key: "text-0", part: { type: "text", text } }],
    },
  };
}

export function appendOp(text: string): Record<string, unknown> {
  return { op: "part.append", key: "text-0", text };
}
