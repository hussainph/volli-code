/**
 * File-store for attachment BYTES (issue #77 storage layer). Distinct from
 * `db/attachments-repo.ts`, which owns the `ticket_attachments` row
 * (id/label/fileName metadata) — this module owns the file on disk that a
 * `kind: "file"` row's `fileName` names. Bytes live under Electron `userData`,
 * keyed by attachment id: `<attachmentsRoot>/<attachmentId>/<fileName>`, so
 * two attachments can share a `fileName` without colliding and removing one
 * attachment's directory never touches another's.
 *
 * Root-path dependency-injected (never reaches for Electron's `app` itself)
 * so it stays pure-ish and testable against a tmp dir — mirrors how
 * `db/index.ts` is handed its `dbPath` rather than resolving `userData`
 * itself; `apps/desktop/src/main/index.ts` is the one call site that
 * resolves the real `app.getPath("userData")`.
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";

/** The attachments root under a given Electron `userData` path. */
export function attachmentsRoot(userDataPath: string): string {
  return join(userDataPath, "attachments");
}

/**
 * Guards `fileName` against escaping its attachment id directory: rejects any
 * `fileName` containing a path separator (`/` or, on Windows, `\`) or a `..`
 * substring. `fileName` must be the original basename ONLY — this is the one
 * place that invariant is enforced for the file store (the repo layer stores
 * whatever it's given; this module is the one that touches disk).
 */
function assertSafeFileName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName.includes("/") ||
    fileName.includes(sep) ||
    fileName.includes("..")
  ) {
    throw new Error(`Unsafe attachment fileName: ${JSON.stringify(fileName)}`);
  }
}

/** The absolute path an attachment's `fileName` is (or would be) stored at, under `root`. */
export function attachmentFilePath(root: string, attachmentId: string, fileName: string): string {
  assertSafeFileName(fileName);
  return join(root, attachmentId, fileName);
}

/**
 * Copies `sourcePath`'s bytes into the attachment's id directory (created if
 * absent) as `fileName`, and returns the stored absolute path. Throws if
 * `fileName` fails {@link assertSafeFileName}'s traversal guard.
 */
export function importAttachmentFile(
  root: string,
  attachmentId: string,
  sourcePath: string,
  fileName: string,
): string {
  const destPath = attachmentFilePath(root, attachmentId, fileName);
  mkdirSync(join(root, attachmentId), { recursive: true });
  copyFileSync(sourcePath, destPath);
  return destPath;
}

/** Removes an attachment's whole id directory. Idempotent — a missing directory is not an error. */
export function removeAttachmentFiles(root: string, attachmentId: string): void {
  rmSync(join(root, attachmentId), { recursive: true, force: true });
}
