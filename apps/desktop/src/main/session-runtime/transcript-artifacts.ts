import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gunzipSync, gzip } from "node:zlib";

import {
  canonicalJson,
  TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  type SessionTranscriptArtifact,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import type { TranscriptReference } from "@volli/shared";

const SHA_256_ID = /^sha256:([a-f0-9]{64})$/;
const LEGACY_ARTIFACT_NAME = /^([a-f0-9]{64})\.json$/;
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * A content-addressed, append-only store for durable transcript artifacts.
 *
 * The ledger is allowed to reference a returned artifact only after this store
 * has synced its bytes and atomically made them visible at their digest path.
 * Artifact names are derived solely from validated SHA-256 digests, so callers
 * never influence filesystem paths.
 *
 * Compressed artifacts use `<sha256>.json.gz`, while legacy plain artifacts
 * keep `<sha256>.json`. Keeping distinct names lets the repack publish and
 * verify a compressed sibling with the store's no-replace hard link before it
 * removes the legacy file. The digest and backup archive path still identify
 * the uncompressed canonical JSON bytes, so neither ledger references nor
 * bundle version 1 change.
 */
export class FileTranscriptArtifactStore implements TranscriptArtifactStore {
  #ready: Promise<void> | undefined;

  constructor(private readonly baseDirectory: string) {}

  async write(artifact: SessionTranscriptArtifact): Promise<TranscriptReference> {
    assertArtifact(artifact);
    const bytes = Buffer.from(canonicalJson(artifact), "utf8");
    const reference = referenceFor(digestBytes(bytes));
    return this.writeCanonicalBytes(reference, bytes);
  }

  /**
   * Installs already-canonical bytes through the same atomic compressed writer.
   * Restore uses this rather than writing a bundle entry directly into place.
   */
  async writeCanonicalBytes(
    reference: TranscriptReference,
    bytes: Uint8Array,
  ): Promise<TranscriptReference> {
    const digest = validateReference(reference);
    const canonicalBytes = Buffer.from(bytes);
    if (digestBytes(canonicalBytes) !== digest) {
      throw new Error(`Transcript artifact ${reference.id} failed checksum verification`);
    }
    parseArtifact(canonicalBytes, reference.id);
    await this.ensureDirectory();

    const { compressed, legacy } = this.pathsFor(reference.id);
    try {
      await this.verifyStored(compressed, digest, "gzip");
      return reference;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await this.verifyStored(legacy, digest, "plain");
      return reference;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    await this.publishCompressed(canonicalBytes, digest, compressed);
    return reference;
  }

  async read(reference: TranscriptReference): Promise<SessionTranscriptArtifact> {
    const bytes = await this.readCanonicalBytes(reference);
    return parseArtifact(bytes, reference.id);
  }

  /** Reads either disk form and returns verified, uncompressed canonical bytes. */
  async readCanonicalBytes(reference: TranscriptReference): Promise<Buffer> {
    const digest = validateReference(reference);
    const { compressed, legacy } = this.pathsFor(reference.id);
    try {
      return await this.readAndVerify(compressed, digest, "gzip");
    } catch (error) {
      // A present compressed path is authoritative. Corruption must not be
      // hidden by a valid legacy sibling left behind during an interrupted run.
      if (!isMissing(error)) throw error;
    }
    return this.readAndVerify(legacy, digest, "plain");
  }

  /** Synchronous verified byte seam for the currently-synchronous bundle writer. */
  readCanonicalBytesSync(reference: TranscriptReference): Buffer {
    const digest = validateReference(reference);
    const { compressed, legacy } = this.pathsFor(reference.id);
    try {
      return readAndVerifySync(compressed, digest, "gzip");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return readAndVerifySync(legacy, digest, "plain");
  }

  /** The legacy names present at the start of one restart-safe repack pass. */
  async listLegacyArtifactNames(): Promise<string[]> {
    await this.ensureDirectory();
    return (await readdir(this.baseDirectory))
      .filter((name) => LEGACY_ARTIFACT_NAME.test(name))
      .toSorted();
  }

  /**
   * Repack one legacy file. The plain path is removed only after the compressed
   * sibling has been published, inflated, and verified to the same digest.
   */
  async repackLegacyArtifact(name: string): Promise<void> {
    const match = LEGACY_ARTIFACT_NAME.exec(name);
    if (!match) throw new Error(`Unrecognized legacy transcript artifact ${name}`);
    const digest = `sha256:${match[1]}`;
    const legacy = join(this.baseDirectory, name);
    const compressed = join(this.baseDirectory, `${match[1]}.json.gz`);

    const before = await lstat(legacy);
    if (!before.isFile()) throw new Error("Legacy transcript artifact is not a regular file");
    const bytes = await this.readAndVerify(legacy, digest, "plain");
    await this.publishCompressed(bytes, digest, compressed);
    // This separate read-back is intentionally not satisfied by the publisher's
    // winner check: deletion is gated on what is reachable at the final path.
    await this.verifyStored(compressed, digest, "gzip");

    // A live store never overwrites a legacy path, but re-check its identity and
    // bytes before unlinking so an external replacement is kept, not deleted
    // merely because it inherited a digest-shaped name.
    const after = await lstat(legacy);
    if (!sameFile(before, after)) {
      throw new Error("Legacy transcript artifact changed during repack");
    }
    await this.verifyStored(legacy, digest, "plain");
    await unlink(legacy);
    await this.syncDirectory();
  }

  private async ensureDirectory(): Promise<void> {
    const ready =
      this.#ready ??
      (this.#ready = mkdir(this.baseDirectory, { recursive: true, mode: 0o700 }).then(
        () => undefined,
      ));
    try {
      await ready;
    } catch (error) {
      if (this.#ready === ready) this.#ready = undefined;
      throw error;
    }
  }

  private pathsFor(id: string): { compressed: string; legacy: string } {
    const match = SHA_256_ID.exec(id);
    if (!match) throw new Error("Transcript artifact reference must be a SHA-256 digest");
    return {
      compressed: join(this.baseDirectory, `${match[1]}.json.gz`),
      legacy: join(this.baseDirectory, `${match[1]}.json`),
    };
  }

  private async publishCompressed(
    canonicalBytes: Buffer,
    expectedDigest: string,
    destination: string,
  ): Promise<void> {
    const packed = await gzipAsync(canonicalBytes);
    const temporary = join(
      this.baseDirectory,
      `.${expectedDigest.slice("sha256:".length)}.${randomBytes(16).toString("hex")}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(packed);
      await handle.sync();
      await handle.close();
      handle = undefined;

      // link is an atomic no-replace publish. If another writer won the race,
      // its compressed bytes must independently inflate and verify.
      try {
        await link(temporary, destination);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      await this.syncDirectory();
      await unlink(temporary);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }

    await this.verifyStored(destination, expectedDigest, "gzip");
  }

  private async readAndVerify(
    path: string,
    expectedDigest: string,
    form: "gzip" | "plain",
  ): Promise<Buffer> {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error("Transcript artifact path is not a regular file");
    const stored = await readFile(path);
    const bytes = await decodeStoredBytes(stored, form);
    if (digestBytes(bytes) !== expectedDigest) {
      throw new Error("Transcript artifact path contains bytes for another digest");
    }
    return bytes;
  }

  private async verifyStored(
    path: string,
    expectedDigest: string,
    form: "gzip" | "plain",
  ): Promise<void> {
    await this.readAndVerify(path, expectedDigest, form);
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.baseDirectory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export interface TranscriptRepackOptions {
  /** Files attempted between yields. */
  batchSize?: number;
  signal?: AbortSignal;
  /** Production throttles here; tests inject a deterministic pause. */
  pause?: () => Promise<void>;
  onError?: (path: string, error: unknown) => void;
}

export interface TranscriptRepackReport {
  scanned: number;
  repacked: number;
  skipped: number;
  aborted: boolean;
}

/**
 * Runs one restart-safe legacy scan in small batches. It has no durable cursor:
 * compressed siblings make every successful item disappear from the next scan,
 * while any failed or interrupted item remains readable and is retried later.
 */
export async function repackLegacyTranscriptArtifacts(
  store: FileTranscriptArtifactStore,
  options: TranscriptRepackOptions = {},
): Promise<TranscriptRepackReport> {
  const names = await store.listLegacyArtifactNames();
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 25));
  const pause = options.pause ?? (() => delay(250));
  let repacked = 0;
  let skipped = 0;
  let index = 0;

  while (index < names.length && !options.signal?.aborted) {
    const batch = names.slice(index, index + batchSize);
    for (const name of batch) {
      if (options.signal?.aborted) break;
      try {
        await store.repackLegacyArtifact(name);
        repacked += 1;
      } catch (error) {
        skipped += 1;
        options.onError?.(name, error);
      }
    }
    index += batch.length;
    if (index < names.length && !options.signal?.aborted) await pause();
  }

  return {
    scanned: names.length,
    repacked,
    skipped,
    aborted: options.signal?.aborted ?? false,
  };
}

export function createFileTranscriptArtifactStore(
  baseDirectory: string,
): FileTranscriptArtifactStore {
  return new FileTranscriptArtifactStore(baseDirectory);
}

/**
 * The transcript store's directory under a given Electron `userData` path.
 *
 * Named here rather than joined at the one call site, on `blobsRoot`'s
 * argument: the backup register has to say what happens to this directory, and
 * a declaration matched against a string literal somewhere else is a
 * declaration that goes stale the day the directory moves.
 */
export function sessionTranscriptsRoot(userDataPath: string): string {
  return join(userDataPath, "session-transcripts");
}

/** Builds the stable ledger reference for already-verified canonical bytes. */
export function transcriptReferenceForId(id: string): TranscriptReference {
  if (!SHA_256_ID.test(id)) throw new Error("Transcript artifact id must be a SHA-256 digest");
  return referenceFor(id);
}

function referenceFor(digest: string): TranscriptReference {
  return { id: digest, digest, mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE };
}

function validateReference(reference: TranscriptReference): string {
  const match = SHA_256_ID.exec(reference.id);
  if (
    !match ||
    reference.digest !== reference.id ||
    reference.mediaType !== TRANSCRIPT_ARTIFACT_MEDIA_TYPE
  ) {
    throw new Error("Transcript artifact reference is invalid");
  }
  return reference.id;
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function decodeStoredBytes(stored: Buffer, form: "gzip" | "plain"): Promise<Buffer> {
  if (hasGzipMagic(stored)) {
    try {
      return await gunzipAsync(stored);
    } catch (error) {
      throw new Error("Transcript artifact gzip payload could not be inflated", { cause: error });
    }
  }
  if (form === "gzip") throw new Error("Transcript artifact compressed path is not gzip data");
  return stored;
}

function readAndVerifySync(path: string, expectedDigest: string, form: "gzip" | "plain"): Buffer {
  const info = lstatSync(path);
  if (!info.isFile()) throw new Error("Transcript artifact path is not a regular file");
  const stored = readFileSync(path);
  let bytes: Buffer;
  if (hasGzipMagic(stored)) {
    try {
      bytes = gunzipSync(stored);
    } catch (error) {
      throw new Error("Transcript artifact gzip payload could not be inflated", { cause: error });
    }
  } else {
    if (form === "gzip") throw new Error("Transcript artifact compressed path is not gzip data");
    bytes = stored;
  }
  if (digestBytes(bytes) !== expectedDigest) {
    throw new Error("Transcript artifact path contains bytes for another digest");
  }
  return bytes;
}

function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

function parseArtifact(bytes: Buffer, id: string): SessionTranscriptArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Transcript artifact ${id} is not valid JSON`);
  }
  assertArtifact(parsed);
  return parsed;
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function assertArtifact(value: unknown): asserts value is SessionTranscriptArtifact {
  if (!isRecord(value) || value.version !== 1)
    throw new Error("Transcript artifact has an invalid version");
  for (const key of ["threadId", "branchId", "attemptId"] as const) {
    if (typeof value[key] !== "string")
      throw new Error(`Transcript artifact has an invalid ${key}`);
  }
  if (value.turnId !== null && typeof value.turnId !== "string") {
    throw new Error("Transcript artifact has an invalid turnId");
  }
  if (
    !isRecord(value.message) ||
    typeof value.message.id !== "string" ||
    !Array.isArray(value.message.parts)
  ) {
    throw new Error("Transcript artifact has an invalid UI message");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
