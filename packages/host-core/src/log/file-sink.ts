/**
 * Rotating JSON-lines files (VC-699): the desktop's log on disk, under the
 * profile's own log directory.
 *
 * - **Named by day.** `volli-2026-10-07.jsonl` (UTC, from each line's `ts`),
 *   then `volli-2026-10-07.1.jsonl` once a file reaches its size cap.
 * - **Buffered.** Lines go to a Node write stream; nothing on a logging path
 *   waits for the disk. A backlog past {@link LOG_FILE_POLICY}'s buffer bound
 *   drops lines (the next line that fits says how many) rather than holding
 *   the process's memory hostage to a slow disk.
 * - **Retained.** At open and after every rotation, files older than the
 *   retention window go, then the oldest until the directory is under its
 *   total cap. The file being written is never removed.
 * - **Never fatal.** A write error stops this sink; the host keeps running.
 */
import { createWriteStream, existsSync, mkdirSync, statSync, type WriteStream } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { LogRecord } from "@volli/shared";

import type { LogSink } from "./logger";

export interface LogFilePolicy {
  /** A file past this rolls to the next index for its day. */
  readonly maxFileBytes: number;
  /** Days of files kept, today included. */
  readonly retainDays: number;
  /** Every file of this sink's prefix, together. */
  readonly maxTotalBytes: number;
  /** Unwritten bytes held in memory before lines are dropped. */
  readonly maxBufferedBytes: number;
}

/** The desktop's defaults: about a week of a busy machine's logs, never more than 100 MiB. */
export const LOG_FILE_POLICY: LogFilePolicy = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  retainDays: 7,
  maxTotalBytes: 100 * 1024 * 1024,
  maxBufferedBytes: 4 * 1024 * 1024,
});

export interface RotatingFileSinkOptions {
  readonly directory: string;
  /** File names start with this. */
  readonly prefix?: string;
  readonly policy?: Partial<LogFilePolicy>;
  /** Today, for retention. Lines are filed by their own `ts`. */
  readonly now?: () => Date;
}

export interface RotatingFileSink extends LogSink {
  readonly directory: string;
  /** The file lines go to now, or null before the first line or after a failure. */
  currentFile(): string | null;
  /** Lines dropped so far: backlog past the buffer bound, or after a write error. */
  dropped(): number;
  /** Resolves once everything written so far reached the file. */
  flush(): Promise<void>;
  /** Flushes, then stops: later lines are dropped. */
  close(): Promise<void>;
  /** Runs retention now. Normally automatic. */
  prune(): Promise<void>;
}

interface OpenFile {
  readonly day: string;
  readonly index: number;
  readonly path: string;
  readonly stream: WriteStream;
  bytes: number;
}

const DAY_MS = 86_400_000;

export function createRotatingFileSink(options: RotatingFileSinkOptions): RotatingFileSink {
  const policy: LogFilePolicy = { ...LOG_FILE_POLICY, ...options.policy };
  const prefix = options.prefix ?? "volli";
  const now = options.now ?? (() => new Date());
  const directory = options.directory;
  const pattern = new RegExp(
    `^${escapeRegExp(prefix)}-(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.jsonl$`,
    "u",
  );
  mkdirSync(directory, { recursive: true });

  let current: OpenFile | null = null;
  let closed = false;
  let failed = false;
  let dropped = 0;
  let unreported = 0;
  let pruning: Promise<void> = Promise.resolve();

  const fileName = (day: string, index: number): string =>
    index === 0 ? `${prefix}-${day}.jsonl` : `${prefix}-${day}.${index}.jsonl`;

  function open(day: string, from: number): OpenFile {
    let index = from;
    let bytes = 0;
    // Rotation is rare: a day's first line, or a full file. Appending to what
    // an earlier launch left for today keeps one day in as few files as fit.
    for (; ; index += 1) {
      const path = join(directory, fileName(day, index));
      bytes = existsSync(path) ? statSync(path).size : 0;
      if (bytes < policy.maxFileBytes) break;
    }
    const path = join(directory, fileName(day, index));
    const stream = createWriteStream(path, { flags: "a" });
    const file: OpenFile = { day, index, path, stream, bytes };
    stream.on("error", () => {
      // The disk refused: stop writing here rather than throw into a logger.
      failed = true;
      if (current === file) current = null;
    });
    return file;
  }

  function rotate(day: string): OpenFile {
    const previous = current;
    previous?.stream.end();
    current = open(day, previous !== null && previous.day === day ? previous.index + 1 : 0);
    schedulePrune();
    return current;
  }

  function schedulePrune(): void {
    pruning = pruning.then(prune, prune);
  }

  async function prune(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return;
    }
    const oldestKept = new Date(now().getTime() - (policy.retainDays - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const files: { name: string; day: string; index: number; size: number }[] = [];
    for (const name of names) {
      const match = pattern.exec(name);
      if (match === null) continue;
      const day = match[1]!;
      const path = join(directory, name);
      if (path === current?.path) continue;
      if (day < oldestKept) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      const size = await stat(path).then(
        (stats) => stats.size,
        () => 0,
      );
      files.push({ name, day, index: Number(match[2] ?? 0), size });
    }
    // Newest first; the open file counts against the cap and is never removed.
    files.sort((a, b) => (a.day === b.day ? b.index - a.index : a.day < b.day ? 1 : -1));
    let total = current?.bytes ?? 0;
    for (const file of files) {
      total += file.size;
      if (total > policy.maxTotalBytes) {
        await unlink(join(directory, file.name)).catch(() => undefined);
      }
    }
  }

  schedulePrune();

  return {
    directory,
    write(record: LogRecord, line: string) {
      if (closed || failed) {
        dropped += 1;
        return;
      }
      const day = record.ts.slice(0, 10);
      const bytes = Buffer.byteLength(line) + 1;
      let file = current;
      if (
        file === null ||
        file.day !== day ||
        (file.bytes > 0 && file.bytes + bytes > policy.maxFileBytes)
      ) {
        file = rotate(day);
      }
      if (file.stream.writableLength + bytes > policy.maxBufferedBytes) {
        dropped += 1;
        unreported += 1;
        return;
      }
      if (unreported > 0) {
        const notice = `${JSON.stringify({
          ts: record.ts,
          level: "warn",
          component: "log",
          msg: "log lines dropped: the disk fell behind",
          dropped: unreported,
        })}\n`;
        unreported = 0;
        append(file, notice, Buffer.byteLength(notice));
      }
      append(file, `${line}\n`, bytes);
    },
    currentFile: () => current?.path ?? null,
    dropped: () => dropped,
    async flush() {
      const file = current;
      if (file === null) return;
      // Writes land in order: an empty one's callback runs after every earlier line reached the file.
      await new Promise<void>((resolve) => {
        file.stream.once("error", () => resolve());
        file.stream.write("", () => resolve());
      });
    },
    async close() {
      closed = true;
      const file = current;
      current = null;
      if (file !== null) {
        await new Promise<void>((resolve) => {
          file.stream.once("error", () => resolve());
          file.stream.end(resolve);
        });
      }
      await pruning;
    },
    prune: () => {
      schedulePrune();
      return pruning;
    },
  };
}

function append(file: OpenFile, text: string, bytes: number): void {
  file.stream.write(text);
  file.bytes += bytes;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
