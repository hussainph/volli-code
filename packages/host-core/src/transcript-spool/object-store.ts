/**
 * Where a runner puts Session-history objects (transcript packs, spilled
 * bodies, Pi log ranges): the object-storage port and its two adapters.
 *
 * - {@link PresignedObjectStore} uploads to an S3-compatible store (R2) with
 *   a URL the backend signed for exactly that key, length and SHA-256
 *   (`files.presignPut`). The store refuses any other bytes.
 * - {@link LocalObjectStore} writes the same keys under a directory, laid out
 *   exactly like the bucket (`<root>/v1/p/<projectId>/s/<sessionId>/tx/…`), for
 *   a deployment with no object store yet and for tests.
 *
 * Objects are write-once once committed: the backend never signs an upload
 * to a key a committed row names. Before that, a put may replace an
 * uncommitted object at its key (a retry after a crash). What is recorded is
 * decided by the commit that follows the put, never by the put.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SessionClaimFence, SessionUploadGrant } from "@volli/shared/cloud";

/** One object: its key (from the shared key grammar), its bytes and their SHA-256 hex. */
export interface SessionObject {
  key: string;
  body: Uint8Array;
  sha256: string;
}

/** Whose upload this is: the Session and the claim its producer holds. */
export interface SessionObjectScope {
  sessionId: string;
  claim: SessionClaimFence;
}

export interface SessionObjectStore {
  put(object: SessionObject, scope: SessionObjectScope): Promise<void>;
}

/** An upload the store refused. `retriable` for a transient answer (429, 5xx). */
export class ObjectUploadError extends Error {
  readonly status: number;
  readonly retriable: boolean;
  constructor(key: string, status: number) {
    super(`Upload of ${key} was refused (${status})`);
    this.name = "ObjectUploadError";
    this.status = status;
    this.retriable = status === 429 || status >= 500;
  }
}

function assertSha(object: SessionObject): void {
  if (createHash("sha256").update(object.body).digest("hex") !== object.sha256) {
    throw new Error(`Object ${object.key} does not hash to its sha256`);
  }
}

const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** The key's path segments, or a throw for anything the key grammar cannot produce. */
function keySegments(key: string): string[] {
  const segments = key.split("/");
  if (
    segments[0] !== "v1" ||
    segments.length < 2 ||
    !segments.every((segment) => KEY_SEGMENT.test(segment) && !segment.includes(".."))
  ) {
    throw new Error(`Not an object key: ${JSON.stringify(key)}`);
  }
  return segments;
}

/** Objects as files under `root`, one per key, laid out as the bucket is. */
export class LocalObjectStore implements SessionObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /** The file a key is stored at. */
  pathOf(key: string): string {
    return join(this.#root, ...keySegments(key));
  }

  async put(object: SessionObject): Promise<void> {
    assertSha(object);
    const path = this.pathOf(object.key);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${randomBytes(16).toString("hex")}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(object.body);
        // One object per pack: a sync here is per turn, not per message.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
}

/** Asks the backend to sign one upload (`files.presignPut`). */
export type PresignPut = (request: {
  sessionId: string;
  claim: SessionClaimFence;
  key: string;
  bytes: number;
  sha256: string;
}) => Promise<SessionUploadGrant>;

/** One upload's longest wait: a 64 MB object over a slow link, not a hung socket. */
export const OBJECT_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export interface PresignedObjectStoreOptions {
  presignPut: PresignPut;
  fetch?: typeof globalThis.fetch;
  /** Abort an upload after this long (default {@link OBJECT_UPLOAD_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/** Uploads to an S3-compatible store through URLs the backend signs per object. */
export class PresignedObjectStore implements SessionObjectStore {
  readonly #presignPut: PresignPut;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: PresignedObjectStoreOptions) {
    this.#presignPut = options.presignPut;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? OBJECT_UPLOAD_TIMEOUT_MS;
  }

  async put(object: SessionObject, scope: SessionObjectScope): Promise<void> {
    assertSha(object);
    const grant = await this.#presignPut({
      sessionId: scope.sessionId,
      claim: scope.claim,
      key: object.key,
      bytes: object.body.length,
      sha256: object.sha256,
    });
    // A committed row names this key: its object is in place and immutable.
    // The commit that follows decides whether these bytes are the same.
    if (grant.status === "committed") return;
    const signed = grant.request;
    const response = await this.#fetch(signed.url, {
      method: "PUT",
      headers: signed.headers,
      signal: AbortSignal.timeout(this.#timeoutMs),
      // A view of exactly the object's bytes, typed as `fetch` takes them.
      body: new Uint8Array(
        object.body.buffer as ArrayBuffer,
        object.body.byteOffset,
        object.body.length,
      ),
    });
    // Drain the body so the connection can be reused.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) throw new ObjectUploadError(object.key, response.status);
  }
}
