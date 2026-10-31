/** Bulk history carried by the export, not yet uploaded. MOVE-4 consumes these
 * canonical bodies / offset-pinned Pi bytes to produce the real tx/pi segments.
 * No machine path is in a record. Memory is bounded by one artifact or Pi slice.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import type { TranscriptReference } from "@volli/shared";
import { blobFilePath } from "../blob-store";
import { FileTranscriptArtifactStore } from "../session-runtime/transcript-artifacts";
import { piFileIdOf } from "../transcript-spool/transcript-spool";
import { STRUCTURED_ADAPTER_ID } from "../session-runtime/sessions";
import { SourceCorruptError } from "./sources";
import { DEFAULT_CHUNK_MAX_BYTES, DEFAULT_CHUNK_MAX_RECORDS } from "./records";
import {
  chunkFileName,
  hashFile,
  writeFileDurably,
  type Checkpoint,
  type ChunkEntry,
} from "./staging";

export interface TranscriptArtifactRecord {
  projectId: string;
  sessionId: string;
  sequence: number;
  digest: string;
  /** Verified, uncompressed canonical JSON. Its bytes define the durable digest. */
  canonicalJson: string;
}
export interface PiLogRecord {
  projectId: string;
  sessionId: string;
  attachmentId: string;
  piFileId: string;
  startOffset: number;
  endOffset: number;
  fileBytes: number;
  sourceSha256: string;
  sourceBytes: number;
  /** Exact source bytes; the uploader redacts and compresses, retaining offsets. */
  base64: string;
}
export type PiLogFileCoverage = Pick<
  PiLogRecord,
  "sessionId" | "attachmentId" | "piFileId" | "fileBytes"
>;
export interface FileStreamOptions {
  chunkMaxBytes?: number;
  chunkMaxRecords?: number;
  transcriptsDir: string;
  piLogsDir: string;
  blobsDir: string;
  signal?: AbortSignal;
  /**
   * Read and check every artifact and Pi file exactly as a copy does, but
   * write none of their bytes: what a dry run needs to know (would the move's
   * export refuse, and how much history would it carry) without staging the
   * whole history a second time on disk. Its export is never a move's.
   */
  measureOnly?: boolean;
  /** History records read so far, across both streams; for progress, at most every few hundred. */
  onRecords?: (read: number) => void;
}

/** What a measuring export read instead of copying (`measureOnly`). */
export interface MeasuredHistory {
  /** Transcript artifacts read and verified, one per `transcript.referenced` event. */
  transcripts: number;
  /** Their verified canonical JSON bytes, as a copy would carry them. */
  transcriptBytes: number;
  /** Pi log slices a copy would carry. */
  piSlices: number;
  /** Pi log source bytes read and checked. */
  piLogBytes: number;
}
const PI_SLICE_BYTES = 1024 * 1024;
const HISTORY_PROGRESS_EVERY = 256;
/** Transcript artifacts read ahead of the one being yielded. Memory: this many artifacts. */
const ARTIFACT_READ_AHEAD = 32;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

interface ArtifactRow {
  project_id: string;
  session_id: string;
  sequence: number;
  payload: string;
}

interface PendingArtifact {
  row: ArtifactRow;
  payload: { reference: TranscriptReference };
  bytes: Promise<{ ok: true; value: Buffer } | { ok: false; error: unknown }>;
}

/** One read-ahead artifact, checked in its turn: a refusal names its row. */
async function settleArtifact(next: PendingArtifact): Promise<TranscriptArtifactRecord> {
  const { row, payload } = next;
  const outcome = await next.bytes;
  let bytes: Buffer;
  try {
    if (!outcome.ok) throw outcome.error;
    bytes = outcome.value;
    // The event's `digest` is a SessionTranscriptDigest (message semantics),
    // not a checksum. The store validates reference.digest against its id and bytes.
    if (!Buffer.from(bytes.toString("utf8")).equals(bytes))
      throw new Error("artifact is not UTF-8 JSON");
  } catch (error) {
    throw new SourceCorruptError(
      `transcript ${row.session_id}:${row.sequence} missing or corrupt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    projectId: row.project_id,
    sessionId: row.session_id,
    sequence: row.sequence,
    digest: payload.reference.id,
    canonicalJson: bytes.toString("utf8"),
  };
}

async function* artifacts(
  db: Database.Database,
  options: FileStreamOptions,
): AsyncGenerator<TranscriptArtifactRecord> {
  const store = new FileTranscriptArtifactStore(options.transcriptsDir);
  const rows = db
    .prepare(`SELECT s.project_id, e.session_id, e.sequence, e.payload FROM session_events e
    JOIN sessions s ON s.id=e.session_id WHERE json_valid(e.payload)
      AND json_extract(e.payload,'$.kind')='transcript.referenced' ORDER BY e.session_id,e.sequence`)
    .iterate() as Iterable<ArtifactRow>;
  // Each artifact is its own small file: reading one at a time leaves the
  // export waiting on one open/read/inflate round trip per artifact, hundreds
  // of thousands of times over. A bounded window keeps several in flight and
  // still yields, and refuses, strictly in row order.
  const read = (row: ArtifactRow): PendingArtifact => {
    const payload = JSON.parse(row.payload) as { reference: TranscriptReference };
    const bytes = store.readCanonicalBytes(payload.reference).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    return { row, payload, bytes };
  };
  const window: PendingArtifact[] = [];
  for (const row of rows) {
    options.signal?.throwIfAborted();
    window.push(read(row));
    if (window.length >= ARTIFACT_READ_AHEAD) yield await settleArtifact(window.shift()!);
  }
  while (window.length > 0) {
    options.signal?.throwIfAborted();
    yield await settleArtifact(window.shift()!);
  }
}

async function* piLogs(
  db: Database.Database,
  options: FileStreamOptions,
): AsyncGenerator<PiLogRecord> {
  const rows = db
    .prepare(`SELECT a.*,s.project_id FROM session_attachments a JOIN sessions s ON s.id=a.session_id
    WHERE a.native_detail IS NOT NULL ORDER BY a.session_id,a.id`)
    .iterate() as Iterable<{
    id: string;
    session_id: string;
    project_id: string;
    native_detail: string;
    adapter_id: string;
    venue_kind: string;
    venue_id: string;
  }>;
  const seen = new Set<string>();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.native_detail);
    } catch {
      throw new SourceCorruptError(`attachment ${row.id} has invalid native detail`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const detail = parsed as {
      kind?: string;
      locator?: { runtime?: string; sessionFilePath?: string };
    };
    if (detail.kind !== "volli.native-binding.v1" || detail.locator?.runtime !== "pi") continue;
    if (
      row.adapter_id !== STRUCTURED_ADAPTER_ID ||
      row.venue_kind !== "local" ||
      row.venue_id !== "local"
    )
      throw new SourceCorruptError(`Pi attachment ${row.id} is not this Mac's local Pi history`);
    const path = detail.locator.sessionFilePath;
    try {
      if (typeof path !== "string" || !isAbsolute(path)) throw new Error("missing Pi file locator");
      const within = relative(resolve(options.piLogsDir), resolve(path));
      const parts = within.split(sep);
      if (
        parts.length !== 2 ||
        !parts[0]!.startsWith("--") ||
        !parts[0]!.endsWith("--") ||
        !parts[1]!.endsWith(".jsonl")
      )
        throw new Error("Pi file outside history layout");
      if ((await lstat(dirname(path))).isSymbolicLink())
        throw new Error("Pi directory is a symlink");
      const actual = relative(await realpath(options.piLogsDir), await realpath(path));
      if (actual !== within) throw new Error("Pi path escaped history directory");
      const piFileId = piFileIdOf(path);
      const identity = `${row.session_id}:${piFileId}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await file.stat();
        if (!before.isFile()) throw new Error("Pi log is not a regular file");
        let offset = 0;
        do {
          options.signal?.throwIfAborted();
          const buffer = Buffer.alloc(Math.min(PI_SLICE_BYTES, before.size - offset));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          if (bytesRead !== buffer.length) throw new Error("Pi log changed during export");
          const end = buffer.lastIndexOf(0x0a) + 1;
          if (bytesRead > 0 && end === 0)
            throw new Error("Pi log has an oversized or incomplete line");
          const bytes = buffer.subarray(0, end);
          // Measuring checks the same layout, lines and stability, without the copy's encoding.
          const measured = options.measureOnly === true;
          yield {
            projectId: row.project_id,
            sessionId: row.session_id,
            attachmentId: row.id,
            piFileId,
            startOffset: offset,
            endOffset: offset + bytes.length,
            fileBytes: before.size,
            sourceSha256: measured ? "" : sha(bytes),
            sourceBytes: bytes.length,
            base64: measured ? "" : bytes.toString("base64"),
          };
          offset += bytes.length;
        } while (offset < before.size);
        const after = await file.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
          throw new Error("Pi log changed during export");
      } finally {
        await file.close();
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new SourceCorruptError(
        `Pi attachment ${row.id} missing or corrupt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Rebuilt from the frozen snapshot on resume; never mixed with earlier file
 * chunks. A crash leaves only unjournaled chunks, discarded by normal recovery.
 */
export async function exportFileStreams(
  db: Database.Database,
  staging: string,
  options: FileStreamOptions,
): Promise<{
  checkpoints: Checkpoint[];
  piLogFiles: PiLogFileCoverage[];
  measured: MeasuredHistory | null;
}> {
  for (const row of db
    .prepare(
      `SELECT DISTINCT b.hash,b.size_bytes FROM blobs b JOIN blob_links l ON l.blob_hash=b.hash ORDER BY b.hash`,
    )
    .iterate() as Iterable<{ hash: string; size_bytes: number }>) {
    options.signal?.throwIfAborted();
    try {
      const result = await hashFile(blobFilePath(options.blobsDir, row.hash));
      if (result.sha256 !== row.hash || result.bytes !== row.size_bytes)
        throw new Error("checksum or size mismatch");
    } catch {
      throw new SourceCorruptError(`blob ${row.hash} missing or corrupt`);
    }
  }
  const checkpoints: Checkpoint[] = [];
  const piLogFiles: PiLogFileCoverage[] = [];
  const measured: MeasuredHistory | null =
    options.measureOnly === true
      ? { transcripts: 0, transcriptBytes: 0, piSlices: 0, piLogBytes: 0 }
      : null;
  let read = 0;
  for (const [name, records] of [
    ["transcriptArtifacts", artifacts(db, options)],
    ["piLogs", piLogs(db, options)],
  ] as const) {
    const chunks: ChunkEntry[] = [];
    let lines: string[] = [];
    let bytes = 0;
    let count = 0;
    const flush = async () => {
      if (lines.length === 0) return;
      const content = Buffer.from(lines.join(""));
      const file = chunkFileName(name, chunks.length + 1);
      await writeFileDurably(join(staging, file), content);
      chunks.push({
        stream: name,
        file,
        records: lines.length,
        bytes: content.length,
        sha256: sha(content),
      });
      lines = [];
      bytes = 0;
    };
    for await (const record of records) {
      read += 1;
      if (read % HISTORY_PROGRESS_EVERY === 0) options.onRecords?.(read);
      if ("piFileId" in record && record.startOffset === 0) {
        piLogFiles.push({
          sessionId: record.sessionId,
          attachmentId: record.attachmentId,
          piFileId: record.piFileId,
          fileBytes: record.fileBytes,
        });
      }
      if (measured !== null) {
        if ("piFileId" in record) {
          measured.piSlices += 1;
          measured.piLogBytes += record.sourceBytes;
        } else {
          measured.transcripts += 1;
          measured.transcriptBytes += Buffer.byteLength(record.canonicalJson, "utf8");
        }
        continue;
      }
      const line = `${JSON.stringify(record)}\n`;
      lines.push(line);
      bytes += Buffer.byteLength(line);
      count++;
      if (
        bytes >= (options.chunkMaxBytes ?? DEFAULT_CHUNK_MAX_BYTES) ||
        lines.length >= (options.chunkMaxRecords ?? DEFAULT_CHUNK_MAX_RECORDS)
      )
        await flush();
    }
    await flush();
    checkpoints.push({ source: name, rowsThrough: count, done: true, chunks });
  }
  return { checkpoints, piLogFiles, measured };
}
