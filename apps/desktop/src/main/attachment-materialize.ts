/**
 * The materialize step (CONCEPT decision #19, issue #77 PR 2): at ticket
 * session boot, a ticket's `file` attachments are copied into a gitignored
 * `.volli/attachments/` dir inside the SESSION's checkout — the worktree for
 * a worktree ticket, the main checkout for a worktree-opt-out one (see
 * `sessionAttachmentsDir`'s header for the boundary vs. `.volli/artifacts`).
 * `url` attachments have no bytes and pass through untouched. SYNCHRONOUS —
 * this runs inside the sync worktree `ensure` pipeline and pty.ts's sync
 * kickoff-command build, both of which are on the session-boot hot path.
 *
 * Idempotent by construction: an already-materialized destination is never
 * overwritten (mirrors `worktree/include.ts`'s copy semantics), so re-booting
 * a session — or opening a second session on the same ticket — is a cheap
 * no-op past the first materialize. A missing SOURCE file (the db row exists
 * but its bytes don't) throws loudly, naming the attachment's label — never
 * silently hands the agent an incomplete spec (CLAUDE.md: surface every
 * failed mutation).
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  attachmentsSectionInput,
  materializedAttachmentNames,
  sessionAttachmentsDir,
  VOLLI_GITIGNORE_CONTENT,
  volliDir,
} from "@volli/shared";

import { attachmentFilePath } from "./attachment-store";
import { listAttachments } from "./db/attachments-repo";

/** Creates `<sessionRoot>/.volli` and writes its self-gitignore if missing. Sync counterpart of `volli-fs.ts`'s `ensureVolliDir`; never touches the user's root `.gitignore`. */
function ensureVolliDirSync(sessionRoot: string): void {
  const dir = volliDir(sessionRoot);
  mkdirSync(dir, { recursive: true });
  const gitignorePath = join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, VOLLI_GITIGNORE_CONTENT, "utf8");
  }
}

/** The prompt-ready section input `composeAttachmentsSection` (shared) takes. */
export interface MaterializedAttachments {
  files: { relPath: string; label: string }[];
  urls: { url: string; label: string }[];
}

/**
 * Materializes `ticketId`'s attachments into `sessionRoot`, returning the
 * section input for the agent's kickoff prompt / CLI brief — returned even
 * when every file was skipped as already-present, since the prompt still
 * needs the full list. A ticket with no attachments is a cheap no-op that
 * touches nothing on disk (no `.volli/attachments`, no `.volli/.gitignore`).
 */
export function materializeAttachments(
  db: Database.Database,
  attachmentsRoot: string,
  ticketId: string,
  sessionRoot: string,
): MaterializedAttachments {
  const attachments = listAttachments(db, ticketId);
  if (attachments.length === 0) return { files: [], urls: [] };

  const materializedNames = materializedAttachmentNames(attachments);
  ensureVolliDirSync(sessionRoot);
  const destDir = sessionAttachmentsDir(sessionRoot);
  mkdirSync(destDir, { recursive: true });

  for (const attachment of attachments) {
    if (attachment.kind !== "file") continue;
    const materializedName = materializedNames.get(attachment.id);
    // Guaranteed present — materializedAttachmentNames maps every file-kind
    // attachment, and we're iterating that same list.
    if (materializedName === undefined) continue;
    const dest = join(destDir, materializedName);
    if (existsSync(dest)) continue; // never overwrite — re-boot idempotence.
    const source = attachmentFilePath(attachmentsRoot, attachment.id, attachment.fileName);
    if (!existsSync(source)) {
      throw new Error(`Missing attachment file for "${attachment.label}" (expected at ${source})`);
    }
    copyFileSync(source, dest);
  }
  // The prompt-ready shape is a pure function of the attachment rows alone
  // (relPath is deterministic from materializedAttachmentNames) — shared with
  // the worktree-kickoff/CLI-brief re-derive paths that never touch disk.
  return attachmentsSectionInput(attachments);
}
