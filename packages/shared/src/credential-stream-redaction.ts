/**
 * Bounded, fail-closed streaming exact-value redaction over UTF-8 bytes.
 *
 * The whole-string redactor (`SecretStore.redact`) cannot be applied to a
 * stream one chunk at a time: a credential split across two pipe chunks, a
 * UTF-8 boundary or a byte cap would never be seen whole. Buffering the whole
 * stream instead would trade bounded streaming for an allocation as large as
 * the output. This module is the bounded middle: each step redacts what is
 * decided and withholds only an undecided credential prefix, so a writer
 * (a shell spill, or anything else that persists or uploads output) never receives plaintext of a
 * value the redactor knew when the bytes were decided.
 *
 * Matching works on bytes, not decoded text. For valid UTF-8 the result is the
 * UTF-8 encoding of `redact(decoded)` (same occurrences, same overlap merge,
 * same markers); invalid UTF-8 and binary output pass through byte for byte
 * instead of becoming U+FFFD, and no decoder boundary can split a value.
 *
 * The split keeps values out of callers: {@link ExactValueByteRedactor} is built
 * where values live (the host's secret store) and is reached only through its
 * {@link CredentialStreamStepper}; {@link CredentialRedactionStream} carries the
 * per-stream state wherever the bytes flow and never sees a value.
 */

/** One step's answer. All offsets are in `window` bytes. */
export interface CredentialStreamStep {
  /** The redacted form of `window[from, consumed)`. */
  readonly bytes: Uint8Array;
  /** Bytes before this offset are decided and never emitted again. */
  readonly consumed: number;
  /**
   * How many decided bytes before `consumed` the next step must see again as
   * read-only context, so a protected span crossing `consumed` stays protected.
   */
  readonly context: number;
}

/**
 * One redaction step. `window[0, from)` is context already emitted by an
 * earlier step; `final` means no more bytes will follow, so nothing is held.
 */
export type CredentialStreamStepper = (
  window: Uint8Array,
  from: number,
  final: boolean,
) => CredentialStreamStep;

/** Every failure reads the same: the cause may contain the text being redacted. */
export class CredentialRedactionError extends Error {
  constructor() {
    super("Credential redaction failed.");
    this.name = "CredentialRedactionError";
  }
}

interface CompiledValue {
  readonly bytes: Uint8Array;
  /** KMP failure table: complete and trailing-prefix matches stay linear. */
  readonly borders: Uint32Array;
  readonly marker: Uint8Array;
}

const EMPTY = new Uint8Array(0);

function compile(value: Uint8Array, marker: Uint8Array): CompiledValue {
  const borders = new Uint32Array(value.length);
  for (let i = 1, matched = 0; i < value.length; i += 1) {
    while (matched > 0 && value[i] !== value[matched]) matched = borders[matched - 1]!;
    if (value[i] === value[matched]) matched += 1;
    borders[i] = matched;
  }
  return { bytes: value, borders, marker };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Exact-value matching for a fixed set of values, each with its replacement
 * marker. Build a new one when the set changes; stepping is pure.
 */
export class ExactValueByteRedactor {
  readonly #values: readonly CompiledValue[];
  readonly #longest: number;

  /** Empty values are ignored: they can match nothing. */
  constructor(entries: Iterable<readonly [value: string, marker: string]>) {
    const encoder = new TextEncoder();
    const values: CompiledValue[] = [];
    for (const [value, marker] of entries) {
      if (value.length === 0) continue;
      values.push(compile(encoder.encode(value), encoder.encode(marker)));
    }
    this.#values = values;
    this.#longest = Math.max(0, ...values.map((value) => value.bytes.length));
  }

  /** See {@link CredentialStreamStepper}. */
  step(window: Uint8Array, from: number, final: boolean): CredentialStreamStep {
    const length = window.length;
    if (!Number.isInteger(from) || from < 0 || from > length) {
      throw new RangeError("from must be an offset inside the window");
    }
    if (this.#values.length === 0) {
      return { bytes: window.subarray(from), consumed: length, context: 0 };
    }
    // The longest complete value starting at each offset, and which one it is.
    const lengths = new Uint32Array(length);
    const owner = new Uint32Array(length);
    // Bytes from `hold` on may still begin a value the next chunk completes.
    let hold = length;
    for (let index = 0; index < this.#values.length; index += 1) {
      const { bytes: value, borders } = this.#values[index]!;
      let matched = 0;
      for (let at = 0; at < length; at += 1) {
        while (matched > 0 && window[at] !== value[matched]) matched = borders[matched - 1]!;
        if (window[at] === value[matched]) matched += 1;
        if (matched !== value.length) continue;
        const start = at - value.length + 1;
        if (value.length > lengths[start]!) {
          lengths[start] = value.length;
          owner[start] = index;
        }
        matched = borders[matched - 1]!;
      }
      // After the scan `matched` is the longest proper prefix of the value
      // that ends the window: the earliest place a later match could start.
      if (!final) hold = Math.min(hold, length - matched);
    }
    // A step never takes back what an earlier one decided.
    const consumed = Math.max(hold, from);
    const parts: Uint8Array[] = [];
    let cursor = from;
    for (let at = 0; at < consumed; at += 1) {
      if (lengths[at] === 0) continue;
      // Overlapping values are one protected span, as in the whole-string
      // redactor: never expose a suffix because another value started earlier.
      let end = at + lengths[at]!;
      for (let next = at + 1; next < end; next += 1) end = Math.max(end, next + lengths[next]!);
      if (end > from) {
        // A span that started in the context already had its marker emitted.
        if (at >= from) parts.push(window.subarray(cursor, at), this.#values[owner[at]!]!.marker);
        cursor = Math.min(end, consumed);
      }
      at = end - 1;
    }
    parts.push(window.subarray(cursor, consumed));
    // Only a value complete in this window can cross `consumed` (an incomplete
    // one would have held it back). The next step re-reads from the earliest
    // such value, so it still sees that span as protected and already marked.
    let context = 0;
    for (let at = Math.max(0, consumed - this.#longest + 1); at < consumed; at += 1) {
      if (at + lengths[at]! > consumed) {
        context = consumed - at;
        break;
      }
    }
    return { bytes: concat(parts), consumed, context };
  }
}

export interface CredentialRedactionStreamOptions {
  /**
   * Fail closed rather than retain more than this many bytes between steps.
   * Retention is normally at most twice the longest value; this bounds a
   * pathological one.
   */
  readonly maxRetainedBytes?: number;
}

/** Retained context and undecided prefix between steps, before failing closed. */
export const CREDENTIAL_STREAM_MAX_RETAINED_BYTES = 8 * 1024 * 1024;

/**
 * One stream's state over a {@link CredentialStreamStepper}. `push` returns
 * the redacted bytes that are now safe to write; `end` returns the rest. Any
 * failure, including a malformed step answer, throws
 * {@link CredentialRedactionError} and every later call throws again: nothing
 * undecided is ever returned once the redactor has failed.
 */
export class CredentialRedactionStream {
  readonly #step: CredentialStreamStepper;
  readonly #maxRetainedBytes: number;
  #window: Uint8Array = EMPTY;
  #from = 0;
  #state: "open" | "ended" | "failed" = "open";

  constructor(step: CredentialStreamStepper, options: CredentialRedactionStreamOptions = {}) {
    this.#step = step;
    this.#maxRetainedBytes = options.maxRetainedBytes ?? CREDENTIAL_STREAM_MAX_RETAINED_BYTES;
  }

  push(chunk: Uint8Array): Uint8Array {
    if (this.#state !== "open") throw this.#fail();
    if (chunk.length === 0) return EMPTY;
    this.#window = this.#window.length === 0 ? chunk : concat([this.#window, chunk]);
    return this.#run(false);
  }

  end(): Uint8Array {
    if (this.#state !== "open") throw this.#fail();
    const rest = this.#run(true);
    this.#state = "ended";
    return rest;
  }

  #run(final: boolean): Uint8Array {
    const window = this.#window;
    const from = this.#from;
    let step: CredentialStreamStep;
    try {
      step = this.#step(window, from, final);
    } catch {
      throw this.#fail();
    }
    const { bytes, consumed, context } = (step ?? {}) as Partial<CredentialStreamStep>;
    if (
      !(bytes instanceof Uint8Array) ||
      typeof consumed !== "number" ||
      typeof context !== "number" ||
      !Number.isInteger(consumed) ||
      !Number.isInteger(context) ||
      consumed < from ||
      consumed > window.length ||
      (final && consumed !== window.length) ||
      context < 0 ||
      context > consumed ||
      window.length - consumed + context > this.#maxRetainedBytes
    ) {
      throw this.#fail();
    }
    // Copy what is retained so a large chunk is not kept alive by a view.
    this.#window = consumed - context === window.length ? EMPTY : window.slice(consumed - context);
    this.#from = context;
    return bytes;
  }

  #fail(): CredentialRedactionError {
    this.#state = "failed";
    this.#window = EMPTY;
    return new CredentialRedactionError();
  }
}
