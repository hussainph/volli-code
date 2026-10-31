/**
 * The transcript spool (A3 §3.5): a cloud Session's history leaves the runner
 * here, as few objects as the turn allows instead of one durable file per
 * message.
 *
 * Three jobs, each idempotent and resumable from the backend's head alone:
 *
 * - **Stage** ({@link TranscriptSpool.stage}): before the events that
 *   reference them are accepted, send their bodies to the backend's staging
 *   table, inline up to 64 KB or spilled to their own object, so a viewer can
 *   read a message the moment its event is accepted.
 * - **Pack** ({@link TranscriptSpool.packTranscript}): pack the bodies the
 *   accepted events `(lastSegment.lastSequence, acceptedThrough]` reference
 *   into `volli.transcript-pack/1` objects, cut at event boundaries before
 *   4 MB, 2,048 artifacts or 256 turns, upload each and commit its segment.
 * - **Tail Pi's log** ({@link TranscriptSpool.packPiLogs}): upload the complete
 *   JSONL lines each Pi session file gained since the committed end offset.
 *   Pi writes those files itself, so they are tailed by byte offset rather
 *   than through a port into the vendored loop. Kept forever (compressed).
 *
 * Every body and every Pi line passes through the credential redactor
 * (`SecretStore.redactStreamStep`, VC-865) string by string before it is
 * staged or uploaded, and no pass runs while the redactor's history is
 * incomplete ({@link SpoolRedaction.complete}: the secret store could not be
 * read). What it cannot know: a Session-scoped value from an EARLIER launch
 * (those live in memory only), in a body or Pi line written before a relaunch
 * and uploaded after it. Staging and packing promptly keep that window small;
 * closing it needs a sealed per-Session record of injected values (VC-930).
 *
 * Crash safety: nothing local records progress. Each pass starts from the
 * backend's `head`, and a commit of the same object is a `duplicate`. A
 * pack's bytes depend only on its range's bodies, the redaction set and the
 * zstd build (its `createdAt` is its last event's `recordedAt`), so a crash
 * before the commit usually re-uploads identical bytes to the same key, and
 * otherwise replaces that still-uncommitted object; a crash after it finds
 * the range covered, and the backend never signs a committed key again. A
 * retry whose range grew (more was accepted meanwhile) uploads under a new
 * key and leaves the first object uncommitted, until the Session's prefix is
 * purged. Packing for one Session runs one pass at a time; staging has its
 * own queue, so the drain never waits behind a large upload.
 *
 * Production staging: `cloud-store/transcripts.ts` calls `stage` before
 * accepting a referencing fact, adapting the existing durable file store
 * without changing its format or flush guarantee. The cloud store's accepted
 * cursor hook and interval worker call `packTurn`, including on restart and
 * reconnect. The optional batched-durability spool store is not selected.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";

import { canonicalJson, transcriptReferenceFor } from "@volli/session-engine";
import {
  CredentialRedactionStream,
  redactJsonValue,
  type CredentialStreamStepper,
  type SessionEvent,
  type TranscriptReference,
} from "@volli/shared";
import {
  INLINE_ARTIFACT_MAX_BYTES,
  PI_LOG_LINE_MAX_BYTES,
  PI_LOG_SEGMENT_MAX_BYTES,
  STAGE_ARTIFACTS_MAX_BATCH,
  TRANSCRIPT_PACK_MAX_ARTIFACTS,
  TRANSCRIPT_PACK_MAX_BYTES,
  TRANSCRIPT_PACK_MAX_TURNS,
  artifactDigestHex,
  artifactSpillKey,
  encodeTranscriptPack,
  encodeTranscriptPackEntry,
  newId,
  piLogSegmentKey,
  transcriptPackKey,
  utf8Length,
  type PiLogSegmentCommit,
  type SegmentCommitResult,
  type SessionClaimFence,
  type SessionUploadHead,
  type StageTranscriptArtifactsInput,
  type StagedTranscriptArtifact,
  type TranscriptPackEntry,
  type TranscriptSegmentCommit,
} from "@volli/shared/cloud";

import {
  SESSION_HISTORY_ZSTD,
  SpooledArtifactUnreadableError,
  type SpoolTranscriptArtifactStore,
} from "./artifact-spool";
import type { SessionObjectStore } from "./object-store";

const compress = promisify(zstdCompress);
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** Events read from the ledger per page. */
const EVENT_PAGE = 256;
const NEWLINE = 0x0a;

/** The backend's half: `transcripts.head`, `stageArtifacts`, `commitSegment`, `commitPiLogSegment`. */
export interface TranscriptSpoolBackend {
  head(input: {
    sessionId: string;
    claim: SessionClaimFence;
    piFileIds: readonly string[];
  }): Promise<SessionUploadHead>;
  stageArtifacts(input: StageTranscriptArtifactsInput): Promise<unknown>;
  commitSegment(input: TranscriptSegmentCommit): Promise<SegmentCommitResult>;
  commitPiLogSegment(input: PiLogSegmentCommit): Promise<SegmentCommitResult>;
}

export type SpoolEvent = Pick<SessionEvent, "sequence" | "recordedAt" | "payload">;

/** The runner's ledger, as far as the spool reads it: accepted events in order. */
export interface SpoolEventSource {
  /** The highest contiguous sequence the backend has accepted. */
  acceptedThrough(sessionId: string): number | Promise<number>;
  /** Events after `afterSequence`, ascending, at most `limit`. */
  eventsAfter(
    sessionId: string,
    afterSequence: number,
    limit: number,
  ): readonly SpoolEvent[] | Promise<readonly SpoolEvent[]>;
}

/** The Session a pass works for, and the claim it writes under. */
export interface SpoolSession {
  sessionId: string;
  projectId: string;
  claim: SessionClaimFence;
}

/** One Pi session file of one of the Session's attachments. */
export interface PiLogFile {
  attachmentId: string;
  path: string;
}

export interface TranscriptSpoolLimits {
  packMaxBytes: number;
  packMaxArtifacts: number;
  packMaxTurns: number;
  piSegmentMaxBytes: number;
  /** The longest Pi line uploaded; one longer stops that file (`oversized`). */
  piLineMaxBytes: number;
}

/** The credential redactor: the secret store's stream step and whether it knows every value. */
export interface SpoolRedaction {
  /** `SecretStore.redactStreamStep`. */
  step: CredentialStreamStepper;
  /**
   * Whether the redactor's history is whole: the secret store could be read
   * (`status().state` is `ready` or `empty`). A pass refuses to run otherwise.
   */
  complete(): boolean;
}

/** A pass that would have uploaded with an incomplete redactor. Retry once the secret store opens. */
export class SpoolRedactionUnavailableError extends Error {
  constructor() {
    super("Secret storage is unavailable, so Session history is not uploaded yet.");
    this.name = "SpoolRedactionUnavailableError";
  }
}

export interface TranscriptSpoolOptions {
  artifacts: Pick<SpoolTranscriptArtifactStore, "readCanonicalBytes" | "flush">;
  objects: SessionObjectStore;
  backend: TranscriptSpoolBackend;
  events: SpoolEventSource;
  redaction: SpoolRedaction;
  /** Segment ids; a fresh UUID by default. */
  newSegmentId?: () => string;
  /** Smaller cuts, for tests. */
  limits?: Partial<TranscriptSpoolLimits>;
}

export interface StageReport {
  staged: number;
  /** Referenced bodies this machine could not read; nothing was staged for them. */
  missing: string[];
}

export interface PackedSegment {
  firstSequence: number;
  lastSequence: number;
  artifactCount: number;
  /** Referenced bodies the pack could not include (see `TranscriptPackHeader.missing`). */
  missing: string[];
  bytes: number;
  status: SegmentCommitResult["status"];
}

export interface PiLogPacked {
  piFileId: string;
  startOffset: number;
  endOffset: number;
  bytes: number;
  status: SegmentCommitResult["status"];
}

export interface PiLogReport {
  segments: PiLogPacked[];
  /** Files no longer present on this runner; other files still upload. */
  missing: string[];
  /** Files now shorter than what was already uploaded: rewritten, not appended. Left alone. */
  truncated: string[];
  /** Files whose next line is longer than one object may be: stopped there, the rest go on. */
  oversized: string[];
}

/**
 * The id a Pi session file goes by in object keys and the backend: its file
 * name without `.jsonl` (Pi names them `<timestamp>_<uuid>.jsonl`). Durable:
 * committed segments are keyed by it, so this derivation is frozen.
 */
export function piFileIdOf(path: string): string {
  const id = basename(path).replace(/\.jsonl$/u, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(id) || id.includes("..")) {
    throw new Error(`A Pi session file name cannot name an object: ${JSON.stringify(id)}`);
  }
  return id;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function turnIdOf(payload: SpoolEvent["payload"]): string | null {
  const turnId = (payload as { turnId?: unknown }).turnId;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}

interface PreparedBody {
  digest: string;
  mediaType: string;
  body: string;
  redacted: boolean;
}

interface SegmentPlan {
  firstSequence: number;
  lastSequence: number;
  createdAt: number;
  turnIds: string[];
  entries: TranscriptPackEntry[];
  missing: string[];
}

/** A line that is not JSON is redacted this many bytes at a time. */
const REDACT_PUSH_BYTES = 1024 * 1024;

export class TranscriptSpool {
  readonly #artifacts: TranscriptSpoolOptions["artifacts"];
  readonly #objects: SessionObjectStore;
  readonly #backend: TranscriptSpoolBackend;
  readonly #events: SpoolEventSource;
  readonly #redaction: SpoolRedaction;
  readonly #newSegmentId: () => string;
  readonly #limits: TranscriptSpoolLimits;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: TranscriptSpoolOptions) {
    this.#artifacts = options.artifacts;
    this.#objects = options.objects;
    this.#backend = options.backend;
    this.#events = options.events;
    this.#redaction = options.redaction;
    this.#newSegmentId = options.newSegmentId ?? (() => newId("transcriptSegment"));
    this.#limits = {
      packMaxBytes: TRANSCRIPT_PACK_MAX_BYTES,
      packMaxArtifacts: TRANSCRIPT_PACK_MAX_ARTIFACTS,
      packMaxTurns: TRANSCRIPT_PACK_MAX_TURNS,
      piSegmentMaxBytes: PI_LOG_SEGMENT_MAX_BYTES,
      piLineMaxBytes: PI_LOG_LINE_MAX_BYTES,
      ...options.limits,
    };
  }

  /** Stage the bodies `events` reference, before those events are accepted. */
  stage(session: SpoolSession, events: readonly SpoolEvent[]): Promise<StageReport> {
    return this.#exclusive(`stage:${session.sessionId}`, async () => {
      const seen = new Set<string>();
      const missing: string[] = [];
      const batch: StagedTranscriptArtifact[] = [];
      let staged = 0;
      const send = async () => {
        if (batch.length === 0) return;
        await this.#backend.stageArtifacts({
          sessionId: session.sessionId,
          claim: session.claim,
          artifacts: batch.splice(0),
        });
      };
      for (const event of events) {
        const reference = transcriptReferenceFor(event);
        if (reference === null || seen.has(reference.id)) continue;
        seen.add(reference.id);
        const prepared = await this.#prepare(reference);
        if (prepared === null) {
          missing.push(reference.id);
          continue;
        }
        batch.push(await this.#stagedForm(session, prepared, event.sequence));
        staged += 1;
        if (batch.length >= STAGE_ARTIFACTS_MAX_BATCH) await send();
      }
      await send();
      return { staged, missing };
    });
  }

  /** Pack and commit everything accepted that no segment covers yet. */
  packTranscript(session: SpoolSession): Promise<PackedSegment[]> {
    return this.#exclusive(`pack:${session.sessionId}`, async () => {
      const head = await this.#backend.head({
        sessionId: session.sessionId,
        claim: session.claim,
        piFileIds: [],
      });
      const through = await this.#events.acceptedThrough(session.sessionId);
      const packed: PackedSegment[] = [];
      for (let first = head.transcriptThrough + 1; first <= through;) {
        const plan = await this.#plan(session.sessionId, first, through);
        packed.push(await this.#commitPlan(session, plan));
        first = plan.lastSequence + 1;
      }
      return packed;
    });
  }

  /** Upload and commit the complete lines each Pi file gained since its committed end. */
  packPiLogs(session: SpoolSession, files: readonly PiLogFile[]): Promise<PiLogReport> {
    return this.#exclusive(`pack:${session.sessionId}`, async () => {
      const report: PiLogReport = { segments: [], missing: [], truncated: [], oversized: [] };
      // The backend bounds each head to 64 files. Older closed attachments
      // remain eligible, so a long-lived Session can exceed that in total.
      for (let start = 0; start < files.length; start += 64) {
        const batch = files.slice(start, start + 64);
        const ids = batch.map((file) => piFileIdOf(file.path));
        const head = await this.#backend.head({
          sessionId: session.sessionId,
          claim: session.claim,
          piFileIds: ids,
        });
        for (const [index, file] of batch.entries()) {
          const piFileId = ids[index]!;
          try {
            await this.#tail(session, file, piFileId, head.piLogs[piFileId] ?? 0, report);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            report.missing.push(piFileId);
          }
        }
      }
      return report;
    });
  }

  /**
   * A turn's end (or a long turn's interval): make the spooled bodies durable
   * here, then pack what is accepted and tail the Pi logs.
   */
  async packTurn(
    session: SpoolSession,
    files: readonly PiLogFile[],
  ): Promise<{ transcript: PackedSegment[]; piLogs: PiLogReport }> {
    // A failed flush must not keep what can be packed from leaving: pack,
    // then report the flush's failure.
    const flushed = this.#artifacts.flush().then(
      () => null,
      (error: unknown) => ({ error }),
    );
    const transcript = await this.packTranscript(session);
    const piLogs = await this.packPiLogs(session, files);
    const failure = await flushed;
    if (failure !== null) throw failure.error;
    return { transcript, piLogs };
  }

  // ── transcript packs ───────────────────────────────────────────────────────

  async #plan(sessionId: string, first: number, through: number): Promise<SegmentPlan> {
    const plan: SegmentPlan = {
      firstSequence: first,
      lastSequence: first - 1,
      createdAt: 0,
      turnIds: [],
      entries: [],
      missing: [],
    };
    const included = new Set<string>();
    let size = 0;
    let after = first - 1;
    while (plan.lastSequence < through) {
      const page = await this.#events.eventsAfter(sessionId, after, EVENT_PAGE);
      if (page.length === 0) {
        throw new Error(`The ledger has no event ${after + 1}, which the backend accepted`);
      }
      for (const event of page) {
        if (event.sequence !== plan.lastSequence + 1) {
          throw new Error(`The ledger skips from ${plan.lastSequence} to ${event.sequence}`);
        }
        if (event.sequence > through) return plan;
        const turnId = turnIdOf(event.payload);
        const newTurn = turnId !== null && !plan.turnIds.includes(turnId);
        const reference = transcriptReferenceFor(event);
        let entry: TranscriptPackEntry | null = null;
        let entryBytes = 0;
        let lost: string | null = null;
        if (
          reference !== null &&
          !included.has(reference.id) &&
          !plan.missing.includes(reference.id)
        ) {
          entry = await this.#prepare(reference);
          if (entry === null) lost = reference.id;
          else entryBytes = utf8Length(encodeTranscriptPackEntry(entry)) + 1;
        }
        const nonEmpty = plan.lastSequence >= first;
        const full =
          (entry !== null &&
            (size + entryBytes > this.#limits.packMaxBytes ||
              plan.entries.length >= this.#limits.packMaxArtifacts)) ||
          (newTurn && plan.turnIds.length >= this.#limits.packMaxTurns);
        // Cut before this event; one event alone always fits, however large.
        if (nonEmpty && full) return plan;
        plan.lastSequence = event.sequence;
        plan.createdAt = event.recordedAt;
        if (newTurn) plan.turnIds.push(turnId);
        if (entry !== null) {
          plan.entries.push(entry);
          included.add(entry.digest);
          size += entryBytes;
        }
        if (lost !== null) plan.missing.push(lost);
      }
      after = page.at(-1)!.sequence;
    }
    return plan;
  }

  async #commitPlan(session: SpoolSession, plan: SegmentPlan): Promise<PackedSegment> {
    const text = encodeTranscriptPack(
      {
        sessionId: session.sessionId,
        firstSequence: plan.firstSequence,
        lastSequence: plan.lastSequence,
        turnIds: plan.turnIds,
        createdAt: plan.createdAt,
        missing: plan.missing,
      },
      plan.entries,
    );
    const body = await compress(Buffer.from(text, "utf8"), SESSION_HISTORY_ZSTD);
    const sha256 = sha256Hex(body);
    const key = transcriptPackKey({
      projectId: session.projectId,
      sessionId: session.sessionId,
      firstSequence: plan.firstSequence,
      lastSequence: plan.lastSequence,
    });
    await this.#objects.put({ key, body, sha256 }, session);
    const { status } = await this.#backend.commitSegment({
      sessionId: session.sessionId,
      claim: session.claim,
      segmentId: this.#newSegmentId(),
      firstSequence: plan.firstSequence,
      lastSequence: plan.lastSequence,
      turnIds: plan.turnIds,
      key,
      bytes: body.length,
      sha256,
      artifactCount: plan.entries.length,
      digests: plan.entries.map((entry) => entry.digest),
    });
    return {
      firstSequence: plan.firstSequence,
      lastSequence: plan.lastSequence,
      artifactCount: plan.entries.length,
      missing: plan.missing,
      bytes: body.length,
      status,
    };
  }

  // ── bodies ─────────────────────────────────────────────────────────────────

  /** The body, redacted, or `null` when this machine cannot read it. */
  async #prepare(reference: TranscriptReference): Promise<PreparedBody | null> {
    let bytes: Buffer;
    try {
      bytes = await this.#artifacts.readCanonicalBytes(reference);
    } catch (error) {
      if (error instanceof SpooledArtifactUnreadableError) return null;
      throw error;
    }
    const text = bytes.toString("utf8");
    const { value, changed } = redactJsonValue(JSON.parse(text) as unknown, this.#redaction.step);
    return {
      digest: reference.id,
      mediaType: reference.mediaType ?? "application/json",
      body: changed ? canonicalJson(value) : text,
      redacted: changed,
    };
  }

  async #stagedForm(
    session: SpoolSession,
    prepared: PreparedBody,
    sequence: number,
  ): Promise<StagedTranscriptArtifact> {
    const bytes = utf8Length(prepared.body);
    if (bytes <= INLINE_ARTIFACT_MAX_BYTES) {
      return {
        digest: prepared.digest,
        mediaType: prepared.mediaType,
        bytes,
        body: prepared.body,
        spillKey: null,
        sequence,
      };
    }
    const body = await compress(Buffer.from(prepared.body, "utf8"), SESSION_HISTORY_ZSTD);
    const key = artifactSpillKey({
      projectId: session.projectId,
      sessionId: session.sessionId,
      sha256: artifactDigestHex(prepared.digest)!,
    });
    await this.#objects.put({ key, body, sha256: sha256Hex(body) }, session);
    return {
      digest: prepared.digest,
      mediaType: prepared.mediaType,
      bytes,
      body: null,
      spillKey: key,
      sequence,
    };
  }

  // ── Pi logs ────────────────────────────────────────────────────────────────

  async #tail(
    session: SpoolSession,
    file: PiLogFile,
    piFileId: string,
    from: number,
    report: PiLogReport,
  ): Promise<void> {
    let offset = from;
    for (;;) {
      const source = await this.#completeLines(file.path, offset, piFileId, report);
      if (source === null) return;
      const body = await compress(this.#redactLines(source), SESSION_HISTORY_ZSTD);
      const sha256 = sha256Hex(body);
      const key = piLogSegmentKey({
        projectId: session.projectId,
        sessionId: session.sessionId,
        attachmentId: file.attachmentId,
        piFileId,
        offset,
      });
      await this.#objects.put({ key, body, sha256 }, session);
      const endOffset = offset + source.length;
      const { status } = await this.#backend.commitPiLogSegment({
        sessionId: session.sessionId,
        claim: session.claim,
        attachmentId: file.attachmentId,
        piFileId,
        startOffset: offset,
        endOffset,
        key,
        bytes: body.length,
        sha256,
      });
      report.segments.push({
        piFileId,
        startOffset: offset,
        endOffset,
        bytes: body.length,
        status,
      });
      offset = endOffset;
    }
  }

  /**
   * The next run of complete lines at `offset`: up to the segment cap, or one
   * longer line whole. `null` when there is no complete line yet (a line Pi is
   * still writing waits for the next pass), the file shrank below `offset`, or
   * its next line is longer than one object may be (both reported). A longer
   * line's end is found a segment's worth at a time, then the line is read
   * once: never more than the line itself and one segment held.
   */
  async #completeLines(
    path: string,
    offset: number,
    piFileId: string,
    report: PiLogReport,
  ): Promise<Buffer | null> {
    const handle = await open(path, READ_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`A Pi session file is not a regular file: ${piFileId}`);
      if (info.size < offset) {
        report.truncated.push(piFileId);
        return null;
      }
      const available = info.size - offset;
      if (available === 0) return null;
      const window = Buffer.alloc(Math.min(available, this.#limits.piSegmentMaxBytes));
      const first = await handle.read(window, 0, window.length, offset);
      // Within the cap: every complete line.
      const end = window.subarray(0, first.bytesRead).lastIndexOf(NEWLINE) + 1;
      if (end > 0) return window.subarray(0, end);
      // Past it: the one long line alone.
      for (let scanned = first.bytesRead; ;) {
        if (scanned >= available) return null;
        if (scanned >= this.#limits.piLineMaxBytes) {
          report.oversized.push(piFileId);
          return null;
        }
        const length = Math.min(window.length, available - scanned);
        const { bytesRead } = await handle.read(window, 0, length, offset + scanned);
        const newline = window.subarray(0, bytesRead).indexOf(NEWLINE);
        if (newline === -1) {
          scanned += bytesRead;
          if (bytesRead < length) return null;
          continue;
        }
        const lineBytes = scanned + newline + 1;
        if (lineBytes > this.#limits.piLineMaxBytes) {
          report.oversized.push(piFileId);
          return null;
        }
        const line = Buffer.alloc(lineBytes);
        const read = await handle.read(line, 0, lineBytes, offset);
        if (read.bytesRead !== lineBytes) throw new Error(`A Pi session file shrank: ${piFileId}`);
        return line;
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Each line redacted on its own: decoded JSON when it parses, its bytes when
   * not. Nothing changed, the source itself: a long line is never copied for a no-op.
   */
  #redactLines(source: Buffer): Buffer {
    const out: Buffer[] = [];
    let changed = false;
    let start = 0;
    while (start < source.length) {
      const end = source.indexOf(NEWLINE, start);
      const line = source.subarray(start, end);
      const redacted = this.#redactLine(line);
      if (redacted !== line) changed = true;
      out.push(redacted, Buffer.from([NEWLINE]));
      start = end + 1;
    }
    return changed ? Buffer.concat(out) : source;
  }

  #redactLine(line: Buffer): Buffer {
    if (line.length === 0) return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      // In pieces, as `redactString` does: a step's memory grows with its window.
      const stream = new CredentialRedactionStream(this.#redaction.step);
      const out: Uint8Array[] = [];
      for (let at = 0; at < line.length; at += REDACT_PUSH_BYTES)
        out.push(stream.push(line.subarray(at, at + REDACT_PUSH_BYTES)));
      out.push(stream.end());
      return Buffer.concat(out);
    }
    const { value, changed } = redactJsonValue(parsed, this.#redaction.step);
    return changed ? Buffer.from(JSON.stringify(value), "utf8") : line;
  }

  // ── one pass per queue at a time, and only with a whole redactor ──────────

  #exclusive<T>(queue: string, task: () => Promise<T>): Promise<T> {
    const work = () => {
      if (!this.#redaction.complete()) throw new SpoolRedactionUnavailableError();
      return task();
    };
    const previous = this.#queues.get(queue) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(queue, settled);
    void settled.then(() => {
      if (this.#queues.get(queue) === settled) this.#queues.delete(queue);
    });
    return run;
  }
}
