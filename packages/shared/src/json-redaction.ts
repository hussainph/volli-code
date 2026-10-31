/**
 * Exact-value credential redaction over a JSON value's strings.
 *
 * Redacting a JSON document's serialized bytes misses any value whose JSON
 * form is escaped (a newline in a PEM key is `\n` on disk, a quote is `\"`),
 * so a byte-level pass over a transcript body or a Pi log line would upload
 * those values whole. This walks the decoded value instead and runs every
 * string, object keys included, through the bounded streaming redactor
 * ({@link CredentialRedactionStream}) on its own, so each one is matched in
 * its decoded form and the result stays a valid JSON value. A number whose
 * text is a value becomes the marker string. Not seen: a value that is only
 * whole after a SECOND decode (JSON text escaped inside a string), or one
 * split across two strings.
 *
 * Fails closed exactly as the stream does: any redactor failure throws
 * {@link CredentialRedactionError}, and nothing partially redacted is returned.
 */

import {
  CredentialRedactionStream,
  type CredentialStreamStepper,
} from "./credential-stream-redaction";

/** A JSON value with every string redacted, and whether any string changed. */
export interface RedactedJson<T> {
  readonly value: T;
  readonly changed: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A string goes through its stream this many bytes at a time. The stream
 * matches across pushes exactly as within one, and a step's working memory
 * grows with the window it is given (several bytes per byte), so a string of
 * tens of MiB (an inline image in a Pi log line) is never one window.
 */
const PUSH_BYTES = 1024 * 1024;

/** One string, redacted whole: its own stream, pushed in pieces and ended. */
export function redactString(text: string, step: CredentialStreamStepper): string {
  if (text.length === 0) return text;
  // Nearly every long string holds no value: that is checked a piece at a
  // time, never encoding it whole. One that does is redacted below.
  if (text.length > PUSH_BYTES && unchanged(text, step)) return text;
  const input = encoder.encode(text);
  const stream = new CredentialRedactionStream(step);
  // Output that so far repeats the input is not kept: `same` bytes of it.
  let same = 0;
  let parts: Uint8Array[] | null = null;
  const take = (part: Uint8Array) => {
    if (parts === null && repeats(input, same, part)) same += part.length;
    else (parts ??= []).push(part);
  };
  for (let at = 0; at < input.length; at += PUSH_BYTES)
    take(stream.push(input.subarray(at, at + PUSH_BYTES)));
  take(stream.end());
  // Unchanged bytes keep the original string, so a lone surrogate (which
  // UTF-8 cannot carry) is never rewritten as U+FFFD by a no-op pass.
  if (parts === null && same === input.length) return text;
  return decoder.decode(joined([input.subarray(0, same), ...(parts ?? [])]));
}

/**
 * Whether redacting `text` would give back its own bytes, read a piece at a
 * time: only the input the stream has not yet answered for is held (what a
 * possible value's start makes it hold back).
 */
function unchanged(text: string, step: CredentialStreamStepper): boolean {
  const stream = new CredentialRedactionStream(step);
  const piece = new Uint8Array(PUSH_BYTES);
  let unanswered: Uint8Array = new Uint8Array(0);
  const answers = (part: Uint8Array) => {
    if (!repeats(unanswered, 0, part)) return false;
    unanswered = unanswered.subarray(part.length);
    return true;
  };
  for (let read = 0; read < text.length;) {
    const encoded = encoder.encodeInto(read === 0 ? text : text.slice(read), piece);
    read += encoded.read;
    // A copy: the stream may keep what it is given, and `piece` is reused.
    const bytes = piece.slice(0, encoded.written);
    unanswered = unanswered.length === 0 ? bytes : joined([unanswered, bytes]);
    if (!answers(stream.push(bytes))) return false;
  }
  return answers(stream.end()) && unanswered.length === 0;
}

/** Whether `part` is exactly `bytes` from `at`. */
function repeats(bytes: Uint8Array, at: number, part: Uint8Array): boolean {
  if (at + part.length > bytes.length) return false;
  for (let index = 0; index < part.length; index += 1) {
    if (bytes[at + index] !== part[index]) return false;
  }
  return true;
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * `value` with every string (keys and values, at any depth) redacted. A value
 * with nothing to redact comes back as the same reference, so a caller can
 * keep its original bytes.
 */
export function redactJsonValue<T>(value: T, step: CredentialStreamStepper): RedactedJson<T> {
  const redacted = walk(value, step);
  return { value: redacted as T, changed: redacted !== value };
}

function walk(value: unknown, step: CredentialStreamStepper): unknown {
  if (typeof value === "string") {
    const redacted = redactString(value, step);
    return redacted === value ? value : redacted;
  }
  if (typeof value === "number") {
    // A number that holds a value is replaced by the marker text: the type
    // changes, but nothing is left in the clear.
    const text = String(value);
    const redacted = redactString(text, step);
    return redacted === text ? value : redacted;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = walk(item, step);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const nextKey = redactString(key, step);
    const next = walk(item, step);
    if (nextKey !== key || next !== item) changed = true;
    return [nextKey, next] as const;
  });
  return changed ? Object.fromEntries(entries) : value;
}
