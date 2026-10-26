/**
 * The canonical JSON every transcript store hashes: the bytes behind a
 * `sha256:<hex>` transcript reference. One definition, so the runner's
 * Session runtime (`@volli/session-engine` re-exports it as `canonicalJson`),
 * the backend that stages a client's message body and the client that builds
 * it agree byte for byte.
 */

/**
 * JSON.stringify-compatible serialization with deterministic object-key order.
 * Undefined object properties are omitted; undefined array slots become null.
 */
export function transcriptCanonicalJson(value: unknown): string {
  const encoded = encodeJson(value, new Set());
  if (encoded === undefined)
    throw new TypeError("Cannot serialize an undefined transcript artifact");
  return encoded;
}

function encodeJson(value: unknown, ancestors: Set<object>): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (ancestors.has(value)) throw new TypeError("Cannot serialize a circular transcript artifact");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from({ length: value.length }, (_, index) => encodeJson(value[index], ancestors) ?? "null").join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Cannot serialize a non-plain object in a transcript artifact");
    }
    return `{${Object.keys(value)
      .toSorted(compareJsonKeys)
      .flatMap((property) => {
        const item = encodeJson((value as Record<string, unknown>)[property], ancestors);
        return item === undefined ? [] : [`${JSON.stringify(property)}:${item}`];
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function compareJsonKeys(left: string, right: string): number {
  /* v8 ignore next -- Object.keys returns unique keys. */
  return left < right ? -1 : left > right ? 1 : 0;
}
