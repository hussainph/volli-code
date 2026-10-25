import type { TranscriptReference } from "@volli/shared";
import {
  canonicalJson,
  TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  type SessionTranscriptArtifact,
  type TranscriptArtifactStore,
} from "../transcript-artifacts";

const FNV1A64_ID = /^fnv1a64:([a-f0-9]{16})$/;

/**
 * Transcript artifacts held in memory, for tests. Production injects
 * host-core's `FileTranscriptArtifactStore`; both are held to
 * `describeTranscriptArtifactStoreContract`. Content-addressed like the file
 * store, under a cheap non-cryptographic digest rather than SHA-256.
 */
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

/** Small deterministic test digest; production stores use SHA-256. */
function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
