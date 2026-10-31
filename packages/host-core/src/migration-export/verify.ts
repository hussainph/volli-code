/**
 * Integrity validation of a complete migration export: the check the
 * importer (VC-903) runs before it uploads anything, and the one the tests
 * use to prove a written export is whole.
 *
 * It proves the directory is exactly what the manifest says: the format
 * marker, every chunk present with its size, sha256 and line count, every
 * line one JSON object, every stream's totals, and no stray file beside the
 * named ones. It does not re-derive records from a database; the manifest's
 * `source.tableRows` is what a verifier on the far side reconciles against.
 *
 * Chunks are read in blocks, never whole, and a Pi slice that is one long
 * line is checked as it streams (`chunk-lines.ts`): memory stays bounded by
 * the largest transcript artifact, not by the largest Pi line.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  PiRecordLine,
  PiRecordLineError,
  scanChunkLines,
  wholeLine,
  type LineSink,
  type PiRecordBody,
} from "./chunk-lines";
import { MigrationExportError } from "./errors";
import type { MigrationExportManifest } from "./exporter";
import {
  MIGRATION_EXPORT_FORMAT,
  PENDING_RUNNER_FACTS,
  EXECUTABLE_MIGRATION_STREAMS,
  PI_MOVE_LINE_MAX_BYTES,
  PI_SLICE_BYTES,
} from "./records";
import { STREAM_DESTINATIONS, type StreamName } from "./sources";
import { MANIFEST_FILE, listStreamFiles } from "./staging";

export interface MigrationExportVerification {
  manifest: MigrationExportManifest;
  records: number;
  bytes: number;
}

function fail(message: string): never {
  throw new MigrationExportError("integrity_failed", message);
}

/** A Pi record's whole-line `base64`, measured; `null` when it is not canonical base64. */
function decodedPiBody(base64: string): PiRecordBody | null {
  const body = Buffer.from(base64, "base64");
  if (body.toString("base64") !== base64) return null;
  let newlines = 0;
  for (let at = body.indexOf(0x0a); at !== -1; at = body.indexOf(0x0a, at + 1)) newlines += 1;
  return {
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    newlines,
    lastByte: body.length === 0 ? -1 : body[body.length - 1]!,
  };
}

/** One `piLogs` line, streamed; a line it cannot read is named the way a whole line's fault is. */
function piRecordLine(
  file: string,
  index: number,
  check: (index: number, value: unknown, body?: PiRecordBody) => void,
  whole: (text: string) => void,
): LineSink {
  const line = new PiRecordLine((fields, body) => check(index, fields, body), whole);
  const named = (step: () => void) => {
    try {
      step();
    } catch (error) {
      if (!(error instanceof PiRecordLineError)) throw error;
      if (error.kind === "json") fail(`${file} line ${index} is not JSON.`);
      if (error.kind === "record") fail(`${file} line ${index} is not a record.`);
      fail("Pi log coverage or checksum mismatch.");
    }
  };
  return {
    piece: (bytes) => named(() => line.piece(bytes)),
    end: () => named(() => line.end()),
  };
}

/** Reads and checks a complete export at `dir`; throws `integrity_failed` naming the first fault. */
export async function verifyMigrationExport(dir: string): Promise<MigrationExportVerification> {
  let manifest: MigrationExportManifest;
  try {
    manifest = JSON.parse(
      await readFile(join(dir, MANIFEST_FILE), "utf8"),
    ) as MigrationExportManifest;
  } catch (error) {
    throw new MigrationExportError("integrity_failed", `No readable manifest in ${dir}.`, {
      cause: error,
    });
  }
  if (manifest.format !== MIGRATION_EXPORT_FORMAT)
    fail(`Unknown format ${String(manifest.format)}.`);

  const expected = Object.keys(STREAM_DESTINATIONS).toSorted();
  const listed = manifest.streams.map((stream) => stream.name).toSorted();
  if (expected.join("\n") !== listed.join("\n"))
    fail("The manifest does not list every stream once.");

  if (manifest.pendingRunnerWork !== false)
    fail("The manifest must promise no pending runner work.");
  for (const name of PENDING_RUNNER_FACTS) {
    if (manifest.preflight[name] !== 0) fail(`Pending runner work: ${name}.`);
  }
  for (const name of EXECUTABLE_MIGRATION_STREAMS) {
    if (manifest.streams.find((s) => s.name === name)?.records !== 0)
      fail(`${name} contains pending runner work.`);
  }
  const references = new Map<string, string>();
  const artifacts = new Map<string, string>();
  const piFiles = new Map<string, { through: number; bytes: number }>();
  const expectedPiFiles = new Map<string, (typeof manifest.piLogFiles)[number]>();
  if (!Array.isArray(manifest.piLogFiles)) fail("Missing Pi log file coverage.");
  for (const file of manifest.piLogFiles) {
    const key = JSON.stringify([file.sessionId, file.piFileId]);
    if (expectedPiFiles.has(key)) fail("Duplicate Pi log file coverage.");
    if (
      typeof file.sessionId !== "string" ||
      typeof file.attachmentId !== "string" ||
      typeof file.piFileId !== "string" ||
      !Number.isSafeInteger(file.fileBytes) ||
      file.fileBytes < 0
    )
      fail("Invalid Pi log file coverage.");
    expectedPiFiles.set(key, file);
  }
  const named = new Set<string>();
  let records = 0;
  let bytes = 0;
  for (const stream of manifest.streams) {
    if (STREAM_DESTINATIONS[stream.name as StreamName] !== stream.destination) {
      fail(`Stream ${stream.name} has the wrong destination.`);
    }
    let streamRecords = 0;
    let streamBytes = 0;
    for (const chunk of stream.chunks) {
      if (named.has(chunk.file)) fail(`${chunk.file} is named twice.`);
      if (!new RegExp(`^streams/${stream.name}/[0-9]{6,}\\.ndjson$`).test(chunk.file))
        fail("Invalid chunk path.");
      named.add(chunk.file);
      const where = join(dir, chunk.file);
      const checkLine = (index: number, value: unknown, piBody?: PiRecordBody) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          fail(`${chunk.file} line ${index} is not a record.`);
        }
        const row = value as Record<string, unknown>;
        const key = JSON.stringify([row.sessionId, row.sequence]);
        if (stream.name === "sessionEvents") {
          const payload = row.payload as {
            kind?: string;
            reference?: { id?: string; digest?: unknown };
          };
          if (payload?.kind === "transcript.referenced") {
            // Event.digest is message semantics; file identity belongs to reference.
            if (
              typeof payload.reference?.id !== "string" ||
              (payload.reference.digest !== undefined &&
                payload.reference.digest !== payload.reference.id)
            )
              fail("Invalid transcript reference.");
            references.set(key, payload.reference.id);
          }
        }
        if (stream.name === "transcriptArtifacts") {
          if (artifacts.has(key)) fail("Duplicate transcript artifact coverage.");
          if (
            typeof row.canonicalJson !== "string" ||
            `sha256:${createHash("sha256").update(row.canonicalJson).digest("hex")}` !== row.digest
          )
            fail("Transcript digest mismatch.");
          artifacts.set(key, row.digest as string);
        }
        if (stream.name === "piLogs") {
          const identity = JSON.stringify([row.sessionId, row.piFileId]);
          const state = piFiles.get(identity) ?? { through: 0, bytes: row.fileBytes as number };
          if (
            (piBody === undefined && typeof row.base64 !== "string") ||
            !Number.isSafeInteger(row.fileBytes) ||
            (row.fileBytes as number) < 0
          )
            fail("Invalid Pi log record.");
          const expectedFile = expectedPiFiles.get(identity);
          if (
            expectedFile === undefined ||
            expectedFile.fileBytes !== row.fileBytes ||
            expectedFile.attachmentId !== row.attachmentId ||
            (piFiles.has(identity) && state.through === state.bytes)
          )
            fail("Pi log coverage or checksum mismatch.");
          const body = piBody ?? decodedPiBody(row.base64 as string);
          if (
            body === null ||
            row.startOffset !== state.through ||
            row.endOffset !== state.through + body.bytes ||
            row.fileBytes !== state.bytes ||
            (row.endOffset as number) > state.bytes ||
            (body.bytes === 0 && state.bytes !== 0) ||
            row.sourceBytes !== body.bytes ||
            (body.bytes > 0 && body.lastByte !== 0x0a) ||
            body.sha256 !== row.sourceSha256
          )
            fail("Pi log coverage or checksum mismatch.");
          // A slice is complete lines within one slice's bound, or one longer
          // line of its own, at most the longest line a move carries.
          if (
            body.bytes > PI_SLICE_BYTES &&
            (body.newlines !== 1 || body.bytes > PI_MOVE_LINE_MAX_BYTES)
          )
            fail("Pi log slice is out of bounds.");
          piFiles.set(identity, { through: row.endOffset as number, bytes: state.bytes });
        }
      };
      const parsedLine = (index: number) => (text: string) => {
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          fail(`${chunk.file} line ${index} is not JSON.`);
        }
        checkLine(index, value);
      };
      let scanned: Awaited<ReturnType<typeof scanChunkLines>>;
      try {
        scanned = await scanChunkLines(where, chunk.bytes, (index) =>
          stream.name === "piLogs"
            ? piRecordLine(chunk.file, index, checkLine, parsedLine(index))
            : wholeLine(parsedLine(index)),
        );
      } catch {
        fail(`${chunk.file} is missing.`);
      }
      if (scanned.bytes !== chunk.bytes)
        fail(`${chunk.file} is ${scanned.bytes} bytes, not ${chunk.bytes}.`);
      if (scanned.sha256 !== chunk.sha256) fail(`${chunk.file} does not match its checksum.`);
      if (!scanned.endsWithNewline) fail(`${chunk.file} ends mid-line.`);
      if (scanned.lines !== chunk.records) {
        fail(`${chunk.file} holds ${scanned.lines} records, not ${chunk.records}.`);
      }
      if (scanned.fault !== null) throw scanned.fault;
      streamRecords += chunk.records;
      streamBytes += chunk.bytes;
    }
    if (streamRecords !== stream.records || streamBytes !== stream.bytes) {
      fail(`Stream ${stream.name}'s totals do not match its chunks.`);
    }
    records += streamRecords;
    bytes += streamBytes;
  }
  const measured = manifest.historyMeasured;
  if (measured !== undefined) {
    // A dry run's export read every artifact and Pi file and copied none: its
    // coverage is the count it read, and its history streams stay empty.
    if (
      typeof measured !== "object" ||
      measured === null ||
      !Number.isSafeInteger(measured.transcripts) ||
      !Number.isSafeInteger(measured.transcriptBytes) ||
      !Number.isSafeInteger(measured.piSlices) ||
      !Number.isSafeInteger(measured.piLogBytes) ||
      artifacts.size !== 0 ||
      piFiles.size !== 0
    )
      fail("A measured export carries no history.");
    if (references.size !== measured.transcripts) fail("Transcript digest coverage is incomplete.");
    const expectedPiBytes = [...expectedPiFiles.values()].reduce(
      (sum, file) => sum + file.fileBytes,
      0,
    );
    if (expectedPiBytes !== measured.piLogBytes) fail("Pi log coverage is incomplete.");
  } else {
    if (
      references.size !== artifacts.size ||
      [...references].some(([key, digest]) => artifacts.get(key) !== digest)
    )
      fail("Transcript digest coverage is incomplete.");
    if (expectedPiFiles.size !== piFiles.size) fail("Pi log coverage is incomplete.");
    for (const state of piFiles.values())
      if (state.through !== state.bytes) fail("Pi log coverage is incomplete.");
  }
  for (const file of await listStreamFiles(dir)) {
    if (!named.has(file)) fail(`${file} is not named by the manifest.`);
  }
  return { manifest, records, bytes };
}
