/**
 * The one way bytes become an attachment (VC-50): hash them, write them to the
 * Blob store, record the `blobs` row, and link it to a Ticket or a Session —
 * in that order, so a link never names bytes that are not on disk yet.
 *
 * This is also where the size ceiling is enforced. Providers cap image input
 * (5 MB at Anthropic) and the failure is not a polite one: an oversized image
 * that has already entered durable history replays on every later turn, so the
 * session stops accepting even plain text — the failure mode behind a long run
 * of Claude Code bug reports. Refusing at import means the bad bytes never
 * reach history at all, which is the only place the check is cheap.
 *
 * Non-inlinable types are not capped here — documents, and image types no
 * provider takes as input (SVG, HEIC): they are never inlined as model input,
 * only materialized and referenced by path, so their size is a disk question
 * rather than a protocol one.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import { MAX_INLINE_IMAGE_BYTES, isInlinableImageMime, type BlobLink } from "@volli/shared";
import { blobExists, hashBytes, writeBlob } from "./blob-store";
import { createBlobLink, upsertBlob, type CreateBlobLinkInput } from "./db/blobs-repo";

/**
 * Extension → media type for the kinds a user actually attaches. Deliberately
 * a short explicit table rather than a mime database dependency: the only
 * consequence of a miss is `application/octet-stream`, which still materializes
 * and still renders as a chip — it merely never inlines as an image, which is
 * the correct answer for a type we do not recognise.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

/** The media type a file name implies, or `application/octet-stream` when unrecognised. */
export function mimeForFileName(fileName: string): string {
  return MIME_BY_EXTENSION[extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

export interface ImportBlobInput {
  /** The basename to remember; never a path. */
  fileName: string;
  bytes: Uint8Array;
  /** Overrides the extension-derived media type when the source knew better (a paste, a drop). */
  mime?: string;
  label?: string;
  owner: { ticketId: string } | { sessionId: string };
}

/**
 * Imports bytes and links them. Returns the new link — the caller needs its id
 * to render the attachment and, later, to remove it.
 *
 * Throws when an image exceeds {@link MAX_INLINE_IMAGE_BYTES}, naming the size,
 * so the surface can toast something a person can act on rather than a provider
 * error arriving a turn later.
 */
export function importBlob(
  db: Database.Database,
  blobsRootPath: string,
  input: ImportBlobInput,
  now: number,
): BlobLink {
  const hash = importOwnerless(
    db,
    blobsRootPath,
    input.fileName,
    input.bytes,
    input.mime ?? mimeForFileName(basename(input.fileName)),
    now,
  );
  const link: CreateBlobLinkInput =
    "ticketId" in input.owner
      ? { blobHash: hash, label: input.label, ticketId: input.owner.ticketId }
      : { blobHash: hash, label: input.label, sessionId: input.owner.sessionId };
  return createBlobLink(db, link, now);
}

/**
 * The ingest half of {@link importBlob}, stopping short of the link: enforce
 * the ceiling, write the bytes, record the row, return the hash.
 *
 * Split out for the one caller that has nowhere to link yet — the new-Ticket
 * composer, whose Ticket does not exist until submit. Splitting rather than
 * duplicating is the point: the size ceiling and the bytes-before-row ordering
 * are the two things this module exists to guarantee, and a second ingest path
 * that forgot either would be the bug this design is written against.
 *
 * The Blob it leaves behind has no link, which is a legitimate resting state
 * (an abandoned draft) and is what collection reclaims.
 */
export function importOwnerless(
  db: Database.Database,
  blobsRootPath: string,
  rawFileName: string,
  bytes: Uint8Array,
  mime: string,
  now: number,
): string {
  const fileName = basename(rawFileName);
  if (isInlinableImageMime(mime) && bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    const mb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
    throw new Error(`"${fileName}" is ${mb} MB — images must be under 5 MB to send to a model.`);
  }
  // Bytes first: a `blobs` row for a file the store does not have would make
  // every later materialize fail with a missing-source error instead of here.
  const hash = writeBlob(blobsRootPath, bytes);
  upsertBlob(db, {
    hash,
    mime,
    sizeBytes: bytes.byteLength,
    originalName: fileName,
    // Dimensions are not measured yet; NULL means "unknown", never zero.
    width: null,
    height: null,
    createdAt: now,
  });
  return hash;
}

/** {@link importBlob} for a file already on disk — the native file picker's path. */
export async function importBlobFromPath(
  db: Database.Database,
  blobsRootPath: string,
  sourcePath: string,
  owner: ImportBlobInput["owner"],
  now: number,
  label?: string,
): Promise<BlobLink> {
  const bytes = await readFile(sourcePath);
  return importBlob(
    db,
    blobsRootPath,
    { fileName: basename(sourcePath), bytes, label, owner },
    now,
  );
}

/** Whether a Blob's bytes are present — the precondition every materialize and every send assumes. */
export function blobBytesPresent(blobsRootPath: string, hash: string): boolean {
  return blobExists(blobsRootPath, hash);
}

/** Re-exported so callers that only need the hash of some bytes do not reach past this module. */
export { hashBytes };
