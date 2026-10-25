/**
 * Reading a written migration export back in the tests: a stream's records,
 * and every stream's text for comparing two exports. Test support only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MigrationExportManifest } from "../exporter";
import type { StreamName, StreamRecords } from "../sources";

/** Every record of one stream, in order. */
export function streamRecords<S extends StreamName>(
  dir: string,
  manifest: MigrationExportManifest,
  name: S,
): StreamRecords[S][] {
  return manifest.streams
    .find((stream) => stream.name === name)!
    .chunks.flatMap((chunk) =>
      readFileSync(join(dir, chunk.file), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as StreamRecords[S]),
    );
}

/** Every stream's chunks concatenated: what two equivalent exports share. */
export function streamTexts(
  dir: string,
  manifest: MigrationExportManifest,
): Record<string, string> {
  return Object.fromEntries(
    manifest.streams.map((stream) => [
      stream.name,
      stream.chunks.map((chunk) => readFileSync(join(dir, chunk.file), "utf8")).join(""),
    ]),
  );
}
