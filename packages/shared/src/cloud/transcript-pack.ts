/**
 * Transcript bodies in object storage: the `volli.transcript-pack/1` format,
 * the limits a pack is cut at, and the commit vocabulary the runner and the
 * backend share.
 *
 * A Session's message bodies are content-addressed (`sha256:<hex>`, the
 * digest a `transcript.referenced` event names). They wait in the backend's
 * staging table until the runner packs the bodies referenced by one
 * contiguous range of accepted events into one object, uploads it, and
 * commits a segment row for the range. Segments tile a Session's sequence
 * space from 1 with no gaps or overlaps, so the body an event references is
 * in the segment whose range covers that event.
 *
 * Pi's own session log (its JSONL "sidecar") is uploaded beside it as raw
 * byte ranges, one object per range, keyed by the range's start offset.
 *
 * Everything here is part of a durable format or a wire contract: a value
 * that has shipped is never changed, only added to.
 */

export const TRANSCRIPT_PACK_FORMAT = "volli.transcript-pack/1";

/**
 * A pack is cut before its artifact lines pass this many bytes (uncompressed),
 * at an event boundary. One artifact larger than this is a pack of its own.
 */
export const TRANSCRIPT_PACK_MAX_BYTES = 4 * 1024 * 1024;

/** A pack is cut before it holds more artifacts than this (one commit's row writes). */
export const TRANSCRIPT_PACK_MAX_ARTIFACTS = 2048;

/** A pack is cut before its range names more turns than this. */
export const TRANSCRIPT_PACK_MAX_TURNS = 256;

/** Inside a long turn, what is accepted is packed at least this often. */
export const TRANSCRIPT_PACK_INTERVAL_MS = 10 * 60 * 1000;

/** A staged body larger than this (UTF-8 bytes) goes to object storage on its own. */
export const INLINE_ARTIFACT_MAX_BYTES = 64 * 1024;

/** Artifacts staged by one call. */
export const STAGE_ARTIFACTS_MAX_BATCH = 64;

/** A staging row is dropped this long after a committed segment covers it. */
export const PACKED_STAGING_TTL_MS = 60 * 60 * 1000;

/**
 * A Pi log segment is cut at the last complete line before this many source
 * bytes. One line longer than this is a segment of its own.
 */
export const PI_LOG_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;

/** The largest single object a runner may ask to upload. */
export const SESSION_OBJECT_MAX_BYTES = 64 * 1024 * 1024;

const ARTIFACT_DIGEST = /^sha256:([0-9a-f]{64})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Whether `value` is an artifact digest: `sha256:` and 64 lowercase hex digits. */
export function isArtifactDigest(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_DIGEST.test(value);
}

/** The hex half of an artifact digest, as object keys name it, or `null`. */
export function artifactDigestHex(digest: string): string | null {
  return ARTIFACT_DIGEST.exec(digest)?.[1] ?? null;
}

/** Whether `value` is 64 lowercase hex digits (an object's SHA-256). */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** The pack's first line. */
export interface TranscriptPackHeader {
  format: typeof TRANSCRIPT_PACK_FORMAT;
  sessionId: string;
  firstSequence: number;
  lastSequence: number;
  /** Turns any event in the range names, in first-seen order. */
  turnIds: readonly string[];
  /** The `recordedAt` of the range's last event, so a rebuilt pack is byte-identical. */
  createdAt: number;
  /** Artifact lines that follow. */
  artifactCount: number;
  /** Per-project encryption hook; `null` (object storage's own encryption at rest). */
  enc: null;
  /**
   * Digests the range references whose bodies this runner could not read
   * (lost or corrupt locally). Present only when there are some. Their
   * staging rows are not expired by the commit, so a staged copy stays the
   * place to read them.
   */
  missing?: readonly string[];
}

/** One artifact line. `body` is canonical JSON text, embedded verbatim. */
export interface TranscriptPackEntry {
  digest: string;
  mediaType: string;
  body: string;
  /**
   * The body was changed by credential redaction before upload, so it no
   * longer hashes to `digest`. The digest is still the artifact's identity
   * (the reference events carry); it is not a checksum of this body.
   */
  redacted: boolean;
}

const encoder = new TextEncoder();

/** UTF-8 length of `text`. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** One artifact line, without its newline. */
export function encodeTranscriptPackEntry(entry: TranscriptPackEntry): string {
  if (!isArtifactDigest(entry.digest)) throw new TypeError("A pack entry needs an artifact digest");
  return (
    `{"digest":${JSON.stringify(entry.digest)},"mediaType":${JSON.stringify(entry.mediaType)},` +
    `"bytes":${utf8Length(entry.body)},${entry.redacted ? `"redacted":true,` : ""}"body":${entry.body}}`
  );
}

/**
 * The pack's NDJSON text: the header line, then one line per entry, each
 * ending in a newline. Deterministic: the same range, bodies and order give
 * the same bytes, so re-uploading a rebuilt pack is a no-op.
 */
export function encodeTranscriptPack(
  header: Omit<TranscriptPackHeader, "format" | "artifactCount" | "enc">,
  entries: readonly TranscriptPackEntry[],
): string {
  const head: TranscriptPackHeader = {
    format: TRANSCRIPT_PACK_FORMAT,
    sessionId: header.sessionId,
    firstSequence: header.firstSequence,
    lastSequence: header.lastSequence,
    turnIds: header.turnIds,
    createdAt: header.createdAt,
    artifactCount: entries.length,
    enc: null,
    ...(header.missing !== undefined && header.missing.length > 0
      ? { missing: header.missing }
      : {}),
  };
  return [JSON.stringify(head), ...entries.map(encodeTranscriptPackEntry)]
    .map((line) => `${line}\n`)
    .join("");
}

// ── the commit protocol ──────────────────────────────────────────────────────

/** The producer fence a runner presents on every Session write: its claim. */
export interface SessionClaimFence {
  runnerId: string;
  generation: number;
}

/** A body staged for one Session, inline or spilled to its own object. */
export interface StagedTranscriptArtifact {
  digest: string;
  mediaType: string;
  /** UTF-8 bytes of the (redacted) canonical body. */
  bytes: number;
  /** Inline when at most {@link INLINE_ARTIFACT_MAX_BYTES}. */
  body: string | null;
  /** The `artifactSpillKey` object holding it otherwise. */
  spillKey: string | null;
  /** The referencing event's sequence, when known. */
  sequence: number | null;
}

export interface StageTranscriptArtifactsInput {
  sessionId: string;
  claim: SessionClaimFence;
  artifacts: readonly StagedTranscriptArtifact[];
}

/** Recorded after the pack's PUT; the backend checks the key, the range and the tiling. */
export interface TranscriptSegmentCommit {
  sessionId: string;
  claim: SessionClaimFence;
  segmentId: string;
  firstSequence: number;
  lastSequence: number;
  turnIds: readonly string[];
  /** `transcriptPackKey` of the range, stored verbatim. */
  key: string;
  /** The object's (compressed) size. */
  bytes: number;
  /** SHA-256 hex of the object's bytes. */
  sha256: string;
  artifactCount: number;
  /** The packed digests, whose staging rows now expire. Unique; `artifactCount` long. */
  digests: readonly string[];
}

/** Recorded after a Pi log range's PUT. Offsets are bytes of the Pi session file. */
export interface PiLogSegmentCommit {
  sessionId: string;
  claim: SessionClaimFence;
  attachmentId: string;
  piFileId: string;
  startOffset: number;
  endOffset: number;
  /** `piLogSegmentKey` at `startOffset`, stored verbatim. */
  key: string;
  bytes: number;
  sha256: string;
}

/** `duplicate`: the same object was already committed; nothing changed. */
export interface SegmentCommitResult {
  status: "committed" | "duplicate";
}

/** Where a Session's uploads stand: what a runner resumes from after any crash. */
export interface SessionUploadHead {
  /** The last sequence a committed transcript segment covers; 0 before any. */
  transcriptThrough: number;
  /** Per Pi file asked about: the end offset already committed; 0 before any. */
  piLogs: Readonly<Record<string, number>>;
}
