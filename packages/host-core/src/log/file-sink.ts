/**
 * Rotating JSON-lines files (VC-699): the desktop's log on disk, under the
 * profile's own log directory.
 *
 * - **Named by day.** `volli-2026-10-07.jsonl` (UTC, from each line's `ts`),
 *   then `volli-2026-10-07.1.jsonl` once a file is full.
 * - **Off the caller's stack.** `write` only queues: creating the directory,
 *   finding today's file, opening, rotating, writing and pruning all happen
 *   on one asynchronous writer, never on a logging call's stack, and never
 *   with a synchronous filesystem call.
 * - **Bounded.** {@link LogFilePolicy} bounds, each strict:
 *   - `maxBufferedBytes`: every byte accepted and not yet on disk (queued and
 *     in flight, the dropped-lines notice included). A line that does not fit
 *     is dropped and counted, and the next line that fits is preceded by one
 *     notice saying how many.
 *   - `maxFileBytes`: no file grows past it, a file an earlier launch left
 *     included. A line that would cross it starts the next file.
 *   - `maxLineBytes`: a line past it (or past `maxFileBytes`) is dropped and
 *     counted; the logger cuts its lines well within it.
 * - **Retained.** At open and after every rotation, files older than the
 *   retention window go, then the oldest until the directory is under its
 *   total cap. The file being written is never removed.
 * - **Never fatal.** Nothing here throws to a caller, at creation or after.
 *   A directory that cannot be made, a file that cannot be opened, a disk
 *   that is full: the sink reports once (`onFailure`, stderr by default) and
 *   drops from then on, counting.
 */
import { mkdir, open, readdir, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type { LogRecord } from "@volli/shared";

import { MAX_LOG_LINE_BYTES, type LogSink } from "./logger";

export interface LogFilePolicy {
  /** No file grows past this; the next line starts the next index for its day. */
  readonly maxFileBytes: number;
  /** Days of files kept, today included. */
  readonly retainDays: number;
  /** Every file of this sink's prefix, together. */
  readonly maxTotalBytes: number;
  /** Bytes accepted and not yet written (queued or in flight); past it, lines are dropped. */
  readonly maxBufferedBytes: number;
  /** One line's ceiling, its newline included. */
  readonly maxLineBytes: number;
}

/** The desktop's defaults: about a week of a busy machine's logs, never more than 100 MiB. */
export const LOG_FILE_POLICY: LogFilePolicy = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  retainDays: 7,
  maxTotalBytes: 100 * 1024 * 1024,
  maxBufferedBytes: 4 * 1024 * 1024,
  maxLineBytes: MAX_LOG_LINE_BYTES + 1,
});

/** The filesystem the sink writes through: Node's, or a test's that fails on cue. */
export interface LogFileSystem {
  mkdir(path: string): Promise<unknown>;
  /** Bytes in the file, or 0 when it does not exist. */
  size(path: string): Promise<number>;
  open(path: string): Promise<LogFileHandle>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
}

export interface LogFileHandle {
  write(data: Uint8Array): Promise<unknown>;
  close(): Promise<void>;
}

export const NODE_LOG_FILE_SYSTEM: LogFileSystem = {
  mkdir: (path) => mkdir(path, { recursive: true }),
  size: (path) =>
    stat(path).then(
      (stats) => stats.size,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      },
    ),
  open: (path) =>
    open(path, "a").then((handle: FileHandle) => ({
      // `appendFile` writes the whole buffer, looping over short writes.
      write: (data: Uint8Array) => handle.appendFile(data),
      close: () => handle.close(),
    })),
  readdir: (path) => readdir(path),
  unlink: (path) => unlink(path),
};

/** Why the sink stopped writing: once, with a code a reader can act on. */
export interface LogFileFailure {
  readonly stage: "directory" | "open" | "write" | "close";
  readonly code: string;
  readonly directory: string;
}

export interface RotatingFileSinkOptions {
  readonly directory: string;
  /** File names start with this. */
  readonly prefix?: string;
  readonly policy?: Partial<LogFilePolicy>;
  /** Today, for retention. Lines are filed by their own `ts`. */
  readonly now?: () => Date;
  /** Told once when the sink stops writing. Defaults to one JSON line on stderr. */
  readonly onFailure?: (failure: LogFileFailure) => void;
  /** For tests: a filesystem that fails on cue. */
  readonly fs?: LogFileSystem;
}

export interface RotatingFileSink extends LogSink {
  readonly directory: string;
  /** The file lines go to now, or null before the first write lands or after a failure. */
  currentFile(): string | null;
  /** Lines dropped so far: past a bound, after a failure, or after close. */
  dropped(): number;
  /** Bytes accepted and not yet written. */
  pendingBytes(): number;
  /** The failure that stopped this sink, if one did. */
  failure(): LogFileFailure | null;
  /** Resolves once everything accepted so far reached the file (or was dropped by a failure). */
  flush(): Promise<void>;
  /** Flushes, then stops: later lines are dropped. */
  close(): Promise<void>;
  /** Runs retention now. Normally automatic. */
  prune(): Promise<void>;
}

interface Pending {
  readonly day: string;
  readonly data: Buffer;
}

interface OpenFile {
  readonly day: string;
  readonly index: number;
  readonly path: string;
  readonly handle: LogFileHandle;
  bytes: number;
}

const DAY_MS = 86_400_000;
/** Indexes tried for one day before the sink gives up on it: a guard, not a policy. */
const MAX_DAY_INDEX = 10_000;

export function createRotatingFileSink(options: RotatingFileSinkOptions): RotatingFileSink {
  const policy: LogFilePolicy = { ...LOG_FILE_POLICY, ...options.policy };
  const prefix = options.prefix ?? "volli";
  const now = options.now ?? (() => new Date());
  const fs = options.fs ?? NODE_LOG_FILE_SYSTEM;
  const report = options.onFailure ?? reportToStderr;
  const directory = options.directory;
  const lineCeiling = Math.min(policy.maxLineBytes, policy.maxFileBytes);
  const pattern = new RegExp(
    `^${escapeRegExp(prefix)}-(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?\\.jsonl$`,
    "u",
  );

  const queue: Pending[] = [];
  /** Accepted, not yet written: queued plus in flight. */
  let pending = 0;
  let current: OpenFile | null = null;
  let closed = false;
  let failed: LogFileFailure | null = null;
  let dropped = 0;
  let unreported = 0;
  let directoryReady = false;
  let draining: Promise<void> | null = null;
  let pruning: Promise<void> = Promise.resolve();

  const fileName = (day: string, index: number): string =>
    index === 0 ? `${prefix}-${day}.jsonl` : `${prefix}-${day}.${index}.jsonl`;

  function fail(stage: LogFileFailure["stage"], error: unknown): void {
    if (failed !== null) return;
    failed = { stage, code: errorCode(error), directory };
    // Everything accepted and unwritten is lost with the sink: counted, freed.
    dropped += queue.length;
    queue.length = 0;
    pending = 0;
    const file = current;
    current = null;
    if (file !== null) void file.handle.close().catch(() => undefined);
    try {
      report(failed);
    } catch {
      // A reporter that throws is not the logger's caller's problem.
    }
  }

  /** Accepts `data` when it fits the backlog bound; the caller has checked the line ceiling. */
  function admit(day: string, data: Buffer): boolean {
    if (pending + data.byteLength > policy.maxBufferedBytes) return false;
    queue.push({ day, data });
    pending += data.byteLength;
    return true;
  }

  function startDrain(): void {
    if (draining !== null) return;
    draining = drain().finally(() => {
      draining = null;
      // A line accepted while the last write settled.
      if (queue.length > 0 && failed === null) startDrain();
    });
  }

  async function drain(): Promise<void> {
    // Off the caller's stack: nothing below runs inside a `write`.
    await Promise.resolve();
    while (queue.length > 0 && failed === null) {
      const day = queue[0]!.day;
      let file: OpenFile;
      try {
        file = await fileFor(day, queue[0]!.data.byteLength);
      } catch (error) {
        fail(directoryReady ? "open" : "directory", error);
        return;
      }
      // As many queued lines for this day as fit what is left of the file.
      const batch: Buffer[] = [];
      let bytes = 0;
      while (queue.length > 0 && queue[0]!.day === day) {
        const next = queue[0]!.data;
        if (file.bytes + bytes + next.byteLength > policy.maxFileBytes) break;
        batch.push(next);
        bytes += next.byteLength;
        queue.shift();
      }
      try {
        await file.handle.write(batch.length === 1 ? batch[0]! : Buffer.concat(batch, bytes));
      } catch (error) {
        pending -= bytes;
        dropped += batch.length;
        fail("write", error);
        return;
      }
      file.bytes += bytes;
      pending -= bytes;
    }
  }

  /** The open file for `day` with room for `bytes`, rotating when the current one lacks it. */
  async function fileFor(day: string, bytes: number): Promise<OpenFile> {
    const file = current;
    if (file !== null && file.day === day && file.bytes + bytes <= policy.maxFileBytes) {
      return file;
    }
    if (!directoryReady) {
      await fs.mkdir(directory);
      directoryReady = true;
    }
    if (file !== null) {
      current = null;
      await file.handle.close().catch(() => undefined);
    }
    // An earlier launch may have left today's files: append to the first with room.
    let index = file !== null && file.day === day ? file.index + 1 : 0;
    for (; index < MAX_DAY_INDEX; index += 1) {
      const size = await fs.size(join(directory, fileName(day, index)));
      if (size + bytes <= policy.maxFileBytes) {
        const path = join(directory, fileName(day, index));
        const handle = await fs.open(path);
        current = { day, index, path, handle, bytes: size };
        schedulePrune();
        return current;
      }
    }
    throw Object.assign(new Error("no file index left for the day"), { code: "EINDEX" });
  }

  function schedulePrune(): void {
    pruning = pruning.then(prune, prune);
  }

  async function prune(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(directory);
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
        await fs.unlink(path).catch(() => undefined);
        continue;
      }
      const size = await fs.size(path).catch(() => 0);
      files.push({ name, day, index: Number(match[2] ?? 0), size });
    }
    // Newest first; the open file counts against the cap and is never removed.
    files.sort((a, b) => (a.day === b.day ? b.index - a.index : a.day < b.day ? 1 : -1));
    let total = current?.bytes ?? 0;
    for (const file of files) {
      total += file.size;
      if (total > policy.maxTotalBytes) {
        await fs.unlink(join(directory, file.name)).catch(() => undefined);
      }
    }
  }

  async function settle(): Promise<void> {
    // A drain that ends with lines queued starts the next one: wait them all out.
    for (let running = draining; running !== null; running = draining) await running;
  }

  return {
    directory,
    write(record: LogRecord, line: string) {
      if (closed || failed !== null) {
        dropped += 1;
        return;
      }
      const day = record.ts.slice(0, 10);
      if (Buffer.byteLength(line) + 1 > lineCeiling) {
        dropped += 1;
        unreported += 1;
        return;
      }
      const data = Buffer.from(`${line}\n`);
      if (unreported > 0) {
        const notice = Buffer.from(
          `${JSON.stringify({
            ts: record.ts,
            level: "warn",
            component: "log",
            msg: "log lines dropped",
            dropped: unreported,
          })}\n`,
        );
        if (notice.byteLength > lineCeiling) {
          // A policy too small for the notice itself: `dropped()` still counts.
          unreported = 0;
        } else if (pending + notice.byteLength + data.byteLength > policy.maxBufferedBytes) {
          // The notice and the line are admitted together, or neither is.
          dropped += 1;
          unreported += 1;
          return;
        } else {
          admit(day, notice);
          unreported = 0;
        }
      }
      if (!admit(day, data)) {
        dropped += 1;
        unreported += 1;
        return;
      }
      startDrain();
    },
    currentFile: () => current?.path ?? null,
    dropped: () => dropped,
    pendingBytes: () => pending,
    failure: () => failed,
    flush: settle,
    async close() {
      closed = true;
      await settle();
      const file = current;
      current = null;
      if (file !== null) {
        await file.handle.close().catch((error: unknown) => fail("close", error));
      }
      await pruning;
    },
    prune: () => {
      schedulePrune();
      return pruning;
    },
  };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code) ? code : "UNKNOWN";
}

/** One line on stderr, in the log's own shape, saying the file log stopped and why. The default `onFailure`. */
export function reportToStderr(failure: LogFileFailure): void {
  try {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        component: "log",
        msg: "log file disabled: lines are dropped from here on",
        stage: failure.stage,
        code: failure.code,
      })}\n`,
    );
  } catch {
    // No stderr either: nothing left to tell.
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
