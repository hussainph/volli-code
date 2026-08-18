/**
 * Reclaiming Blobs nothing points at any more (VC-50).
 *
 * A Blob deliberately outlives its last link — `deleteBlobLink` never touches
 * bytes — so that detaching is instant and reversible-feeling, and so that two
 * surfaces sharing one Blob can never have one of them pull the file out from
 * under the other. That leaves a real class of garbage this module collects:
 *
 *  - an attachment removed from a Ticket or a chat,
 *  - a new-Ticket composer draft that was abandoned before the Ticket existed,
 *    which is the common case now that attaching imports eagerly,
 *  - links that vanished with a cascade when their Ticket or Session was
 *    deleted.
 *
 * Run at startup rather than as a cascade off the last unlink: collection is
 * housekeeping, and doing it inline would make an ordinary detach do file I/O
 * on the user's turn.
 */
import type Database from "better-sqlite3";
import { deleteBlob, listUnlinkedBlobHashes } from "./db/blobs-repo";
import { removeBlob } from "./blob-store";

export interface BlobCollectionReport {
  /** Hashes whose bytes and row were both dropped. */
  collected: string[];
}

/**
 * Removes every Blob no link names.
 *
 * Bytes go first, then the row. Getting cut off between the two is survivable
 * in that order and not in the other: a row whose bytes are gone is
 * self-healing, because nothing links it (that is why it was collected) and a
 * later import of identical content rewrites the file and finds the row already
 * correct. A row dropped while its file survived would instead leave a byte
 * blob no query can ever name again — a permanent leak, invisible to the next
 * collection.
 */
export function collectUnlinkedBlobs(
  db: Database.Database,
  blobsRootPath: string,
): BlobCollectionReport {
  const collected: string[] = [];
  for (const hash of listUnlinkedBlobHashes(db)) {
    removeBlob(blobsRootPath, hash);
    deleteBlob(db, hash);
    collected.push(hash);
  }
  return { collected };
}
