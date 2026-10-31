/**
 * Reading a written export chunk back without holding it whole: its bytes are
 * hashed as they are read, and each line is handed to a sink in pieces.
 *
 * A long Pi log record (`piLogs`) is read without holding its bytes either:
 * one slice may be one Pi line of up to `PI_MOVE_LINE_MAX_BYTES`, so past a
 * couple of MiB its `base64` field, which the exporter always writes last, is
 * decoded and hashed as it streams past ({@link PiRecordLine}). Every other
 * record is one JSON line, parsed whole.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

/** One line's bytes, in order, then its end. A sink is used for one line. */
export interface LineSink {
  piece(bytes: Buffer): void;
  end(): void;
}

export interface ScannedChunk {
  /** Bytes read (the file's size, unless it changed while it was read). */
  bytes: number;
  sha256: string;
  /** Newline-terminated lines. */
  lines: number;
  /** Whether the file ends with a newline (an empty file does not). */
  endsWithNewline: boolean;
  /**
   * The first fault a sink threw. Reading goes on to the end regardless, so
   * a damaged file is reported by its checksum before any line it holds.
   */
  fault: unknown;
}

const READ_BLOCK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/** Reads the chunk at `path`, feeding each line to a fresh sink from `sinkFor(lineNumber)`. */
export async function scanChunkLines(
  path: string,
  sinkFor: (lineNumber: number) => LineSink,
): Promise<ScannedChunk> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  const block = Buffer.alloc(READ_BLOCK_BYTES);
  let bytes = 0;
  let lines = 0;
  let last = -1;
  let fault: unknown = null;
  let sink = sinkFor(1);
  const guarded = (step: () => void) => {
    if (fault !== null) return;
    try {
      step();
    } catch (error) {
      fault = error;
    }
  };
  try {
    for (;;) {
      const { bytesRead } = await handle.read(block, 0, block.length, bytes);
      if (bytesRead === 0) break;
      const view = block.subarray(0, bytesRead);
      hash.update(view);
      bytes += bytesRead;
      last = view[bytesRead - 1]!;
      for (let start = 0; start < bytesRead;) {
        const newline = view.indexOf(NEWLINE, start);
        const end = newline === -1 ? bytesRead : newline;
        if (end > start) {
          const piece = view.subarray(start, end);
          guarded(() => sink.piece(piece));
        }
        if (newline === -1) break;
        lines += 1;
        const done = sink;
        guarded(() => done.end());
        sink = sinkFor(lines + 1);
        start = newline + 1;
      }
    }
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex"), lines, endsWithNewline: last === NEWLINE, fault };
}

/** A line read whole, then handed on as its UTF-8 text. */
export function wholeLine(onLine: (text: string) => void): LineSink {
  const pieces: Buffer[] = [];
  return {
    piece: (bytes) => void pieces.push(Buffer.from(bytes)),
    end: () => onLine(Buffer.concat(pieces).toString("utf8")),
  };
}

/** What a Pi record's `base64` decodes to, measured as it streamed past. */
export interface PiRecordBody {
  bytes: number;
  sha256: string;
  /** Newlines in it, the final byte's included. */
  newlines: number;
  /** Its final byte, or -1 when it is empty. */
  lastByte: number;
}

/** A line up to this long is parsed whole, exactly as any record; a longer one streams. */
const PI_WHOLE_LINE_MAX_BYTES = 2 * 1024 * 1024;
/** The record's other fields are far smaller than this in any export. */
const PI_HEAD_MAX_BYTES = 64 * 1024;
const BASE64_FIELD = Buffer.from(',"base64":"');
const QUOTE = 0x22;
const BASE64_BODY = /^[A-Za-z0-9+/]*$/;
const BASE64_END = /^[A-Za-z0-9+/]*={0,2}$/;

/** Thrown by {@link PiRecordLine} for a line it cannot read as a Pi record; the caller names it. */
export class PiRecordLineError extends Error {
  override readonly name = "PiRecordLineError";
  constructor(readonly kind: "json" | "record" | "base64") {
    super(kind);
  }
}

/**
 * One `piLogs` line. Up to {@link PI_WHOLE_LINE_MAX_BYTES} (every slice within
 * the slice bound) it is parsed whole (`onWhole`), like any record. A longer
 * one, one long Pi line, must be `{…fields…,"base64":"<canonical base64>"}`,
 * exactly as `JSON.stringify` writes a Pi record whose `base64` is its last
 * field (the exporter always writes it so): the fields before it are parsed
 * as JSON, and the base64 is decoded, hashed and counted in pieces.
 */
export class PiRecordLine implements LineSink {
  #whole: Buffer[] | null = [];
  #wholeBytes = 0;
  #state: "base64" | "tail" = "base64";
  #fields = "";
  #carry = "";
  #tail = "";
  #hash = createHash("sha256");
  #body: PiRecordBody = { bytes: 0, sha256: "", newlines: 0, lastByte: -1 };

  constructor(
    private readonly onRecord: (fields: Record<string, unknown>, body: PiRecordBody) => void,
    private readonly onWhole: (text: string) => void,
  ) {}

  piece(bytes: Buffer): void {
    if (this.#whole === null) {
      this.#stream(bytes);
      return;
    }
    this.#whole.push(Buffer.from(bytes));
    this.#wholeBytes += bytes.length;
    if (this.#wholeBytes <= PI_WHOLE_LINE_MAX_BYTES) return;
    // Too long to hold: the fields are in what is held, the base64 streams from there.
    const held = Buffer.concat(this.#whole);
    this.#whole = null;
    const at = held.indexOf(BASE64_FIELD);
    if (at === -1 || at > PI_HEAD_MAX_BYTES) throw new PiRecordLineError("record");
    this.#fields = `${held.subarray(0, at).toString("utf8")}}`;
    this.#stream(held.subarray(at + BASE64_FIELD.length));
  }

  end(): void {
    if (this.#whole !== null) {
      this.onWhole(Buffer.concat(this.#whole).toString("utf8"));
      return;
    }
    if (this.#state !== "tail" || this.#tail !== "}") throw new PiRecordLineError("record");
    let fields: Record<string, unknown>;
    try {
      // Text that ends in `}` and parses is an object.
      fields = JSON.parse(this.#fields) as Record<string, unknown>;
    } catch {
      throw new PiRecordLineError("json");
    }
    if (Object.hasOwn(fields, "base64")) throw new PiRecordLineError("record");
    this.onRecord(fields, { ...this.#body, sha256: this.#hash.digest("hex") });
  }

  #stream(bytes: Buffer): void {
    if (this.#state === "base64") {
      const quote = bytes.indexOf(QUOTE);
      if (quote === -1) {
        this.#data(bytes.toString("latin1"));
        return;
      }
      this.#finish(bytes.subarray(0, quote).toString("latin1"));
      this.#state = "tail";
      bytes = bytes.subarray(quote + 1);
    }
    this.#tail += bytes.toString("latin1");
    if (this.#tail.length > 1) throw new PiRecordLineError("record");
  }

  /** Base64 text inside the string: whole groups are decoded, the last one to four held back. */
  #data(text: string): void {
    const pending = this.#carry + text;
    const ready = pending.length - (pending.length % 4 || 4);
    const groups = pending.slice(0, Math.max(ready, 0));
    if (!BASE64_BODY.test(groups)) throw new PiRecordLineError("base64");
    this.#feed(Buffer.from(groups, "base64"));
    this.#carry = pending.slice(groups.length);
  }

  /** The string's last characters: the only place padding may be, and canonical. */
  #finish(text: string): void {
    const rest = this.#carry + text;
    if (rest.length % 4 !== 0 || !BASE64_END.test(rest)) throw new PiRecordLineError("base64");
    const decoded = Buffer.from(rest, "base64");
    if (decoded.toString("base64") !== rest) throw new PiRecordLineError("base64");
    this.#feed(decoded);
  }

  #feed(bytes: Buffer): void {
    this.#hash.update(bytes);
    this.#body.bytes += bytes.length;
    for (let at = bytes.indexOf(NEWLINE); at !== -1; at = bytes.indexOf(NEWLINE, at + 1))
      this.#body.newlines += 1;
    if (bytes.length > 0) this.#body.lastByte = bytes[bytes.length - 1]!;
  }
}
