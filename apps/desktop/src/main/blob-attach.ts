/**
 * The attach gesture, end to end (VC-50, `docs/plans/attachments.md`).
 *
 * One entry point behind every way a file can arrive — the native picker, a
 * drop, a paste — because the interesting decision is the same in all three and
 * must not be made three times: does this file already live in the project, and
 * can it therefore be named live with `@path` instead of frozen into a
 * snapshot?
 *
 * `blob-import.ts` remains the only thing that writes bytes. This module sits
 * above it and decides whether bytes should be written at all.
 */
import { isAbsolute, relative, sep } from "node:path";
import { readFile } from "node:fs/promises";
import type Database from "better-sqlite3";
import {
  type BlobLinkView,
  isImageMime,
  resolveAttachment,
  fitsSessionImageBudget,
  MAX_SESSION_INLINE_IMAGE_BYTES,
} from "@volli/shared";
import { importBlob, importOwnerless, mimeForFileName } from "./blob-import";
import { getBlob, listSessionLinks } from "./db/blobs-repo";

/**
 * Where a file sits relative to the workspace an `@` ref will be resolved
 * against, or `null` when it has no nameable place there.
 *
 * `null` covers three genuinely different situations that all reduce to the
 * same answer: no root was supplied, the file is not on disk at all (a
 * clipboard paste), or it lies outside the root. The escape check is on the
 * computed relative path rather than on prefixes, so `/repo-evil` is not
 * mistaken for a child of `/repo`.
 */
export function workspaceRelPath(
  refRoot: string | undefined,
  sourcePath: string | undefined,
): string | null {
  if (refRoot === undefined || sourcePath === undefined) return null;
  if (!isAbsolute(refRoot) || !isAbsolute(sourcePath)) return null;
  const rel = relative(refRoot, sourcePath);
  if (rel.length === 0) return null;
  // `..` at the head is the only way out of the root, and an absolute result
  // means the two paths share no base at all.
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

/** Who the resulting link should hang off, or nothing yet (a Ticket still being composed). */
export type AttachOwner = { ticketId: string } | { sessionId: string } | { unowned: true };

export interface AttachRequest {
  /** The basename to remember. Never a path. */
  fileName: string;
  /** Bytes the renderer already holds (a paste, or a drop it has read). */
  bytes?: Uint8Array;
  /** Absolute path when the file is on disk — the only thing that can make this a repo ref. */
  sourcePath?: string;
  mime?: string;
  label?: string;
  /** Absolute workspace root an `@` ref would resolve against. */
  refRoot?: string;
  owner: AttachOwner;
}

/**
 * What the attach produced. A repository document becomes a ref and no bytes; a
 * foreign file becomes a snapshot; a repository image becomes both, so the
 * agent edits the real file while the model still sees the pixels.
 */
export type AttachOutcome =
  | { kind: "ref"; relPath: string }
  | { kind: "blob"; blob: BlobLinkView }
  | { kind: "ref-and-blob"; relPath: string; blob: BlobLinkView };

/** Bytes already inlined by a Session's image links — what the budget is measured against. */
export function sessionInlineImageBytes(db: Database.Database, sessionId: string): number {
  let total = 0;
  for (const link of listSessionLinks(db, sessionId)) {
    const blob = getBlob(db, link.blobHash);
    if (blob && isImageMime(blob.mime)) total += blob.sizeBytes;
  }
  return total;
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Holds one Session to its cumulative image budget.
 *
 * Only Sessions are budgeted, and only images count. A Ticket's attachments are
 * spec material read once from disk; a Session's images are inlined into a
 * conversation that Pi replays from its sidecar on every attach, so their cost
 * recurs for the life of the Session. That recurrence is the whole reason the
 * budget exists (`docs/plans/attachments.md`), and it is what a Ticket does not
 * have.
 */
function assertFitsSessionBudget(
  db: Database.Database,
  request: AttachRequest,
  bytes: Uint8Array,
  mime: string,
): void {
  const owner = request.owner;
  if (!("sessionId" in owner)) return;
  if (!isImageMime(mime)) return;
  const used = sessionInlineImageBytes(db, owner.sessionId);
  if (fitsSessionImageBudget(used, bytes.byteLength)) return;
  throw new Error(
    `This chat is already holding ${megabytes(used)} MB of images, and "${request.fileName}" ` +
      `would push it past the ${megabytes(MAX_SESSION_INLINE_IMAGE_BYTES)} MB a single chat ` +
      `can carry. Remove an earlier image, or start a new chat.`,
  );
}

/**
 * Performs one attach.
 *
 * Throws with a sentence a person can act on, because every refusal here is
 * something they can fix while the file is still in their hand: too big, or a
 * Session that has already inlined as much as it can carry.
 */
export async function attachBlob(
  db: Database.Database,
  blobsRootPath: string,
  request: AttachRequest,
  now: number,
): Promise<AttachOutcome> {
  const mime = request.mime ?? mimeForFileName(request.fileName);
  const relPath = workspaceRelPath(request.refRoot, request.sourcePath);
  const resolution = resolveAttachment(relPath, mime);
  // `relPath` is non-null whenever the resolution names a ref — resolveAttachment
  // returns "snapshot" for null — so the assertions below are total.
  if (resolution === "ref") return { kind: "ref", relPath: relPath! };

  const bytes = request.bytes ?? (await readFile(request.sourcePath!));
  assertFitsSessionBudget(db, request, bytes, mime);

  const blob = importBlobFor(db, blobsRootPath, request, bytes, mime, now);
  return resolution === "ref-and-snapshot"
    ? { kind: "ref-and-blob", relPath: relPath!, blob }
    : { kind: "blob", blob };
}

/**
 * Writes the bytes and, unless the owner does not exist yet, links them.
 *
 * An unowned import is the new-Ticket composer: the Blob is real and
 * addressable the moment it is attached (so its size is refused, and its
 * preview drawn, right then) while the link waits for the Ticket to be created.
 * Until then it is an unreferenced Blob, which is exactly what collection is
 * for.
 */
function importBlobFor(
  db: Database.Database,
  blobsRootPath: string,
  request: AttachRequest,
  bytes: Uint8Array,
  mime: string,
  now: number,
): BlobLinkView {
  const owner = request.owner;
  if ("unowned" in owner) {
    const hash = importOwnerless(db, blobsRootPath, request.fileName, bytes, mime, now);
    const stored = getBlob(db, hash)!;
    return {
      linkId: null,
      blobHash: hash,
      label: request.label || stored.originalName,
      originalName: stored.originalName,
      mime: stored.mime,
      sizeBytes: stored.sizeBytes,
    };
  }
  const link = importBlob(
    db,
    blobsRootPath,
    {
      fileName: request.fileName,
      bytes,
      mime,
      ...(request.label === undefined ? {} : { label: request.label }),
      owner,
    },
    now,
  );
  const stored = getBlob(db, link.blobHash)!;
  return {
    linkId: link.id,
    blobHash: link.blobHash,
    label: link.label,
    originalName: stored.originalName,
    mime: stored.mime,
    sizeBytes: stored.sizeBytes,
  };
}
