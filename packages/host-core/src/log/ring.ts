/**
 * The host's recent log, in memory (VC-699): what `host.logs` reads.
 *
 * A sink beside the host's destination (stdout, files): it keeps the newest
 * lines, bounded by count AND bytes ({@link LOG_RING_BOUNDS}), evicting the
 * oldest first. Lines arrive already redacted, so nothing here can widen what
 * a reader sees.
 *
 * Every byte here is an encoded byte (VC-712): a line's UTF-8, never its
 * UTF-16 length, so a host writing non-ASCII is bounded as surely as one
 * writing ASCII. A read or a followed batch the door bounds
 * (`HostLogsRead.maxBytes`, its frame budget) holds the newest lines that fit
 * in that many bytes of JSON, and says it left lines out (`gap`); a follower
 * holds at most one budget of lines unsent, dropping its oldest past it and
 * saying so on its next batch.
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
  type HostLogsRead,
  type LogLevel,
  type LogRecord,
} from "@volli/shared";

import type { LogSink } from "./logger";

export interface LogRingBounds {
  /** Lines kept. */
  readonly maxLines: number;
  /** Bytes kept: the lines' JSON, UTF-8 encoded, one newline each. */
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
  /**
   * The newest lines after `query.after` (or the newest at all), oldest
   * first: at most `limit`, and within `maxBytes` of JSON when the door sets it.
   */
  read(query: HostLogsRead): HostLogsBatch;
  /**
   * Calls `listener` with every line from now on (after `query.after`'s
   * backlog, first), in batches, each within `maxBytes` when set. Returns the
   * unsubscribe.
   */
  follow(query: HostLogsRead, listener: (batch: HostLogsBatch) => void): () => void;
  /** Lines and encoded bytes held now. */
  size(): { readonly lines: number; readonly bytes: number };
}

interface Held {
  readonly seq: number;
  readonly record: LogRecord;
  /** UTF-8 bytes of the line (the record's JSON, `LogSink`'s contract), no newline. */
  readonly bytes: number;
}

function passes(record: LogRecord, floor: LogLevel | undefined): boolean {
  return floor === undefined || logLevelPasses(record.level, floor);
}

/**
 * JSON bytes a batch spends beside its entries: `{"entries":[`, `]`,
 * `,"gap":false`, `,"cursor":""`, `}` (38) and its cursor's characters, less
 * the one comma its first entry does not need (each entry counts one, below).
 * Cursors are ASCII, so characters are bytes.
 */
const BATCH_BYTES = 37;
/** JSON bytes one entry spends beside its line: `{"cursor":"",` `"record":` `}` (23), a comma, and its cursor. */
const ENTRY_BYTES = 24;
/** The longest cursor: the 12-character instance, the colon, a safe integer's 16 digits. */
const MAX_CURSOR_LENGTH = 12 + 1 + String(Number.MAX_SAFE_INTEGER).length;

/** A budget a door named, as a usable number: absent, or not a positive number, is no byte bound. */
function budgetOf(maxBytes: number | undefined): number {
  return maxBytes !== undefined && maxBytes > 0 ? maxBytes : Number.POSITIVE_INFINITY;
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
  /** A cursor's length without building it: the instance, the colon, the digits. */
  const cursorLength = (seq: number): number => instance.length + 1 + String(seq).length;
  const entryOf = (held: Held): HostLogEntry => ({
    cursor: cursorOf(held.seq),
    record: held.record,
  });
  /** What one held line costs in a batch's JSON. */
  const entryBytes = (held: Held): number => held.bytes + ENTRY_BYTES + cursorLength(held.seq);

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
      bytes -= lines[head]!.bytes + 1;
      head += 1;
    }
    // Compact now and then, so the array does not grow without bound.
    if (head > 1024 && head * 2 > lines.length) {
      lines.splice(0, head);
      head = 0;
    }
  }

  function read(query: HostLogsRead): HostLogsBatch {
    const limit = Math.min(Math.max(1, query.limit ?? LOG_PAGE_LIMIT), LOG_PAGE_LIMIT);
    const from = start(query.after);
    const newestSeq = nextSeq - 1;
    // The batch's own JSON first; each line then spends what it costs.
    let room = budgetOf(query.maxBytes) - BATCH_BYTES - cursorLength(newestSeq);
    const newest: HostLogEntry[] = [];
    // The newest `limit` lines after the cursor that fit: walk back from the end.
    let index = lines.length - 1;
    let cut = false;
    while (index >= head && newest.length < limit && lines[index]!.seq > from.after) {
      const held = lines[index]!;
      if (passes(held.record, query.minLevel)) {
        const cost = entryBytes(held);
        // The budget is full: what is older than this, the reader asked for and does not get.
        if (cost > room) {
          cut = true;
          break;
        }
        room -= cost;
        newest.push(entryOf(held));
      }
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
      gap: from.gap || cut || (query.after !== undefined && unread),
      cursor: cursorOf(newestSeq),
    };
  }

  return {
    instance,
    write(record, line) {
      const held: Held = { seq: nextSeq++, record, bytes: Buffer.byteLength(line, "utf8") };
      lines.push(held);
      bytes += held.bytes + 1;
      evict();
      for (const follower of followers) follower(held);
    },
    read,
    follow(query, listener) {
      const floor = query.minLevel;
      const budget = budgetOf(query.maxBytes);
      // Lines held unsent: one budget's worth on a bounded door (a flush is
      // then about one frame), what the ring itself keeps otherwise.
      const room = budget - BATCH_BYTES - MAX_CURSOR_LENGTH;
      const maxPendingBytes = Math.min(room, limits.maxBytes);
      const backlog = query.after === undefined ? null : read({ ...query, limit: LOG_PAGE_LIMIT });
      let pending: Held[] = [];
      let pendingHead = 0;
      let pendingBytes = 0;
      // Lines this follower dropped unsent since its last batch: its next batch says so.
      let dropped = false;
      let scheduled = false;
      let open = true;
      const flush = (): void => {
        scheduled = false;
        if (!open || pendingHead === pending.length) return;
        const held = pending.slice(pendingHead);
        pending = [];
        pendingHead = 0;
        pendingBytes = 0;
        // What is held fits one batch's bytes (the bound below), so a flush
        // splits by count alone: each batch within the budget.
        for (let index = 0; index < held.length; index += LOG_PAGE_LIMIT) {
          const entries = held.slice(index, index + LOG_PAGE_LIMIT).map(entryOf);
          const gap = dropped;
          dropped = false;
          listener({ entries, gap, cursor: entries.at(-1)!.cursor });
        }
      };
      const follower = (held: Held): void => {
        if (!passes(held.record, floor)) return;
        const cost = entryBytes(held);
        // A line no batch could carry is never sent; the next batch says it is missing.
        if (cost > room) {
          dropped = true;
          return;
        }
        pending.push(held);
        pendingBytes += cost;
        // Past the bound (or the ring's count), the oldest unsent go: the newest win.
        while (pendingBytes > maxPendingBytes || pending.length - pendingHead > limits.maxLines) {
          pendingBytes -= entryBytes(pending[pendingHead]!);
          pendingHead += 1;
          dropped = true;
        }
        if (pendingHead > 1024 && pendingHead * 2 > pending.length) {
          pending = pending.slice(pendingHead);
          pendingHead = 0;
        }
        if (scheduled) return;
        scheduled = true;
        // One flush per turn of the event loop: a burst is one frame, not hundreds.
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
