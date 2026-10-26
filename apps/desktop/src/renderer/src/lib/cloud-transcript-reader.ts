/**
 * Transcript bodies on Volli Cloud, for the Session view (VC-931).
 *
 * A history fact names its message body by digest (`transcript.referenced`,
 * or the reference a submitted message or an answered question records). The
 * body is in one of three places (`convex/functions/sessionTranscript.ts`):
 *
 * 1. **Staged inline**: `sessionTranscript.artifacts` returns its text.
 * 2. **Staged spilled**: its own zstd-compressed object, read through one
 *    signed GET (`presignGet({ kind: "spill" })`).
 * 3. **Packed**: in the `volli.transcript-pack/1` object of the committed
 *    segment whose range covers the referencing fact. Segments tile the
 *    sequence space from 1, so `segments({ beforeSequence: n + 1 })` names it.
 *
 * Staging is asked first because it is one query for a whole window; a body
 * it reports absent was packed (its staging row expires an hour after) and is
 * read from its pack. Bytes come straight from the object store; a pack is
 * checked against the SHA-256 the backend recorded before it is read.
 *
 * Bounded: digests go 64 to a staging read, a window's packs are found in a
 * few segment reads, and the last two decoded packs and the last thousand
 * messages are kept, so paging older history through one pack fetches it once.
 * A body none of the three places holds is left out and reported; the fact
 * still draws as an event.
 */
import type { TranscriptReference } from "@volli/shared";
import { STAGE_ARTIFACTS_MAX_BATCH, TRANSCRIPT_PACK_FORMAT } from "@volli/shared/cloud";
import type { UIMessage } from "ai";

import { readTranscriptMessage } from "./cloud-session-view";

/** One body a window needs: the fact that references it, and the reference. */
export interface CloudTranscriptRequest {
  sequence: number;
  reference: TranscriptReference;
}

/** Bodies by the sequence of the fact that references them; a missing one is unreadable. */
export type CloudTranscriptReader = (
  sessionId: string,
  requests: readonly CloudTranscriptRequest[],
) => Promise<ReadonlyMap<number, UIMessage>>;

/** An object of one Session that `presignGet` signs a GET for. */
export type CloudSessionObject =
  | { kind: "pack"; segmentId: string }
  | { kind: "spill"; digest: string };

/** A signed GET, as the object store expects it. */
export interface CloudSignedGet {
  url: string;
  headers: Readonly<Record<string, string>>;
}

/** Everything the reader reaches outside itself. */
export interface CloudTranscriptSource {
  /** `sessionTranscript.artifacts`. */
  artifacts(sessionId: string, digests: readonly string[]): Promise<unknown>;
  /** `sessionTranscript.segments`. */
  segments(sessionId: string, beforeSequence: number, limit: number): Promise<unknown>;
  /** `sessionTranscript.presignGet`. */
  presignGet(sessionId: string, object: CloudSessionObject): Promise<unknown>;
  /** One signed GET's body. */
  download(request: CloudSignedGet): Promise<Uint8Array>;
  /** zstd. */
  decompress(bytes: Uint8Array): Uint8Array;
  /** SHA-256 of `bytes`, lowercase hex. */
  sha256Hex(bytes: Uint8Array): Promise<string>;
  /** Where an unreadable body is reported. */
  warn(message: string): void;
}

/** Segments one `segments` read asks for. */
const SEGMENT_PAGE = 16;
/** Segment reads one window may make before its remaining bodies count as missing. */
const MAX_SEGMENT_READS = 8;
const MESSAGE_CACHE = 1024;
const PACK_CACHE = 2;

interface SegmentManifest {
  segmentId: string;
  firstSequence: number;
  lastSequence: number;
  sha256: string | null;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A Map that forgets its least recently used entry past `limit`. */
class Recent<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#limit) {
      this.#entries.delete(this.#entries.keys().next().value as K);
    }
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }
}

function parseJsonText(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The cloud ${what} is not JSON`);
  }
}

function readSignedGet(value: unknown, what: string): CloudSignedGet | null {
  if (!isRecord(value)) throw new Error(`The cloud grant for ${what} is malformed`);
  if (value.status === "absent") return null;
  const request = value.request;
  if (
    value.status !== "sign" ||
    !isRecord(request) ||
    typeof request.url !== "string" ||
    !isRecord(request.headers) ||
    !Object.values(request.headers).every((header) => typeof header === "string")
  ) {
    throw new Error(`The cloud grant for ${what} is malformed`);
  }
  return { url: request.url, headers: request.headers as Record<string, string> };
}

function readSegments(value: unknown): SegmentManifest[] {
  if (!isRecord(value) || !Array.isArray(value.segments)) {
    throw new Error("The cloud transcript segments are malformed");
  }
  return value.segments.map((segment): SegmentManifest => {
    if (
      !isRecord(segment) ||
      typeof segment.segmentId !== "string" ||
      !isSequence(segment.firstSequence) ||
      !isSequence(segment.lastSequence) ||
      segment.lastSequence < segment.firstSequence
    ) {
      throw new Error("The cloud transcript segments are malformed");
    }
    return {
      segmentId: segment.segmentId,
      firstSequence: segment.firstSequence,
      lastSequence: segment.lastSequence,
      sha256: typeof segment.sha256 === "string" ? segment.sha256 : null,
    };
  });
}

/**
 * A pack's bodies by digest. The header must name this Session and the
 * segment's range; every line after it is one artifact.
 */
export function readTranscriptPack(
  text: string,
  sessionId: string,
  segment: Pick<SegmentManifest, "firstSequence" | "lastSequence">,
): Map<string, unknown> {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const header = parseJsonText(lines[0] ?? "", "transcript pack header");
  if (
    !isRecord(header) ||
    header.format !== TRANSCRIPT_PACK_FORMAT ||
    header.sessionId !== sessionId ||
    header.firstSequence !== segment.firstSequence ||
    header.lastSequence !== segment.lastSequence
  ) {
    throw new Error("The cloud transcript pack does not match its segment");
  }
  const bodies = new Map<string, unknown>();
  for (const line of lines.slice(1)) {
    const entry = parseJsonText(line, "transcript pack entry");
    if (!isRecord(entry) || typeof entry.digest !== "string" || !("body" in entry)) {
      throw new Error("The cloud transcript pack holds a malformed entry");
    }
    bodies.set(entry.digest, entry.body);
  }
  if (typeof header.artifactCount === "number" && header.artifactCount !== lines.length - 1) {
    throw new Error("The cloud transcript pack is incomplete");
  }
  return bodies;
}

export function createCloudTranscriptReader(source: CloudTranscriptSource): CloudTranscriptReader {
  const messages = new Recent<string, UIMessage>(MESSAGE_CACHE);
  const packs = new Recent<string, Promise<Map<string, unknown>>>(PACK_CACHE);
  const decoder = new TextDecoder();

  async function signedBytes(sessionId: string, object: CloudSessionObject, what: string) {
    const grant = readSignedGet(await source.presignGet(sessionId, object), what);
    if (grant === null) return null;
    return source.download(grant);
  }

  function pack(sessionId: string, segment: SegmentManifest): Promise<Map<string, unknown>> {
    const held = packs.get(segment.segmentId);
    if (held !== undefined) return held;
    const loading = (async () => {
      const bytes = await signedBytes(
        sessionId,
        { kind: "pack", segmentId: segment.segmentId },
        "a transcript pack",
      );
      if (bytes === null) throw new Error("A committed transcript pack is not readable");
      if (segment.sha256 !== null && (await source.sha256Hex(bytes)) !== segment.sha256) {
        throw new Error("A transcript pack does not match its checksum");
      }
      return readTranscriptPack(decoder.decode(source.decompress(bytes)), sessionId, segment);
    })();
    packs.set(segment.segmentId, loading);
    // A failed load is not kept: the next window asks again.
    loading.catch(() => packs.delete(segment.segmentId));
    return loading;
  }

  /** The committed segments covering `sequences` (descending), within the read budget. */
  async function covering(
    sessionId: string,
    sequences: readonly number[],
  ): Promise<SegmentManifest[]> {
    const found: SegmentManifest[] = [];
    const covers = (sequence: number) =>
      found.some(
        (segment) => segment.firstSequence <= sequence && sequence <= segment.lastSequence,
      );
    let reads = 0;
    for (const sequence of sequences) {
      if (covers(sequence)) continue;
      if (reads >= MAX_SEGMENT_READS) break;
      reads += 1;
      found.push(...readSegments(await source.segments(sessionId, sequence + 1, SEGMENT_PAGE)));
    }
    return found;
  }

  return async (sessionId, requests) => {
    const out = new Map<number, UIMessage>();
    /** Sequences waiting on each digest. */
    const wanted = new Map<string, number[]>();
    const key = (digest: string) => `${sessionId}\n${digest}`;
    let missing = 0;
    for (const { sequence, reference } of requests) {
      const digest = reference.digest;
      if (digest === null) {
        missing += 1;
        continue;
      }
      const cached = messages.get(key(digest));
      if (cached !== undefined) out.set(sequence, cached);
      else wanted.set(digest, [...(wanted.get(digest) ?? []), sequence]);
    }
    const resolve = (digest: string, body: unknown) => {
      const message = readTranscriptMessage(
        typeof body === "string" ? parseJsonText(body, "transcript body") : body,
      );
      if (message === null) return;
      messages.set(key(digest), message);
      for (const sequence of wanted.get(digest)!) out.set(sequence, message);
      wanted.delete(digest);
    };

    // 1–2: what staging still holds.
    const digests = [...wanted.keys()];
    const spilled: string[] = [];
    for (let index = 0; index < digests.length; index += STAGE_ARTIFACTS_MAX_BATCH) {
      const answer = await source.artifacts(
        sessionId,
        digests.slice(index, index + STAGE_ARTIFACTS_MAX_BATCH),
      );
      if (!Array.isArray(answer)) throw new Error("The cloud transcript artifacts are malformed");
      for (const entry of answer) {
        if (!isRecord(entry) || typeof entry.digest !== "string" || !wanted.has(entry.digest)) {
          continue;
        }
        if (entry.status === "inline" && typeof entry.body === "string") {
          resolve(entry.digest, entry.body);
        } else if (entry.status === "spilled") spilled.push(entry.digest);
      }
    }
    await Promise.all(
      spilled.map(async (digest) => {
        const bytes = await signedBytes(sessionId, { kind: "spill", digest }, "a transcript body");
        // Absent now: packed since the staging read, and its pack has it.
        if (bytes !== null) resolve(digest, decoder.decode(source.decompress(bytes)));
      }),
    );

    // 3: the packs covering what staging no longer holds.
    if (wanted.size > 0) {
      const sequences = [...new Set([...wanted.values()].flat())].toSorted((a, b) => b - a);
      const segments = await covering(sessionId, sequences);
      const needed = segments.filter((segment) =>
        sequences.some(
          (sequence) => segment.firstSequence <= sequence && sequence <= segment.lastSequence,
        ),
      );
      const bodies = await Promise.all(needed.map((segment) => pack(sessionId, segment)));
      for (const held of bodies) {
        // Deleting the visited key while iterating a Map is safe.
        for (const digest of wanted.keys()) {
          if (held.has(digest)) resolve(digest, held.get(digest));
        }
      }
    }

    for (const sequences of wanted.values()) missing += sequences.length;
    if (missing > 0) {
      source.warn(`[cloud-session] ${missing} transcript bodies of ${sessionId} are unreadable`);
    }
    return out;
  };
}
