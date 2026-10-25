/**
 * Streamed text on Volli Cloud: a message still being written reaches the
 * people watching it as short-lived chunk rows (`streamChunks`), and only
 * while someone watches (`sessionViewers`).
 *
 * A chunk is the coalesced transcript-overlay operations (`TranscriptDelta`
 * in `@volli/session-engine`) since the stream's previous chunk, so a client
 * folds chunks with the same pure fold it folds local overlays with. Chunks
 * are best-effort: the settled message is a durable Session fact and carries
 * the whole content, so a chunk is never retried, never buffered offline, and
 * deleted once the settled message is accepted.
 *
 * The two rules that make a lost chunk harmless:
 * - `seq` counts a stream's chunks from 0. A runner skips a seq it could not
 *   confirm and sends a **baseline** next (a chunk whose first op is a
 *   `reset`), so a reader that sees a gap ignores the stream until a baseline.
 * - A stream gets a baseline at least every {@link STREAM_CHUNK_BASELINE_INTERVAL_MS},
 *   so a late joiner (who starts at the latest baseline) and a reader that
 *   missed rows both heal within seconds.
 *
 * Shapes and cadence come from the Convex measurement spike: 500 ms rows read
 * by a cursor query cost far less than one growing document, one chunk in
 * flight per stream gives natural backpressure, and gating on viewers is the
 * largest single saving.
 */

import type { SessionId } from "./ids";
import { utf8Length } from "./transcript-pack";

/** How often a stream's pending operations are sent as one chunk. */
export const STREAM_CHUNK_CADENCE_MS = 500;
/** A stream sends a baseline (a `reset` of the whole message) at least this often. */
export const STREAM_CHUNK_BASELINE_INTERVAL_MS = 10_000;
/** The cap on one chunk's operations (UTF-8 bytes of their JSON text). Past it, a stream resets. */
export const STREAM_CHUNK_MAX_BYTES = 16 * 1024;
/**
 * The cap on a baseline chunk: a whole message as one `reset`. A message
 * larger than this stops streaming until it settles; its durable body still
 * arrives whole.
 */
export const STREAM_CHUNK_BASELINE_MAX_BYTES = 64 * 1024;
/** Rows older than this are swept, whatever else happened to their message. */
export const STREAM_CHUNK_TTL_MS = 15 * 60 * 1000;
/** The longest message id a chunk may name (a provider's message id, opaque). */
export const STREAM_MESSAGE_ID_MAX_LENGTH = 512;

/** A viewer that has not beaten for this long is gone; its Session stops streaming. */
export const SESSION_VIEWER_TTL_MS = 60 * 1000;
/** How often a client with a Session open renews its viewer. */
export const SESSION_VIEWER_HEARTBEAT_MS = 20 * 1000;

/** The transcript-overlay operations a chunk may carry (`TranscriptDelta["op"]`). */
export const STREAM_CHUNK_OPS = [
  "reset",
  "part.upsert",
  "part.append",
  "part.remove",
  "metadata",
  "message.remove",
] as const;
export type StreamChunkOpKind = (typeof STREAM_CHUNK_OPS)[number];

/**
 * One operation as the backend checks it: its `op` is known, the rest is the
 * overlay fold's to read. `TranscriptDelta` is assignable to this.
 */
export interface StreamChunkOp {
  readonly op: StreamChunkOpKind;
}

/** One chunk of one stream (a message of a Session), as a runner appends it. */
export interface StreamChunkAppend {
  sessionId: SessionId | string;
  messageId: string;
  turnId: string | null;
  seq: number;
  /** The first op is a `reset`: a reader may start, or restart, the stream here. */
  baseline: boolean;
  /**
   * The Session's latest durable sequence when these ops were emitted: the
   * reader's staleness guard. An overlay older than the settled message it
   * would overwrite is dropped.
   */
  throughSequence: number;
  /** The operations' JSON text (their payloads carry arbitrary keys). */
  ops: string;
}

/** The settled message's fact, as the runner saw it recorded: the chunks go once it is accepted. */
export interface StreamChunkSettle {
  sessionId: SessionId | string;
  messageId: string;
  /** The sequence of the Session fact that settled the message. */
  sequence: number;
}

export type StreamChunkOpsResult =
  | { ok: true; ops: StreamChunkOp[] }
  | { ok: false; reason: string };

function isOpKind(value: unknown): value is StreamChunkOpKind {
  return typeof value === "string" && (STREAM_CHUNK_OPS as readonly string[]).includes(value);
}

/**
 * Checks a chunk's operations text: a non-empty JSON array of objects, each
 * with a known `op`, within the cap for its kind of chunk, and a baseline
 * starts with a `reset`. The operations themselves are the overlay fold's to
 * interpret; a fold ignores what it cannot apply, so this checks shape only.
 */
export function parseStreamChunkOps(text: string, baseline: boolean): StreamChunkOpsResult {
  const cap = baseline ? STREAM_CHUNK_BASELINE_MAX_BYTES : STREAM_CHUNK_MAX_BYTES;
  if (utf8Length(text) > cap) return { ok: false, reason: `ops exceed ${cap} bytes` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "ops are not JSON" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, reason: "ops must be a non-empty array" };
  }
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: "every op must be an object" };
    }
    if (!isOpKind((entry as { op?: unknown }).op)) {
      return { ok: false, reason: "unknown op" };
    }
  }
  const ops = parsed as StreamChunkOp[];
  if ((ops[0].op === "reset") !== baseline) {
    return {
      ok: false,
      reason: baseline ? "a baseline starts with a reset" : "a reset starts a baseline",
    };
  }
  return { ok: true, ops };
}
