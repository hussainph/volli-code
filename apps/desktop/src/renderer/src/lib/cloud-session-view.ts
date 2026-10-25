/**
 * What the cloud Session reads say, read defensively (VC-931).
 *
 * The cloud chat transport (`cloud-session-transport.ts`) answers the chat
 * core's Session edge from Convex instead of IPC. Everything it gets back
 * crossed a socket as JSON, so this module is the one place those answers are
 * read and turned into the shapes the chat core already folds:
 *
 * - `sessions.snapshot` → a {@link ChatSessionProjection} plus the sequence
 *   the fold reached (the bounded `CloudSessionView` from `@volli/shared/cloud`,
 *   scrubbed by the backend). Commands and receipts stay in the cloud, so a
 *   cloud projection never carries a scheduled resume.
 * - `sessions.history` → ordered entries, each with the transcript reference
 *   its event names (bodies are hydrated by `cloud-transcript-reader.ts`).
 * - `streamChunks.since` → transcript overlays, through the per-stream seq
 *   rules of `@volli/shared/cloud`'s stream-chunks: a gap ignores the stream
 *   until its next baseline.
 *
 * A malformed field of a known shape is corruption and throws; a history row
 * this build cannot read (unknown kind, quarantined) is kept as an entry with
 * no event, so its sequence still advances the reader's cursor.
 */
import type { SessionLatestReply, SessionStreamOverlay } from "@volli/session-engine";
import { chatSessionOverlay, type ChatSessionProjection } from "@volli/session-presentation";
import { parseRendererSessionEvent } from "@volli/shared";
import type {
  RendererSessionEvent,
  Session,
  SessionReplyLocation,
  TranscriptReference,
} from "@volli/shared";
import { parseStreamChunkOps } from "@volli/shared/cloud";
import type { UIMessage } from "ai";

/**
 * The most stream cursors one `streamChunks.since` read takes: the backend's
 * `SINCE_MAX_STREAMS`, which refuses a read naming more.
 */
export const CHUNK_STREAMS_MAX = 16;

/** What every Session write answers in a cloud launch until the runner inbox is wired. */
export const CLOUD_SESSION_UNAVAILABLE = "Not available yet in cloud";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function malformed(what: string): Error {
  return new Error(`The cloud ${what} is malformed`);
}

/* ------------------------------------------------------------- the snapshot */

export interface CloudSnapshotRead {
  projection: ChatSessionProjection;
  /** Every accepted fact through this sequence is folded into `projection`. */
  throughSequence: number;
  /** Where the current turn's latest reply is recorded, when it has one. */
  latestReply: SessionReplyLocation | null;
}

/** The message a snapshot that never gained a fold is refused with. */
export const CLOUD_SESSION_ARRIVING = "This Session's history is still arriving";

/**
 * Whether a `sessions.snapshot` answer is one to draw for a reader that has
 * seen the facts through `through`: the backend has folded a state, is not
 * catching up, and its fold has reached `through`. Anything else is a state
 * to wait for. An answer that is not a snapshot at all is settled — its
 * reading fails it.
 */
export function cloudSnapshotSettled(value: unknown, through: number): boolean {
  if (!isRecord(value)) return true;
  if (value.state === null || value.catchingUp === true) return false;
  return !(typeof value.foldedThrough === "number" && value.foldedThrough < through);
}

/**
 * `sessions.snapshot`'s answer. A Session the backend has not folded a fact
 * of yet has no state to show, which is a failure the reader can retry, not
 * an empty Session (the transport waits a while for one first).
 */
export function readCloudSnapshot(value: unknown): CloudSnapshotRead {
  if (!isRecord(value) || !isSequence(value.foldedThrough)) throw malformed("Session snapshot");
  if (value.state === null) throw new Error(CLOUD_SESSION_ARRIVING);
  if (typeof value.state !== "string") throw malformed("Session snapshot");
  let view: unknown;
  try {
    view = JSON.parse(value.state);
  } catch {
    throw malformed("Session state");
  }
  const projection = cloudProjection(view);
  return {
    projection,
    throughSequence: value.foldedThrough,
    latestReply: readReplyLocation((view as JsonRecord).latestReply),
  };
}

function nullableRecord(value: unknown, field: string): JsonRecord | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw malformed(`Session state's ${field}`);
  return value;
}

function recordArray(value: unknown, field: string): JsonRecord[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw malformed(`Session state's ${field}`);
  return value;
}

/**
 * The renderer-safe `CloudSessionView` JSON the backend sends, as the
 * projection the chat core draws. Nested values (attention, interactions,
 * the Session row) were built and scrubbed by the shared codec on the
 * backend; the shapes the chat core reads straight off are checked here.
 */
export function cloudProjection(view: unknown): ChatSessionProjection {
  if (!isRecord(view)) throw malformed("Session state");
  const session = view.session;
  if (!isRecord(session) || typeof session.id !== "string" || typeof session.projectId !== "string")
    throw malformed("Session state's session");
  if (view.status !== "open" && view.status !== "archived")
    throw malformed("Session state's status");
  if (typeof view.turnActive !== "boolean") throw malformed("Session state's turnActive");
  if (typeof view.bornTicketless !== "boolean") throw malformed("Session state's bornTicketless");
  if (!isSequence(view.lastActivityAt)) throw malformed("Session state's lastActivityAt");
  const attention = view.attention;
  if (!isRecord(attention)) throw malformed("Session state's attention");
  const active = recordArray(attention.active, "attention");
  const primary = nullableRecord(attention.primary, "attention");
  const interactions = view.interactions;
  if (!isRecord(interactions)) throw malformed("Session state's interactions");
  const opened = recordArray(interactions.active, "interactions");
  const live = nullableRecord(view.liveAttachment, "liveAttachment");
  if (live !== null && typeof live.id !== "string")
    throw malformed("Session state's liveAttachment");
  const signal = nullableRecord(view.signal, "signal");
  const modelSelection = nullableRecord(view.modelSelection, "modelSelection");
  if (view.modelTier !== null && view.modelTier !== undefined && typeof view.modelTier !== "string")
    throw malformed("Session state's modelTier");
  const modelAuto = nullableRecord(view.modelAuto, "modelAuto");
  const todoList = nullableRecord(view.todoList, "todoList");
  // Structural above, trusted below: the backend encoded these with the codec.
  const projection: ChatSessionProjection = {
    session: session as unknown as Session,
    status: view.status,
    signal: signal as ChatSessionProjection["signal"],
    modelSelection: modelSelection as ChatSessionProjection["modelSelection"],
    modelTier: (view.modelTier ?? null) as ChatSessionProjection["modelTier"],
    turnActive: view.turnActive,
    lastActivityAt: view.lastActivityAt,
    bornTicketless: view.bornTicketless,
    attention: {
      active: active as unknown as ChatSessionProjection["attention"]["active"],
      primary: primary as unknown as ChatSessionProjection["attention"]["primary"],
    },
    // Resolved history is the ledger's, not the bounded fold's.
    interactions: {
      active: opened as unknown as ChatSessionProjection["interactions"]["active"],
      resolved: [],
    },
    liveExecutor: live === null ? null : { id: live.id as string },
    // Derived from commands and receipts, which the cloud fold does not keep.
    scheduledResume: null,
    ...(modelAuto === null
      ? {}
      : { modelAuto: modelAuto as unknown as NonNullable<ChatSessionProjection["modelAuto"]> }),
    ...(todoList === null
      ? {}
      : { todoList: todoList as unknown as NonNullable<ChatSessionProjection["todoList"]> }),
  };
  return projection;
}

function readReference(value: unknown): TranscriptReference | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const mediaType = typeof value.mediaType === "string" ? value.mediaType : null;
  const digest = typeof value.digest === "string" ? value.digest : null;
  return { id: value.id, mediaType, digest };
}

function readReplyLocation(value: unknown): SessionReplyLocation | null {
  if (!isRecord(value) || !isSequence(value.sequence) || value.sequence === 0) return null;
  const reference = readReference(value.reference);
  return reference === null ? null : { sequence: value.sequence, reference };
}

/* -------------------------------------------------------------- the history */

/** One accepted fact, as the chat core will be handed it. */
export interface CloudHistoryEntry {
  sequence: number;
  /** The renderer-safe event's JSON value; `null` for a fact this build cannot read. */
  event: unknown;
  /** The transcript body this fact records, when it records one. */
  reference: TranscriptReference | null;
  /** The turn this fact ends (`turn.completed`, `turn.interrupted`), when it ends one. */
  endsTurn: string | null;
}

export interface CloudHistoryRead {
  /** Ascending by sequence. */
  entries: CloudHistoryEntry[];
  hasMore: boolean;
}

/** `sessions.history`'s answer. */
export function readCloudHistory(value: unknown): CloudHistoryRead {
  if (!isRecord(value) || !Array.isArray(value.events) || typeof value.hasMore !== "boolean")
    throw malformed("Session history");
  const entries = value.events.map((row): CloudHistoryEntry => {
    if (!isRecord(row) || !isSequence(row.sequence) || row.sequence === 0)
      throw malformed("Session history");
    if (row.status !== "ok" || typeof row.event !== "string") {
      return { sequence: row.sequence, event: null, reference: null, endsTurn: null };
    }
    let event: unknown;
    try {
      event = JSON.parse(row.event);
    } catch {
      throw malformed(`Session event ${row.sequence}`);
    }
    const parsed = parseRendererSessionEvent(event, "cloud.history.event");
    // A kind this build does not know keeps its envelope; a known kind that
    // does not read is corruption.
    if (!parsed.ok && parsed.reason === "malformed") {
      throw new Error(`The cloud Session event ${row.sequence} is malformed: ${parsed.message}`);
    }
    return {
      sequence: row.sequence,
      event,
      reference: parsed.ok ? transcriptReferenceOf(parsed.event) : null,
      endsTurn: parsed.ok ? endedTurnOf(parsed.event) : null,
    };
  });
  entries.sort((left, right) => left.sequence - right.sequence);
  return { entries, hasMore: value.hasMore };
}

/**
 * The transcript body a renderer-safe event records: a referenced transcript
 * message, or the message a person submitted or answered with. The read side
 * of `transcriptReferenceFor` in `@volli/session-engine`, over the scrubbed
 * event the renderer holds.
 */
export function transcriptReferenceOf(event: RendererSessionEvent): TranscriptReference | null {
  const payload = event.payload;
  if (payload.kind === "transcript.referenced") return payload.reference;
  if (payload.kind === "command.recorded") {
    const intent = payload.command.intent;
    if (intent.kind === "message.submit" || intent.kind === "interaction.resolve") {
      return intent.reference;
    }
  }
  return null;
}

/** The turn a renderer-safe event ends, as the backend's stream cleanup reads it. */
export function endedTurnOf(event: RendererSessionEvent): string | null {
  const payload = event.payload;
  return payload.kind === "turn.completed" || payload.kind === "turn.interrupted"
    ? payload.turnId
    : null;
}

/**
 * The frame the chat core folds: the IPC edge's shape, with the body inlined.
 * Facts this build cannot read become no frame; the caller still moves its
 * cursor past them.
 */
export function cloudFrames(
  sessionId: string,
  entries: readonly CloudHistoryEntry[],
  messages: ReadonlyMap<number, UIMessage>,
): unknown[] {
  return entries.flatMap((entry) => {
    if (entry.event === null) return [];
    const message = messages.get(entry.sequence);
    return [
      {
        sessionId,
        sequence: entry.sequence,
        event: entry.event,
        transcript: message === undefined ? null : { message },
      },
    ];
  });
}

/** A transcript body (an artifact, or a bare message) as the message the chat draws. */
export function readTranscriptMessage(value: unknown): UIMessage | null {
  const message = isRecord(value) && isRecord(value.message) ? value.message : value;
  if (
    !isRecord(message) ||
    typeof message.id !== "string" ||
    (message.role !== "user" && message.role !== "assistant" && message.role !== "system") ||
    !Array.isArray(message.parts) ||
    !message.parts.every(isRecord)
  ) {
    return null;
  }
  return message as unknown as UIMessage;
}

/** The snapshot's reply baseline, when its message is at hand and says something. */
export function cloudLatestReply(
  location: SessionReplyLocation | null,
  message: UIMessage | undefined,
  replyText: (message: UIMessage) => string | null,
): SessionLatestReply | null {
  if (location === null || message === undefined) return null;
  const text = replyText(message);
  return text === null ? null : { sequence: location.sequence, text };
}

/* --------------------------------------------------------- streamed chunks */

interface StreamCursor {
  /** The last seq folded. */
  seq: number;
  /** A seq went missing after it: ignore the stream until its next baseline. */
  gap: boolean;
  touched: number;
  turnId: string | null;
}

/** Ended turns remembered, so a late chunk of one is not drawn again. */
const ENDED_TURNS_KEPT = 64;
/** Ended streams whose watermark is remembered, so a delayed chunk of one is not drawn again. */
const RETIRED_STREAMS_KEPT = 256;

function readRetired(value: unknown): { messageId: string; throughSequence: number }[] {
  // Absent from a backend that predates it.
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        isRecord(entry) && typeof entry.messageId === "string" && isSequence(entry.throughSequence),
    )
  ) {
    throw malformed("stream chunk answer");
  }
  return value as { messageId: string; throughSequence: number }[];
}

/** Whether a chunk's operations remove the message it streams. */
function removesMessage(ops: string): boolean {
  const parsed = parseStreamChunkOps(ops, false);
  return parsed.ok && parsed.ops.some((entry) => entry.op === "message.remove");
}

/**
 * The reader's side of streamed text: which chunk of each stream it folded
 * last, the overlays each new answer of `streamChunks.since` adds, and the
 * removals that end a stream.
 *
 * A chunk is folded only right after the one before it, or when it is a
 * baseline (a `reset` of the whole message). Anything else is a gap, and the
 * stream is ignored until its next baseline, which the backend serves from
 * the cursor on its own — except a chunk that removes the message, which
 * still removes it.
 *
 * A stream is drawn under the runner's streaming id, which need not be the
 * id of the message that settles it, so nothing in the transcript fold ends
 * it. It ends here, as a `message.remove` overlay:
 * - when the backend says its rows are gone (`retired`), once the history
 *   has reached the accepted cursor it names, so the settled message is
 *   drawn before the stream is taken away;
 * - when its turn ends ({@link CloudChunkFold.turnEnded}); a late chunk of
 *   that turn is ignored;
 * - when its cursor is dropped to stay within the backend's limit (the least
 *   recently moved stream goes first).
 *
 * An ended stream (retired, or its turn ended) keeps a watermark: a delayed
 * chunk of it written before that point — a stale baseline a late read still
 * serves — is ignored rather than drawn again. A baseline written at or after
 * it is a stream that legitimately started again.
 */
export class CloudChunkFold {
  readonly #sessionId: string;
  readonly #streams = new Map<string, StreamCursor>();
  /** Ended streams, by the history cursor their removal waits for. */
  readonly #retiring = new Map<string, number>();
  readonly #endedTurns: string[] = [];
  /** Ended streams, by the durable sequence a chunk must reach to draw them again. */
  readonly #watermarks = new Map<string, number>();
  #tick = 0;

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  /** The cursors `streamChunks.since` takes, most recently moved first. */
  cursors(): { messageId: string; seq: number }[] {
    return [...this.#streams.entries()]
      .toSorted(([, left], [, right]) => right.touched - left.touched)
      .map(([messageId, cursor]) => ({ messageId, seq: cursor.seq }));
  }

  /**
   * The overlays one answer adds, in order, and whether the cursors moved (so
   * the caller re-reads from them). `historyCursor` is the last fact the
   * reader has delivered.
   */
  read(
    value: unknown,
    historyCursor: number,
  ): { overlays: SessionStreamOverlay[]; moved: boolean } {
    if (!isRecord(value) || !Array.isArray(value.streams)) throw malformed("stream chunk answer");
    const retired = readRetired(value.retired);
    const overlays: SessionStreamOverlay[] = [];
    let moved = false;
    for (const stream of value.streams) {
      if (
        !isRecord(stream) ||
        typeof stream.messageId !== "string" ||
        !Array.isArray(stream.chunks)
      )
        throw malformed("stream chunk answer");
      const turnId = typeof stream.turnId === "string" ? stream.turnId : null;
      if (turnId !== null && this.#endedTurns.includes(turnId)) continue;
      for (const chunk of stream.chunks) {
        if (
          !isRecord(chunk) ||
          !isSequence(chunk.seq) ||
          typeof chunk.baseline !== "boolean" ||
          !isSequence(chunk.throughSequence) ||
          typeof chunk.ops !== "string"
        ) {
          throw malformed("stream chunk");
        }
        const folded = this.#fold(stream.messageId, turnId, {
          seq: chunk.seq,
          baseline: chunk.baseline,
          throughSequence: chunk.throughSequence,
          ops: chunk.ops,
        });
        if (folded === null) continue;
        moved = true;
        overlays.push(...folded);
      }
    }
    for (const { messageId, throughSequence } of retired) {
      if (!this.#streams.delete(messageId)) continue;
      moved = true;
      this.#retiring.set(messageId, throughSequence);
      this.#ended(messageId, throughSequence);
    }
    overlays.push(...this.#bound(), ...this.due(historyCursor));
    return { overlays, moved };
  }

  /** The removals of ended streams the history has now caught up with. */
  due(historyCursor: number): SessionStreamOverlay[] {
    const overlays: SessionStreamOverlay[] = [];
    for (const [messageId, through] of this.#retiring) {
      if (through > historyCursor) continue;
      this.#retiring.delete(messageId);
      overlays.push(this.#removal(messageId, through));
    }
    return overlays;
  }

  /**
   * A turn's end was delivered: its streams are over. Their removals, and
   * whether the cursors moved.
   */
  turnEnded(
    turnId: string,
    throughSequence: number,
  ): { overlays: SessionStreamOverlay[]; moved: boolean } {
    this.#endedTurns.push(turnId);
    if (this.#endedTurns.length > ENDED_TURNS_KEPT) this.#endedTurns.shift();
    const overlays: SessionStreamOverlay[] = [];
    for (const [messageId, cursor] of this.#streams) {
      if (cursor.turnId !== turnId) continue;
      this.#streams.delete(messageId);
      this.#ended(messageId, throughSequence);
      overlays.push(this.#removal(messageId, throughSequence));
    }
    return { overlays, moved: overlays.length > 0 };
  }

  #fold(
    messageId: string,
    turnId: string | null,
    chunk: { seq: number; baseline: boolean; throughSequence: number; ops: string },
  ): SessionStreamOverlay[] | null {
    // Written before the stream ended: a delayed chunk, not a restart.
    if (chunk.throughSequence < (this.#watermarks.get(messageId) ?? 0)) return null;
    const cursor = this.#streams.get(messageId);
    // Already folded: the same answer again, or a re-read that overlaps.
    if (cursor !== undefined && chunk.seq <= cursor.seq) return null;
    const next = cursor !== undefined && !cursor.gap && chunk.seq === cursor.seq + 1;
    if (!chunk.baseline && !next) {
      // Nothing drawn of a stream never started; a gapped one waits for a baseline.
      if (cursor === undefined) return null;
      cursor.gap = true;
      if (!removesMessage(chunk.ops)) return null;
      // A removal past the gap still ends what was drawn.
      cursor.seq = chunk.seq;
      cursor.touched = this.#tick += 1;
      return [this.#removal(messageId, chunk.throughSequence)];
    }
    const overlays = this.#overlays(messageId, chunk);
    if (overlays === null) {
      // An unreadable chunk is a gap too: what follows it would fold onto a
      // message missing its edits.
      if (cursor !== undefined) cursor.gap = true;
      return null;
    }
    this.#retiring.delete(messageId);
    this.#streams.set(messageId, {
      seq: chunk.seq,
      gap: false,
      touched: (this.#tick += 1),
      turnId,
    });
    return overlays;
  }

  #overlays(
    messageId: string,
    chunk: { baseline: boolean; throughSequence: number; ops: string },
  ): SessionStreamOverlay[] | null {
    const parsed = parseStreamChunkOps(chunk.ops, chunk.baseline);
    if (!parsed.ok) return null;
    const overlays: SessionStreamOverlay[] = [];
    for (const delta of parsed.ops) {
      const overlay = chatSessionOverlay({
        kind: "overlay",
        sessionId: this.#sessionId,
        throughSequence: chunk.throughSequence,
        messageId,
        delta,
      });
      if (overlay === null) return null;
      overlays.push(overlay);
    }
    return overlays;
  }

  #ended(messageId: string, throughSequence: number): void {
    this.#watermarks.delete(messageId);
    this.#watermarks.set(messageId, throughSequence);
    if (this.#watermarks.size > RETIRED_STREAMS_KEPT) {
      this.#watermarks.delete(this.#watermarks.keys().next().value as string);
    }
  }

  #removal(messageId: string, throughSequence: number): SessionStreamOverlay {
    return {
      kind: "overlay",
      sessionId: this.#sessionId,
      throughSequence,
      messageId,
      delta: { op: "message.remove" },
    };
  }

  /** Drops the least recently moved cursors past the backend's limit, and what they drew. */
  #bound(): SessionStreamOverlay[] {
    return this.cursors()
      .slice(CHUNK_STREAMS_MAX)
      .map(({ messageId }) => {
        this.#streams.delete(messageId);
        return this.#removal(messageId, 0);
      });
  }
}
