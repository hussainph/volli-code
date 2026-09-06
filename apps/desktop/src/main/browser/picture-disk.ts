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
 * Ids are the store's own UUIDs and nothing else becomes a file name; the
 * check here is a second lock on the same door, the way `blobRelPath` refuses
 * anything that is not a hash.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BrowserPictureMime, BrowserPicturePersistence } from "./picture-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXTENSION: Record<BrowserPictureMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** The pictures directory under a given Electron `userData` path. */
export function browserPicturesRoot(userDataPath: string): string {
  return join(userDataPath, "browser-pictures");
}

export function browserPictureDisk(root: string): BrowserPicturePersistence {
  return {
    write(id, bytes, mime) {
      if (!UUID.test(id)) throw new Error("Browser picture ids are UUIDs");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, `${id}.${EXTENSION[mime]}`), bytes);
    },
    read(id) {
      if (!UUID.test(id)) return null;
      for (const mime of Object.keys(EXTENSION) as BrowserPictureMime[]) {
        const path = join(root, `${id}.${EXTENSION[mime]}`);
        if (existsSync(path)) return { bytes: readFileSync(path), mime };
      }
      return null;
    },
  };
}
