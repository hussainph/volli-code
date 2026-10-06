import type { TranscriptReference } from "@volli/shared";
import type { UIMessage } from "ai";

export const TRANSCRIPT_ARTIFACT_MEDIA_TYPE = "application/vnd.volli.ui-message+json";

const FNV1A64_ID = /^fnv1a64:([a-f0-9]{16})$/;

export interface SessionTranscriptArtifact {
  version: 1;
  threadId: string;
  branchId: string;
  attemptId: string;
  turnId: string | null;
  message: UIMessage;
}

export interface TranscriptArtifactStore {
  write(artifact: SessionTranscriptArtifact): Promise<TranscriptReference>;
  read(reference: TranscriptReference): Promise<SessionTranscriptArtifact>;
  /**
   * The artifact's size as UTF-8 canonical JSON — what it adds to a frame on
   * the wire — read from what the store persisted beside the body, never by
   * reading the body (VC-315). A history window is selected from these sizes
   * and only then hydrated, so a body outside the window is never read and an
   * unreadable one outside it cannot fail the window.
   *
   * `null` when the store cannot say (the artifact is missing, or its size
   * metadata is unreadable): the window then treats the frame as too large to
   * join a window that already holds one, so it is read only on a page of its
   * own. Must not throw. A store without this method is measured by reading
   * each candidate body, as before VC-315.
   */
  byteLength?(reference: TranscriptReference): Promise<number | null>;
}

class InMemoryTranscriptArtifactStore implements TranscriptArtifactStore {
  readonly #artifacts = new Map<string, string>();

  async write(artifact: SessionTranscriptArtifact): Promise<TranscriptReference> {
    const encoded = canonicalJson(artifact);
    const digest = `fnv1a64:${fnv1a64(encoded)}`;
    const reference = {
      id: digest,
      mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
      digest,
    };
    const existing = this.#artifacts.get(reference.id);
    /* v8 ignore next 3 -- requires an actual 64-bit FNV collision. Production uses SHA-256. */
    if (existing && existing !== encoded) {
      throw new Error(`Transcript artifact ${reference.id} has conflicting content`);
    }
    this.#artifacts.set(reference.id, encoded);
    return reference;
  }

  async read(reference: TranscriptReference): Promise<SessionTranscriptArtifact> {
    if (
      !FNV1A64_ID.test(reference.id) ||
      reference.digest !== reference.id ||
      reference.mediaType !== TRANSCRIPT_ARTIFACT_MEDIA_TYPE
    ) {
      throw new Error("Transcript artifact reference is invalid");
    }
    const encoded = this.#artifacts.get(reference.id);
    if (!encoded) throw new Error(`Transcript artifact ${reference.id} was not found`);
    return JSON.parse(encoded) as SessionTranscriptArtifact;
  }

  async byteLength(reference: TranscriptReference): Promise<number | null> {
    const encoded = this.#artifacts.get(reference.id);
    return encoded === undefined ? null : utf8.encode(encoded).length;
  }
}

const utf8 = new TextEncoder();

export function createInMemoryTranscriptArtifactStore(): TranscriptArtifactStore {
  return new InMemoryTranscriptArtifactStore();
}

/**
 * JSON.stringify-compatible serialization with deterministic object-key order.
 * Undefined object properties are omitted; undefined array slots become null.
 */
export function canonicalJson(value: unknown): string {
  const encoded = encodeJson(value, new Set());
  if (encoded === undefined)
    throw new TypeError("Cannot serialize an undefined transcript artifact");
  return encoded;
}

function encodeJson(value: unknown, ancestors: Set<object>): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  /* v8 ignore next -- UIMessage values are JSON values and cannot be cyclic. */
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

/** Small deterministic test digest; production stores use SHA-256. */
function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
