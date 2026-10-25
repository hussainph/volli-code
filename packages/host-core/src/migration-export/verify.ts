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
  for (const file of await listStreamFiles(dir)) {
    if (!named.has(file)) fail(`${file} is not named by the manifest.`);
  }
  return { manifest, records, bytes };
}
