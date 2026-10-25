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

/** One string, redacted whole: its own stream, pushed once and ended. */
export function redactString(text: string, step: CredentialStreamStepper): string {
  if (text.length === 0) return text;
  const input = encoder.encode(text);
  const stream = new CredentialRedactionStream(step);
  const head = stream.push(input);
  const tail = stream.end();
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  // Unchanged bytes keep the original string, so a lone surrogate (which
  // UTF-8 cannot carry) is never rewritten as U+FFFD by a no-op pass.
  return sameBytes(input, out) ? text : decoder.decode(out);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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
