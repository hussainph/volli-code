/** Disposable machine-local snapshot, independent of Session/attachment tables. */
import { constants } from "node:fs";
import { open, mkdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pinnedSourceIconIo } from "./directory-io";
import { isCanonicalSourceOrigin } from "@volli/shared";

const MAX_FILE = 24 * 1024 * 1024;
const MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_IMAGE = 64 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

export interface StoredSourceIcon {
  id: string;
  sessionId: string;
  /** Hash of the host's account/sign-in context, never a credential. */
  authority: string;
  origin: string;
  expiresAt: number;
  bytes: Uint8Array;
}

export interface SourceIconPersistence {
  load(): Promise<StoredSourceIcon[]>;
  save(entries: readonly StoredSourceIcon[]): void;
}

/** Fixed filename: a renderer string, URL or UUID can never name a file. */
export class SourceIconDisk implements SourceIconPersistence {
  private pending: readonly StoredSourceIcon[] | undefined;
  private flushing: Promise<void> | undefined;
  private directoryIdentity: { dev: number; ino: number } | undefined;
  private disabled = false;
  private io: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly root: string,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<StoredSourceIcon[]> {
    try {
      const buffer = await this.directoryIo();
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      const snapshot = parsed as Record<string, unknown>;
      if (
        snapshot.version !== 1 ||
        !Array.isArray(snapshot.entries) ||
        snapshot.entries.length > 256
      )
        return [];
      const entries: StoredSourceIcon[] = [];
      const ids = new Set<string>();
      const sources = new Set<string>();
      let total = 0;
      const now = this.now();
      for (const value of snapshot.entries as unknown[]) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        if (
          typeof row.id !== "string" ||
          !UUID.test(row.id) ||
          ids.has(row.id) ||
          typeof row.sessionId !== "string" ||
          row.sessionId.length === 0 ||
          row.sessionId.length > 256 ||
          typeof row.authority !== "string" ||
          !HASH.test(row.authority) ||
          typeof row.origin !== "string" ||
          !isCanonicalSourceOrigin(row.origin) ||
          typeof row.expiresAt !== "number" ||
          !Number.isFinite(row.expiresAt) ||
          row.expiresAt <= now ||
          row.expiresAt > now + MAX_AGE ||
          typeof row.data !== "string" ||
          row.data.length > Math.ceil(MAX_IMAGE / 3) * 4 ||
          typeof row.sha256 !== "string" ||
          !HASH.test(row.sha256)
        )
          continue;
        const bytes = Buffer.from(row.data, "base64");
        if (
          bytes.length < 33 ||
          bytes.length > MAX_IMAGE ||
          bytes.toString("base64") !== row.data ||
          createHash("sha256").update(bytes).digest("hex") !== row.sha256
        )
          continue;
        const key = JSON.stringify([row.authority, row.sessionId, row.origin]);
        if (sources.has(key) || total + bytes.length > MAX_PAYLOAD) continue;
        total += bytes.length;
        ids.add(row.id);
        sources.add(key);
        entries.push({
          id: row.id,
          sessionId: row.sessionId,
          authority: row.authority,
          origin: row.origin,
          expiresAt: row.expiresAt,
          bytes: Uint8Array.from(bytes),
        });
      }
      return entries;
    } catch {
      // Missing/torn/old/corrupt/linked caches are misses, never lost history.
      return [];
    }
  }

  save(entries: readonly StoredSourceIcon[]): void {
    // One writing generation and ONE latest generation. Repeated refinements
    // coalesce instead of retaining an unbounded filesystem-job queue.
    this.pending = entries.slice(0, 256);
    if (this.flushing !== undefined) return;
    this.flushing = new Promise<void>((resolve) => {
      // Encoding/writing decoration never runs inline in a successful read's
      // observer or a cache lookup. Only bounded references are queued here.
      setImmediate(() => {
        const finished = (): void => {
          this.flushing = undefined;
          // A save can land between the last loop test and this callback.
          if (this.pending !== undefined) this.save(this.pending);
          resolve();
        };
        void this.flush().then(finished, finished);
      });
    });
  }

  private async flush(): Promise<void> {
    while (this.pending !== undefined) {
      const entries = this.pending;
      this.pending = undefined;
      try {
        let payload = 0;
        const bounded = entries.filter((entry) => {
          if (
            !UUID.test(entry.id) ||
            !HASH.test(entry.authority) ||
            !isCanonicalSourceOrigin(entry.origin) ||
            entry.sessionId.length > 256 ||
            entry.bytes.byteLength < 33 ||
            entry.bytes.byteLength > MAX_IMAGE ||
            payload + entry.bytes.byteLength > MAX_PAYLOAD
          )
            return false;
          payload += entry.bytes.byteLength;
          return true;
        });
        const rows = bounded.map((entry) => ({
          id: entry.id,
          sessionId: entry.sessionId,
          authority: entry.authority,
          origin: entry.origin,
          expiresAt: entry.expiresAt,
          data: Buffer.from(entry.bytes).toString("base64"),
          sha256: createHash("sha256").update(entry.bytes).digest("hex"),
        }));
        const body = JSON.stringify({ version: 1, entries: rows });
        if (Buffer.byteLength(body) > MAX_FILE) continue;
        await this.directoryIo(body);
      } catch {
        try {
          this.log("A source icon cache snapshot could not be written");
        } catch {
          /* Optional diagnostics. */
        }
      }
    }
  }

  private directoryIo(body?: string): Promise<Buffer> {
    // Serializes reads/cleanup with the one coalesced writer. A cleanup can
    // never unlink another operation's staging file.
    const job = this.io.then(async () => {
      if (this.disabled) throw new Error("Source icon directory authority lost");
      // The parent (host.dataDir) is host-owned. Never recursively create or
      // follow the final cache directory, including during staging cleanup.
      try {
        await mkdir(this.root, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const directory = await open(
        this.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ).catch((error: unknown) => {
        this.disabled = true;
        throw error;
      });
      try {
        const pinned = await directory.stat();
        const sameDirectory = async (): Promise<boolean> => {
          try {
            const current = await lstat(this.root);
            return (
              current.isDirectory() &&
              !current.isSymbolicLink() &&
              current.dev === pinned.dev &&
              current.ino === pinned.ino
            );
          } catch {
            return false;
          }
        };
        if (
          !pinned.isDirectory() ||
          !(await sameDirectory()) ||
          (this.directoryIdentity !== undefined &&
            (this.directoryIdentity.dev !== pinned.dev ||
              this.directoryIdentity.ino !== pinned.ino))
        ) {
          this.disabled = true;
          throw new Error("Source icon directory replaced");
        }
        this.directoryIdentity ??= { dev: pinned.dev, ino: pinned.ino };
        // The child proves cwd === inherited fd before ANY access, and uses
        // only relative single-component names thereafter (also on Darwin).
        let bytes: Buffer;
        try {
          bytes = await pinnedSourceIconIo(this.root, directory, body);
        } catch (error) {
          if (!(await sameDirectory())) this.disabled = true;
          throw error;
        }
        if (!(await sameDirectory())) {
          this.disabled = true;
          throw new Error("Source icon directory replaced during I/O");
        }
        return bytes;
      } finally {
        await directory.close();
      }
    });
    this.io = job.catch(() => {});
    return job;
  }

  /** Joined by both host draining and desktop's existing accepted-quit deadline. */
  async settled(): Promise<void> {
    while (this.flushing !== undefined) await this.flushing;
    await this.io;
  }
}
