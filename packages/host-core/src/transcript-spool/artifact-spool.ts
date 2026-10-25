/**
 * The runner-local transcript spool: where a cloud Session's message bodies
 * wait on this machine until a committed transcript pack holds them.
 *
 * It answers the same port as the signed-out file store
 * (`TranscriptArtifactStore`: content-addressed, `sha256:<hex>` over the
 * canonical JSON), but makes the durability trade the ledger already makes.
 * The signed-out store syncs every body (a full device flush on macOS) before
 * `write` returns, so each message paid for a flush on the turn's critical
 * path. Here a body is durable to the ledger's own standard: `write` returns
 * once the bytes are in place and verified, and {@link SpoolTranscriptArtifactStore.flush}
 * syncs everything written since the last flush in one pass, off the critical
 * path (the transcript spool calls it before each pack). Permanent durability
 * is the pack's: once a committed segment holds a body, object storage has it.
 *
 * What that allows, and how each case reads:
 * - A process crash loses nothing: the bytes are in the page cache.
 * - A power loss can lose the bodies written since the last flush, exactly as
 *   it can lose the ledger's last unsynced commits (SQLite WAL with
 *   `synchronous = NORMAL`). A lost or torn body reads as unreadable, never as
 *   other bytes: every read verifies the digest. The pack then names it
 *   `missing`, and the backend's staged copy (sent before the event was
 *   accepted) stays the place to read it.
 * - A torn file never blocks its digest: a later write of the same body
 *   replaces whatever fails verification, atomically (temp file + rename).
 *
 * Files are `<hex>.spool`: a 4-byte magic, the canonical length (u32 BE), then
 * the zstd-compressed canonical bytes. Reads open the path once (`O_NOFOLLOW`,
 * `O_NONBLOCK`) and ask every later question of that descriptor.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdCompress, zstdDecompress, constants as zlib } from "node:zlib";

import {
  canonicalJson,
  TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  type SessionTranscriptArtifact,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import type { TranscriptReference } from "@volli/shared";

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

const MAGIC = Buffer.from("VSP1", "latin1");
const HEADER_BYTES = 8;
const SHA_256_ID = /^sha256:([a-f0-9]{64})$/;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** zstd level 3, as every Session-history object is compressed. */
export const SESSION_HISTORY_ZSTD = { params: { [zlib.ZSTD_c_compressionLevel]: 3 } };

/** Why a body could not be read. `missing`: no file. `corrupt`: a file whose bytes do not verify. */
export class SpooledArtifactUnreadableError extends Error {
  readonly reason: "missing" | "corrupt";
  constructor(id: string, reason: "missing" | "corrupt", options?: ErrorOptions) {
    super(`Transcript artifact ${id} is ${reason} in the spool`, options);
    this.name = "SpooledArtifactUnreadableError";
    this.reason = reason;
  }
}

export class SpoolTranscriptArtifactStore implements TranscriptArtifactStore {
  readonly #directory: string;
  #ready: Promise<void> | undefined;
  /** Paths written since the last flush began. */
  #unsynced = new Set<string>();

  constructor(directory: string) {
    this.#directory = directory;
  }

  async write(artifact: SessionTranscriptArtifact): Promise<TranscriptReference> {
    assertArtifact(artifact);
    const bytes = Buffer.from(canonicalJson(artifact), "utf8");
    const id = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const reference: TranscriptReference = {
      id,
      digest: id,
      mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
    };
    const path = this.#pathFor(reference);
    if (await this.#holds(path, id)) return reference;
    await this.#ensureDirectory();
    const stored = Buffer.concat([
      header(bytes.length),
      await compress(bytes, SESSION_HISTORY_ZSTD),
    ]);
    const temporary = join(this.#directory, `.${randomBytes(16).toString("hex")}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(stored);
      } finally {
        await handle.close();
      }
      // Replaces a torn or foreign file at the name; never a verified one (checked above).
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    this.#unsynced.add(path);
    // Read back what landed: the reference is returned only for verified bytes.
    await this.#readVerified(path, id);
    return reference;
  }

  async read(reference: TranscriptReference): Promise<SessionTranscriptArtifact> {
    const bytes = await this.readCanonicalBytes(reference);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
      assertArtifact(value);
    } catch (error) {
      throw new SpooledArtifactUnreadableError(reference.id, "corrupt", { cause: error });
    }
    return value;
  }

  /** The verified canonical bytes; {@link SpooledArtifactUnreadableError} when missing or corrupt. */
  async readCanonicalBytes(reference: TranscriptReference): Promise<Buffer> {
    return this.#readVerified(this.#pathFor(reference), reference.id);
  }

  /** The canonical size from the file's header, never its body. `null` when unreadable. */
  async byteLength(reference: TranscriptReference): Promise<number | null> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.#pathFor(reference), READ_FLAGS);
      if (!(await handle.stat()).isFile()) return null;
      const head = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(head, 0, HEADER_BYTES, 0);
      if (bytesRead !== HEADER_BYTES || !head.subarray(0, 4).equals(MAGIC)) return null;
      return head.readUInt32BE(4);
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * Make every body written before this call durable: one sync per file
   * written since the last flush, then one of the directory. A failure keeps
   * those files queued for the next flush and rejects.
   */
  async flush(): Promise<void> {
    const paths = [...this.#unsynced];
    if (paths.length === 0) return;
    this.#unsynced = new Set();
    try {
      for (const path of paths) {
        const handle = await open(path, "r").catch((error: unknown) => {
          // Replaced or removed since: whatever is there now was queued again.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (handle === null) continue;
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      const directory = await open(this.#directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      for (const path of paths) this.#unsynced.add(path);
      throw error;
    }
  }

  #pathFor(reference: TranscriptReference): string {
    const match = SHA_256_ID.exec(reference.id);
    if (
      !match ||
      reference.digest !== reference.id ||
      reference.mediaType !== TRANSCRIPT_ARTIFACT_MEDIA_TYPE
    ) {
      throw new Error("Transcript artifact reference is invalid");
    }
    return join(this.#directory, `${match[1]}.spool`);
  }

  async #ensureDirectory(): Promise<void> {
    const ready = (this.#ready ??= mkdir(this.#directory, { recursive: true, mode: 0o700 }).then(
      () => undefined,
    ));
    try {
      await ready;
    } catch (error) {
      if (this.#ready === ready) this.#ready = undefined;
      throw error;
    }
  }

  async #holds(path: string, id: string): Promise<boolean> {
    try {
      await this.#readVerified(path, id);
      return true;
    } catch (error) {
      if (error instanceof SpooledArtifactUnreadableError) return false;
      throw error;
    }
  }

  async #readVerified(path: string, id: string): Promise<Buffer> {
    let stored: Buffer;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, READ_FLAGS);
      if (!(await handle.stat()).isFile()) throw new SpooledArtifactUnreadableError(id, "corrupt");
      stored = await handle.readFile();
    } catch (error) {
      if (error instanceof SpooledArtifactUnreadableError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new SpooledArtifactUnreadableError(id, "missing");
      // A symlink at the name is refused, never followed.
      if (code === "ELOOP")
        throw new SpooledArtifactUnreadableError(id, "corrupt", { cause: error });
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    if (stored.length < HEADER_BYTES || !stored.subarray(0, 4).equals(MAGIC)) {
      throw new SpooledArtifactUnreadableError(id, "corrupt");
    }
    let bytes: Buffer;
    try {
      bytes = await decompress(stored.subarray(HEADER_BYTES));
    } catch (error) {
      throw new SpooledArtifactUnreadableError(id, "corrupt", { cause: error });
    }
    if (
      bytes.length !== stored.readUInt32BE(4) ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== id
    ) {
      throw new SpooledArtifactUnreadableError(id, "corrupt");
    }
    return bytes;
  }
}

function header(length: number): Buffer {
  const head = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(head, 0);
  head.writeUInt32BE(length, 4);
  return head;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The artifact shape every transcript store accepts (the signed-out store checks the same). */
function assertArtifact(value: unknown): asserts value is SessionTranscriptArtifact {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Transcript artifact has an invalid version");
  }
  for (const key of ["threadId", "branchId", "attemptId"] as const) {
    if (typeof value[key] !== "string")
      throw new Error(`Transcript artifact has an invalid ${key}`);
  }
  if (value.turnId !== null && typeof value.turnId !== "string") {
    throw new Error("Transcript artifact has an invalid turnId");
  }
  const message = value.message;
  if (!isRecord(message) || typeof message.id !== "string" || !Array.isArray(message.parts)) {
    throw new Error("Transcript artifact has an invalid UI message");
  }
}
