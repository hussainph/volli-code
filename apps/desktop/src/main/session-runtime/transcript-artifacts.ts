import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalJson,
  TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  type SessionTranscriptArtifact,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import type { TranscriptReference } from "@volli/shared";

const SHA_256_ID = /^sha256:([a-f0-9]{64})$/;

/**
 * A content-addressed, append-only store for durable transcript artifacts.
 *
 * The ledger is allowed to reference a returned artifact only after this store
 * has synced its bytes and atomically made them visible at their digest path.
 * Artifact names are derived solely from validated SHA-256 digests, so callers
 * never influence filesystem paths.
 */
export class FileTranscriptArtifactStore implements TranscriptArtifactStore {
  #ready: Promise<void> | undefined;

  constructor(private readonly baseDirectory: string) {}

  async write(artifact: SessionTranscriptArtifact): Promise<TranscriptReference> {
    assertArtifact(artifact);
    await this.ensureDirectory();

    const bytes = Buffer.from(canonicalJson(artifact), "utf8");
    const digest = digestBytes(bytes);
    const reference = referenceFor(digest);
    const destination = this.pathFor(reference.id);

    try {
      await this.verifyExisting(destination, digest);
      return reference;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const temporary = join(
      this.baseDirectory,
      `.${digest.slice("sha256:".length)}.${randomBytes(16).toString("hex")}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;

      // link is an atomic no-replace publish. If another writer won the race,
      // its bytes must independently verify at the same digest path.
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

    await this.verifyExisting(destination, digest);
    return reference;
  }

  async read(reference: TranscriptReference): Promise<SessionTranscriptArtifact> {
    const digest = validateReference(reference);
    const path = this.pathFor(reference.id);
    const info = await lstat(path);
    if (!info.isFile())
      throw new Error(`Transcript artifact ${reference.id} is not a regular file`);
    const bytes = await readFile(path);
    if (digestBytes(bytes) !== digest) {
      throw new Error(`Transcript artifact ${reference.id} failed checksum verification`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`Transcript artifact ${reference.id} is not valid JSON`);
    }
    assertArtifact(parsed);
    return parsed;
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

  private pathFor(id: string): string {
    const match = SHA_256_ID.exec(id);
    if (!match) throw new Error("Transcript artifact reference must be a SHA-256 digest");
    return join(this.baseDirectory, `${match[1]}.json`);
  }

  private async verifyExisting(path: string, expectedDigest: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error("Transcript artifact path is not a regular file");
    const bytes = await readFile(path);
    if (digestBytes(bytes) !== expectedDigest) {
      throw new Error("Transcript artifact path contains bytes for another digest");
    }
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

export function createFileTranscriptArtifactStore(baseDirectory: string): TranscriptArtifactStore {
  return new FileTranscriptArtifactStore(baseDirectory);
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
