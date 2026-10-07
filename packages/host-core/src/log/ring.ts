/**
 * The host's recent log, in memory (VC-699): what `host.logs` reads.
 *
 * A sink beside the host's destination (stdout, files): it keeps the newest
 * lines, bounded by count AND bytes ({@link LOG_RING_BOUNDS}), evicting the
 * oldest first. Lines arrive already redacted, so nothing here can widen what
 * a reader sees.
 *
 * A cursor names one line: `<instance>:<seq>`. `seq` rises by one per line
 * within one ring; `instance` is random per ring, so a host that restarted
 * never resumes a reader into the wrong lines. A reader resumes strictly after
 * its cursor; when lines it never saw are gone (evicted, or another instance)
 * the answer says so (`gap`), never silently.
 */
import { randomBytes } from "node:crypto";

import {
  logLevelPasses,
  type HostLogEntry,
  type HostLogsBatch,
  type HostLogsQuery,
  type LogLevel,
  type LogRecord,
} from "@volli/shared";

import type { LogSink } from "./logger";

export interface LogRingBounds {
  /** Lines kept. */
  readonly maxLines: number;
  /** Bytes kept, as the lines' JSON. */
  readonly maxBytes: number;
}

/** 10,000 lines or 8 MiB, whichever comes first: about an hour of a busy host at `debug`. */
export const LOG_RING_BOUNDS: LogRingBounds = Object.freeze({
  maxLines: 10_000,
  maxBytes: 8 * 1024 * 1024,
});

/** At most this many lines in one answer or one followed batch. */
export const LOG_PAGE_LIMIT = 500;

export interface LogRing extends LogSink {
  readonly instance: string;
  /** The newest lines after `query.after` (or the newest at all), oldest first. */
  read(query: HostLogsQuery): HostLogsBatch;
  /**
   * Calls `listener` with every line from now on (after `query.after`'s
   * backlog, first), in batches. Returns the unsubscribe.
   */
  follow(query: HostLogsQuery, listener: (batch: HostLogsBatch) => void): () => void;
  /** Lines and bytes held now. */
  size(): { readonly lines: number; readonly bytes: number };
}

interface Held {
  readonly seq: number;
  readonly record: LogRecord;
  readonly bytes: number;
}

function passes(record: LogRecord, floor: LogLevel | undefined): boolean {
  return floor === undefined || logLevelPasses(record.level, floor);
}

export function createLogRing(bounds: Partial<LogRingBounds> = {}): LogRing {
  const limits: LogRingBounds = { ...LOG_RING_BOUNDS, ...bounds };
  const instance = randomBytes(6).toString("hex");
  const lines: Held[] = [];
  let head = 0;
  let bytes = 0;
  let nextSeq = 1;
  const followers = new Set<(held: Held) => void>();

  const cursorOf = (seq: number): string => `${instance}:${seq}`;
  const entryOf = (held: Held): HostLogEntry => ({
    cursor: cursorOf(held.seq),
    record: held.record,
  });

  /** The seq to start strictly after, and whether lines between it and the oldest kept are gone. */
  function start(after: string | undefined): { after: number; gap: boolean } {
    const oldest = lines[head]?.seq ?? nextSeq;
    if (after === undefined) return { after: 0, gap: false };
    const [from, seqText] = after.split(":");
    const seq = Number(seqText);
    if (from !== instance || !Number.isSafeInteger(seq) || seq < 0 || seq >= nextSeq) {
      return { after: 0, gap: true };
    }
    return { after: seq, gap: seq < oldest - 1 };
  }

  function evict(): void {
    while (
      lines.length - head > limits.maxLines ||
      (bytes > limits.maxBytes && lines.length - head > 1)
    ) {
      bytes -= lines[head]!.bytes;
      head += 1;
    }
    // Compact now and then, so the array does not grow without bound.
    if (head > 1024 && head * 2 > lines.length) {
      lines.splice(0, head);
      head = 0;
    }
  }

  function read(query: HostLogsQuery): HostLogsBatch {
    const limit = Math.min(Math.max(1, query.limit ?? LOG_PAGE_LIMIT), LOG_PAGE_LIMIT);
    const from = start(query.after);
    const newest: HostLogEntry[] = [];
    // The newest `limit` lines after the cursor: walk back from the end.
    let index = lines.length - 1;
    while (index >= head && newest.length < limit && lines[index]!.seq > from.after) {
      const held = lines[index]!;
      if (passes(held.record, query.minLevel)) newest.push(entryOf(held));
      index -= 1;
    }
    // A matching line older than these, still after the cursor, went unread.
    let unread = false;
    while (!unread && index >= head && lines[index]!.seq > from.after) {
      unread = passes(lines[index]!.record, query.minLevel);
      index -= 1;
    }
    return {
      entries: newest.toReversed(),
      gap: from.gap || (query.after !== undefined && unread),
      cursor: cursorOf(nextSeq - 1),
    };
  }

  return {
    instance,
    write(record, line) {
      const held: Held = { seq: nextSeq++, record, bytes: line.length + 1 };
      lines.push(held);
      bytes += held.bytes;
      evict();
      for (const follower of followers) follower(held);
    },
    read,
    follow(query, listener) {
      const floor = query.minLevel;
      const backlog = query.after === undefined ? null : read({ ...query, limit: LOG_PAGE_LIMIT });
      let pending: HostLogEntry[] = [];
      let scheduled = false;
      let open = true;
      const flush = (): void => {
        scheduled = false;
        if (!open || pending.length === 0) return;
        const batch = pending;
        pending = [];
        for (let index = 0; index < batch.length; index += LOG_PAGE_LIMIT) {
          listener({
            entries: batch.slice(index, index + LOG_PAGE_LIMIT),
            gap: false,
            cursor: batch.at(-1)!.cursor,
          });
        }
      };
      const follower = (held: Held): void => {
        if (!passes(held.record, floor)) return;
        pending.push(entryOf(held));
        if (scheduled) return;
        scheduled = true;
        // One batch per turn of the event loop: a burst is one frame, not hundreds.
        setImmediate(flush);
      };
      followers.add(follower);
      if (backlog !== null && (backlog.entries.length > 0 || backlog.gap)) listener(backlog);
      return () => {
        open = false;
        followers.delete(follower);
      };
    },
    size: () => ({ lines: lines.length - head, bytes }),
  };
}
