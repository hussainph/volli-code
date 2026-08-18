/**
 * The materialize step (VC-50, `docs/plans/attachments.md`), replacing
 * `attachment-materialize.ts`: at session boot, every Blob linked to the
 * Session — through its Ticket and through the Session itself — is copied into
 * a gitignored `.volli/attachments/` dir inside the SESSION's checkout (the
 * worktree for a worktree ticket, the main checkout for a worktree-opt-out or
 * ticketless one; see `sessionAttachmentsDir`'s header for the boundary vs.
 * `.volli/artifacts`).
 *
 * EVERY Blob materializes, images included. Images are additionally inlined as
 * model input at send time, but that is a second delivery of the same file,
 * not an alternative to this one: it keeps one rule for every type, lets the
 * agent point a tool at a screenshot, and means a model whose `input` has no
 * `"image"` still gets the attachment as a path instead of an error.
 *
 * This directory is a PROJECTION, never the source of truth. Worktrees are
 * pruned and retention removes them; the bytes live in the Blob store under
 * `userData`, and a workspace that lost them is re-materialized here to
 * exactly the same names on the next boot, because the naming is a pure
 * function of the link rows.
 *
 * ASYNC, through `fs/promises`, for the reason the `ensure` pipeline around it
 * is (VC-16): both call sites are session boot on Electron main, and an
 * attachment is whatever file a person dragged in — a screen recording copies
 * as slowly as a repo does, and `copyFileSync` would freeze every window for
 * the duration.
 *
 * Idempotent by construction: an already-materialized destination is never
 * overwritten (mirrors `worktree/include.ts`'s copy semantics), so re-booting a
 * session — or opening a second session on the same ticket — is a cheap no-op
 * past the first materialize. Missing SOURCE bytes (the link row exists but the
 * Blob's file does not) throw loudly, naming the label — never silently hand
 * the agent an incomplete spec (CLAUDE.md: surface every failed mutation).
 */
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  blobsSectionInput,
  materializedBlobNames,
  sessionAttachmentsDir,
  VOLLI_GITIGNORE_CONTENT,
  volliDir,
} from "@volli/shared";

import { blobFilePath } from "./blob-store";
import { listMaterializableLinks } from "./db/blobs-repo";

/** Whether `path` exists, without throwing ENOENT at the caller. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates `<sessionRoot>/.volli` and writes its self-gitignore if missing. Mirrors `volli-fs.ts`'s `ensureVolliDir`; never touches the user's root `.gitignore`. */
async function ensureVolliDir(sessionRoot: string): Promise<void> {
  const dir = volliDir(sessionRoot);
  await mkdir(dir, { recursive: true });
  const gitignorePath = join(dir, ".gitignore");
  if (!(await pathExists(gitignorePath))) {
    await writeFile(gitignorePath, VOLLI_GITIGNORE_CONTENT, "utf8");
  }
}

/**
 * The prompt-ready section input `composeAttachmentsSection` (shared) takes.
 * `urls` is always empty today: link attachments are not part of VC-50, and
 * the formatter keeps its URL branch ready rather than being narrowed for a
 * feature that is deferred, not cancelled.
 */
export interface MaterializedBlobs {
  files: { relPath: string; label: string }[];
  urls: { url: string; label: string }[];
}

/**
 * Materializes the Session's Blobs into `sessionRoot`, returning the section
 * input for the agent's kickoff prompt / CLI brief — returned even when every
 * file was skipped as already-present, since the prompt still needs the full
 * list. A Session with no Blobs is a cheap no-op that touches nothing on disk
 * (no `.volli/attachments`, no `.volli/.gitignore`).
 */
export async function materializeBlobs(
  db: Database.Database,
  blobsRootPath: string,
  sessionId: string | null,
  ticketId: string | null,
  sessionRoot: string,
): Promise<MaterializedBlobs> {
  const links = listMaterializableLinks(db, sessionId, ticketId);
  if (links.length === 0) return { files: [], urls: [] };

  const names = materializedBlobNames(links);
  await ensureVolliDir(sessionRoot);
  const destDir = sessionAttachmentsDir(sessionRoot);
  await mkdir(destDir, { recursive: true });

  // Serial, not `Promise.all`: the failure below names the ONE Blob whose bytes
  // are missing, and a parallel map would race a second rejection past it and
  // report whichever lost. Attachment lists are short; ordering them costs
  // nothing worth the ambiguity.
  for (const link of links) {
    // Guaranteed present — materializedBlobNames maps every link in the very
    // list being iterated.
    const name = names.get(link.linkId);
    if (name === undefined) continue;
    const dest = join(destDir, name);
    if (await pathExists(dest)) continue; // never overwrite — re-boot idempotence.
    const source = blobFilePath(blobsRootPath, link.blobHash);
    if (!(await pathExists(source))) {
      throw new Error(`Missing attachment bytes for "${link.label}" (expected at ${source})`);
    }
    await copyFile(source, dest);
  }
  return blobsSectionInput(links);
}
