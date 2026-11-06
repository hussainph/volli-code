/**
 * The disk half of {@link BrowserPictureStore}'s persistence (VC-238): the
 * screenshots a model asked for, kept under Electron `userData` so a card in
 * a reopened chat can still show the picture the transcript names.
 *
 * Deliberately NOT the Blob store. A `blob_links` row on a Session is a chat
 * attachment: it is materialized into the worktree's `.volli/attachments` and
 * counted as inline image input on the next turn, which would hand every
 * screenshot the agent took straight back to the model. These pictures are the
 * person's evidence, not the model's input, so they live in their own
 * directory with no database row and no materialization.
 *
 * Each picture is two files: `<id>.<ext>` for the bytes and `<id>.json` for
 * the record that says what it is — which tab, which Session, and when. The
 * directory is therefore self-describing, which is what lets a new store
 * instance rehydrate after a relaunch and sweep what is past its bound. No
 * database row, because these outlive no Session and reference nothing: a
 * table would be a second thing to keep in step with a directory.
 *
 * Ids are the store's own UUIDs and nothing else becomes a file name; the
 * check here is a second lock on the same door, the way `blobRelPath` refuses
 * anything that is not a hash.
 *
 * Writes and removals leave the caller's turn (VC-1082). This runs on
 * Electron main beside every Session's agent loop, so the files are written
 * through `fs.promises`, in order per picture ({@link diskQueue}); until a
 * picture's write lands, its bytes answer every read from memory, so nothing
 * a caller can observe depends on when the disk caught up. A write still in
 * flight when the process dies is lost the way a crash mid-write always lost
 * it — the record is written last, so a picture is never listed without its
 * bytes — and an orderly quit waits for them ({@link BrowserPictureDisk.settled}).
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hostLogger } from "../log/root";

import {
  BROWSER_PICTURE_CHUNK_BYTES,
  type BrowserPictureMime,
  type BrowserPicturePersistence,
  type BrowserPictureRecord,
} from "./picture-store";

/** The only shape a file name here may take; shared with the trace disk, which is the same door. */
export const BROWSER_FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = BROWSER_FILE_ID;

const EXTENSION: Record<BrowserPictureMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

const log = hostLogger("browser");

/**
 * Disk work run off the caller's turn: in submission order for each file (a
 * removal never overtakes the write before it), any order across files. A
 * failure is logged and ends that one job, never the queue: no person waits on
 * these writes, and the bytes are still answered from memory until they land.
 */
export interface DiskQueue {
  run(key: string, work: () => Promise<void>, settle?: () => void): void;
  /** Resolves once every job queued so far, and any they queued, has finished. */
  settled(): Promise<void>;
}

export function diskQueue(what: string): DiskQueue {
  const tails = new Map<string, Promise<void>>();
  return {
    run(key, work, settle) {
      const tail = (tails.get(key) ?? Promise.resolve())
        .then(work)
        .catch((error: unknown) => {
          log.warn(`${what} could not be written to disk`, {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          settle?.();
          if (tails.get(key) === tail) tails.delete(key);
        });
      tails.set(key, tail);
    },
    async settled() {
      while (tails.size > 0) await Promise.all(tails.values());
    },
  };
}

/** A picture sink on disk, with the wait an orderly quit gives its writes. */
export interface BrowserPictureDisk extends BrowserPicturePersistence {
  /** Resolves once every write and removal asked of it so far is on disk. */
  settled(): Promise<void>;
}

/** The pictures directory under a given Electron `userData` path. */
export function browserPicturesRoot(userDataPath: string): string {
  return join(userDataPath, "browser-pictures");
}

/**
 * A record as it stands on disk. Total and validating, like every other read
 * of bytes this app did not write in this process: a sidecar a half-finished
 * write left behind is skipped, never a boot failure.
 */
function readRecord(root: string, name: string): BrowserPictureRecord | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(root, name), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const mime = record["mime"];
    if (
      typeof record["id"] !== "string" ||
      !UUID.test(record["id"]) ||
      typeof record["tabId"] !== "string" ||
      typeof record["generation"] !== "number" ||
      typeof record["capturedAt"] !== "number" ||
      typeof mime !== "string" ||
      !Object.hasOwn(EXTENSION, mime)
    ) {
      return null;
    }
    const owner = record["ownerSessionId"];
    return {
      id: record["id"],
      tabId: record["tabId"],
      generation: record["generation"],
      capturedAt: record["capturedAt"],
      ownerSessionId: typeof owner === "string" ? owner : null,
      mime: mime as BrowserPictureMime,
    };
  } catch {
    return null;
  }
}

export function browserPictureDisk(root: string): BrowserPictureDisk {
  const queue = diskQueue("A browser picture");
  /** Pictures whose write has not landed yet: every read answers them from here. */
  const pending = new Map<string, { bytes: Uint8Array; record: BrowserPictureRecord }>();
  /** Pictures whose removal has not landed yet: no read or listing answers them. */
  const removing = new Set<string>();
  return {
    write(bytes, record) {
      if (!UUID.test(record.id)) throw new Error("Browser picture ids are UUIDs");
      const entry = { bytes, record };
      pending.set(record.id, entry);
      // Written again after a removal: the queue lands the removal first.
      removing.delete(record.id);
      queue.run(
        record.id,
        async () => {
          // A removal queued meanwhile already won; nothing to write.
          if (pending.get(record.id) !== entry) return;
          await mkdir(root, { recursive: true });
          await writeFile(join(root, `${record.id}.${EXTENSION[record.mime]}`), bytes);
          // The record last: a listed picture always has its bytes beside it.
          await writeFile(join(root, `${record.id}.json`), JSON.stringify(record));
        },
        () => {
          if (pending.get(record.id) === entry) pending.delete(record.id);
        },
      );
    },
    read(id) {
      if (!UUID.test(id) || removing.has(id)) return null;
      const held = pending.get(id);
      if (held !== undefined) return { bytes: held.bytes, mime: held.record.mime };
      for (const mime of Object.keys(EXTENSION) as BrowserPictureMime[]) {
        const path = join(root, `${id}.${EXTENSION[mime]}`);
        if (existsSync(path)) return { bytes: readFileSync(path), mime };
      }
      return null;
    },
    readChunk(id, offset) {
      if (
        !UUID.test(id) ||
        removing.has(id) ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset % 3 !== 0
      )
        return null;
      const held = pending.get(id)?.bytes;
      if (held !== undefined) {
        if (offset >= held.length) return null;
        return {
          bytes: held.subarray(offset, offset + BROWSER_PICTURE_CHUNK_BYTES),
          byteLength: held.length,
        };
      }
      for (const mime of Object.keys(EXTENSION) as BrowserPictureMime[]) {
        let fd: number | undefined;
        try {
          // Validate the opened inode, not a path checked before open; never follow a
          // leaf symlink or block the host on a FIFO/device in the pictures directory.
          fd = openSync(
            join(root, `${id}.${EXTENSION[mime]}`),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          const stat = fstatSync(fd);
          if (!stat.isFile() || offset >= stat.size) return null;
          const bytes = Buffer.alloc(Math.min(BROWSER_PICTURE_CHUNK_BYTES, stat.size - offset));
          let filled = 0;
          while (filled < bytes.length) {
            const count = readSync(fd, bytes, filled, bytes.length - filled, offset + filled);
            // A concurrent truncation is unavailable, never padded/corrupt image data.
            if (count === 0) return null;
            filled += count;
          }
          return { bytes, byteLength: stat.size };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      }
      return null;
    },
    list() {
      const records: BrowserPictureRecord[] = [];
      if (existsSync(root)) {
        for (const name of readdirSync(root)) {
          if (!name.endsWith(".json")) continue;
          const record = readRecord(root, name);
          if (record !== null && !pending.has(record.id) && !removing.has(record.id))
            records.push(record);
        }
      }
      for (const { record } of pending.values()) records.push(record);
      return records;
    },
    remove(id) {
      if (!UUID.test(id)) return;
      pending.delete(id);
      removing.add(id);
      queue.run(
        id,
        async () => {
          // The record first, as it was written last: a half-removed picture is
          // never listed.
          await rm(join(root, `${id}.json`), { force: true });
          for (const mime of Object.keys(EXTENSION) as BrowserPictureMime[]) {
            await rm(join(root, `${id}.${EXTENSION[mime]}`), { force: true });
          }
        },
        () => removing.delete(id),
      );
    },
    settled: () => queue.settled(),
  };
}
