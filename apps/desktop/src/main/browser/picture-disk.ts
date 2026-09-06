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
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  BrowserPictureMime,
  BrowserPicturePersistence,
  BrowserPictureRecord,
} from "./picture-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXTENSION: Record<BrowserPictureMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

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
      (mime !== "image/jpeg" && mime !== "image/png")
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
      mime,
    };
  } catch {
    return null;
  }
}

export function browserPictureDisk(root: string): BrowserPicturePersistence {
  return {
    write(bytes, record) {
      if (!UUID.test(record.id)) throw new Error("Browser picture ids are UUIDs");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, `${record.id}.${EXTENSION[record.mime]}`), bytes);
      writeFileSync(join(root, `${record.id}.json`), JSON.stringify(record));
    },
    read(id) {
      if (!UUID.test(id)) return null;
      for (const mime of Object.keys(EXTENSION) as BrowserPictureMime[]) {
        const path = join(root, `${id}.${EXTENSION[mime]}`);
        if (existsSync(path)) return { bytes: readFileSync(path), mime };
      }
      return null;
    },
    list() {
      if (!existsSync(root)) return [];
      const records: BrowserPictureRecord[] = [];
      for (const name of readdirSync(root)) {
        if (!name.endsWith(".json")) continue;
        const record = readRecord(root, name);
        if (record !== null) records.push(record);
      }
      return records;
    },
    remove(id) {
      if (!UUID.test(id)) return;
      rmSync(join(root, `${id}.json`), { force: true });
      for (const mime of Object.keys(EXTENSION) as BrowserPictureMime[]) {
        rmSync(join(root, `${id}.${EXTENSION[mime]}`), { force: true });
      }
    },
  };
}
