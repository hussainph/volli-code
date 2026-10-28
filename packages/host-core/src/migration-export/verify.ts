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
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MigrationExportError } from "./errors";
import type { MigrationExportManifest } from "./exporter";
import { MIGRATION_EXPORT_FORMAT } from "./records";
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
  for (const name of [
    "pendingFollowUps",
    "undeliveredNotices",
    "undeliveredRunMessages",
    "openCleanupCommands",
  ] as const) {
    if (manifest.preflight[name] !== 0) fail(`Pending runner work: ${name}.`);
  }
  for (const name of ["runnerJobs", "automationArmings", "automationScheduleCursors"]) {
    if (manifest.streams.find((s) => s.name === name)?.records !== 0)
      fail(`${name} contains pending runner work.`);
  }
  const references = new Map<string, string>();
  const artifacts = new Map<string, string>();
  const piFiles = new Map<string, { through: number; bytes: number }>();
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
      let content: Buffer;
      try {
        content = await readFile(join(dir, chunk.file));
      } catch {
        fail(`${chunk.file} is missing.`);
      }
      if (content.length !== chunk.bytes)
        fail(`${chunk.file} is ${content.length} bytes, not ${chunk.bytes}.`);
      if (createHash("sha256").update(content).digest("hex") !== chunk.sha256) {
        fail(`${chunk.file} does not match its checksum.`);
      }
      const text = content.toString("utf8");
      if (!text.endsWith("\n")) fail(`${chunk.file} ends mid-line.`);
      const lines = text.slice(0, -1).split("\n");
      if (lines.length !== chunk.records) {
        fail(`${chunk.file} holds ${lines.length} records, not ${chunk.records}.`);
      }
      for (const [index, line] of lines.entries()) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          fail(`${chunk.file} line ${index + 1} is not JSON.`);
        }
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          fail(`${chunk.file} line ${index + 1} is not a record.`);
        }
        const row = value as Record<string, unknown>;
        const key = JSON.stringify([row.sessionId, row.sequence]);
        if (stream.name === "sessionEvents") {
          const payload = row.payload as {
            kind?: string;
            reference?: { id?: string };
            digest?: string;
          };
          if (payload?.kind === "transcript.referenced") {
            if (
              typeof payload.reference?.id !== "string" ||
              (payload.digest !== undefined && payload.digest !== payload.reference.id)
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
            typeof row.base64 !== "string" ||
            !Number.isSafeInteger(row.fileBytes) ||
            (row.fileBytes as number) < 0
          )
            fail("Invalid Pi log record.");
          const body = Buffer.from(row.base64, "base64");
          if (
            body.toString("base64") !== row.base64 ||
            row.startOffset !== state.through ||
            row.endOffset !== state.through + body.length ||
            row.fileBytes !== state.bytes ||
            (row.endOffset as number) > state.bytes ||
            (body.length === 0 && state.bytes !== 0) ||
            row.sourceBytes !== body.length ||
            (body.length > 0 && body.at(-1) !== 0x0a) ||
            createHash("sha256").update(body).digest("hex") !== row.sourceSha256
          )
            fail("Pi log coverage or checksum mismatch.");
          piFiles.set(identity, { through: row.endOffset as number, bytes: state.bytes });
        }
      }
      streamRecords += chunk.records;
      streamBytes += chunk.bytes;
    }
    if (streamRecords !== stream.records || streamBytes !== stream.bytes) {
      fail(`Stream ${stream.name}'s totals do not match its chunks.`);
    }
    records += streamRecords;
    bytes += streamBytes;
  }
  if (
    references.size !== artifacts.size ||
    [...references].some(([key, digest]) => artifacts.get(key) !== digest)
  )
    fail("Transcript digest coverage is incomplete.");
  for (const state of piFiles.values())
    if (state.through !== state.bytes) fail("Pi log coverage is incomplete.");
  for (const file of await listStreamFiles(dir)) {
    if (!named.has(file)) fail(`${file} is not named by the manifest.`);
  }
  return { manifest, records, bytes };
}
