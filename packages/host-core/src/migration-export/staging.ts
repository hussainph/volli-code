/**
 * The export's on-disk staging area and its durable journal.
 *
 * Everything is written under `<outDir>.partial` and only renamed to `outDir`
 * once the manifest is in place, so a reader never mistakes a partial export
 * for a complete one: a complete export is a directory named `outDir` with a
 * `manifest.json` in it, and nothing else is.
 *
 *     <outDir>.partial/
 *       state.json          the snapshot's identity, written once it is complete
 *       snapshot.db         the consistent copy every source reads
 *       journal.ndjson      one line per durable checkpoint
 *       streams/<stream>/<NNNNNN>.ndjson
 *
 * A checkpoint is durable in this order: each chunk is written to a `.tmp`,
 * fsynced and renamed into place, then the journal line naming them is
 * appended and fsynced. A crash anywhere leaves either a journal that names
 * only complete chunks, or chunk files no journal line names, which the next
 * run deletes. The journal is the only thing a resume trusts.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MigrationExportError } from "./errors";
import type { StreamName } from "./sources";

export const STATE_FILE = "state.json";
export const SNAPSHOT_FILE = "snapshot.db";
export const JOURNAL_FILE = "journal.ndjson";
export const MANIFEST_FILE = "manifest.json";
export const STREAMS_DIR = "streams";

/** Where an export stages before it is complete. */
export function stagingDirOf(outDir: string): string {
  return `${outDir}.partial`;
}

/**
 * The version of the row → record mapping. Bump it whenever `sources.ts` or
 * `transform.ts` changes what a row becomes, so a staging area written by the
 * old mapping is snapshotted again instead of resumed into a mixed export.
 */
export const MAPPER_VERSION = 5;

/** What `state.json` records about the snapshot. */
export interface StagingState {
  format: string;
  mapperVersion: number;
  exportId: string;
  /** The database it was taken from, resolved. */
  sourcePath: string;
  appVersion: string;
  snapshotAt: number;
  schemaVersion: number;
  selection: string;
  profileStep: boolean;
}

/** One chunk file, as the journal and the manifest name it. */
export interface ChunkEntry {
  stream: StreamName;
  /** Relative to the export directory, `/`-separated. */
  file: string;
  records: number;
  bytes: number;
  sha256: string;
}

/** One durable checkpoint: a source's rows through `rowsThrough` are written. */
export interface Checkpoint {
  source: string;
  rowsThrough: number;
  /** The source finished: every row is written. */
  done: boolean;
  chunks: ChunkEntry[];
}

export function chunkFileName(stream: StreamName, index: number): string {
  return `${STREAMS_DIR}/${stream}/${String(index).padStart(6, "0")}.ndjson`;
}

/** Writes `bytes` to `path` durably: a fsynced `.tmp`, then a rename. */
export async function writeFileDurably(path: string, bytes: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

/** Appends one line and fsyncs it. */
export async function appendLineDurably(path: string, line: string): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${line}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flushes a directory's entries (a rename inside it) to disk; best effort where unsupported. */
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch (error) {
    // Some filesystems refuse fsync on a directory (EISDIR/EINVAL/EPERM); the
    // rename is still atomic there, only its durability is the OS's call.
    /* v8 ignore start -- only a filesystem that refuses directory fsync reaches here. */
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EISDIR" && code !== "EINVAL" && code !== "EPERM") throw error;
    /* v8 ignore stop */
  } finally {
    await handle.close();
  }
}

/**
 * Reads the journal. A torn final line (a crash mid-append) is dropped: its
 * chunks were renamed but never acknowledged, so they are redone.
 */
export async function readJournal(stagingDir: string): Promise<Checkpoint[]> {
  let text: string;
  try {
    text = await readFile(join(stagingDir, JOURNAL_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const checkpoints: Checkpoint[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      checkpoints.push(JSON.parse(line) as Checkpoint);
    } catch {
      break;
    }
  }
  return checkpoints;
}

/** Replaces the journal with exactly `checkpoints`. */
export async function rewriteJournal(stagingDir: string, checkpoints: Checkpoint[]): Promise<void> {
  await writeFileDurably(
    join(stagingDir, JOURNAL_FILE),
    checkpoints.map((checkpoint) => `${JSON.stringify(checkpoint)}\n`).join(""),
  );
}

/** The sha256 and size of a file, streamed. */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Whether a chunk on disk still matches what the journal recorded. */
export async function chunkIntact(root: string, chunk: ChunkEntry): Promise<boolean> {
  try {
    const info = await stat(join(root, chunk.file));
    if (info.size !== chunk.bytes) return false;
    return (await hashFile(join(root, chunk.file))).sha256 === chunk.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Every file under `streams/`, relative to `root`, `/`-separated. */
export async function listStreamFiles(root: string): Promise<string[]> {
  const base = join(root, STREAMS_DIR);
  let streams: string[];
  try {
    streams = await readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const stream of streams.toSorted()) {
    for (const file of (await readdir(join(base, stream))).toSorted()) {
      files.push(`${STREAMS_DIR}/${stream}/${file}`);
    }
  }
  return files;
}

/** Deletes every stream file the journal does not name. */
export async function removeUnjournaledFiles(
  root: string,
  checkpoints: readonly Checkpoint[],
): Promise<void> {
  const kept = new Set(checkpoints.flatMap((checkpoint) => checkpoint.chunks.map((c) => c.file)));
  for (const file of await listStreamFiles(root)) {
    if (!kept.has(file)) await rm(join(root, file), { force: true });
  }
}

/** Whether a process id is alive (EPERM: alive, just not ours). */
function processAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writeLock(path: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${process.pid}\n`);
  } finally {
    await handle.close();
  }
}

/**
 * Takes `<outDir>.lock` for one run. A lock whose process is gone is taken
 * over (a crashed run leaves one); a live holder, this process included,
 * refuses with `in_progress`. Answers the release.
 */
export async function acquireExportLock(outDir: string): Promise<() => Promise<void>> {
  const path = `${outDir}.lock`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeLock(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = Number.parseInt(await readFile(path, "utf8"), 10);
    if (processAlive(holder)) {
      throw new MigrationExportError(
        "in_progress",
        `Another export into ${outDir} is running (process ${holder}).`,
      );
    }
    await rm(path, { force: true });
    await writeLock(path);
  }
  return () => rm(path, { force: true });
}
