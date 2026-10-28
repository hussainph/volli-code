/**
 * The Pi session files a Session's structured attachments on this machine
 * wrote: what its Pi log segments upload from (Amendment 9 keeps them for
 * continuity across runners). Shared by the runner's own packing
 * (`transcripts.ts`) and a project move's history upload
 * (`cloud-store/move-history.ts`), so a moved Session uploads the same
 * files its runner would have.
 */
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { LOCAL_RUNNER, type SessionAttachment } from "@volli/shared";
import { STRUCTURED_ADAPTER_ID } from "../session-runtime/sessions";
import { piFileIdOf, type PiLogFile } from "../transcript-spool/transcript-spool";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Each Pi file a structured attachment of this runner (or of the local
 * runner, before the machine was linked) recorded as its native locator,
 * once, inside Pi's runner-owned directory. A file outside that layout
 * throws: a path a tool supplied is never read.
 */
export async function piLogFilesOf(
  attachments: readonly SessionAttachment[],
  options: { runnerId: string; piDirectory: string; signal?: AbortSignal },
): Promise<PiLogFile[]> {
  const files: PiLogFile[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    options.signal?.throwIfAborted();
    if (
      attachment.adapterId !== STRUCTURED_ADAPTER_ID ||
      (attachment.venue.id !== options.runnerId &&
        !(attachment.venue.id === LOCAL_RUNNER.id && attachment.venue.kind === LOCAL_RUNNER.kind))
    )
      continue;
    const detail = attachment.native?.detail;
    if (!record(detail) || detail.kind !== "volli.native-binding.v1") continue;
    const locator = detail.locator;
    if (
      !record(locator) ||
      locator.runtime !== "pi" ||
      typeof locator.sessionId !== "string" ||
      locator.sessionId.length === 0 ||
      locator.sessionId !== attachment.native?.id ||
      typeof locator.sessionFilePath !== "string"
    )
      continue;
    // Read only Pi's runner-owned directory, never a path supplied by a tool.
    // Keep the original path: the spool's descriptor open refuses symlinks.
    const lexicalRoot = resolve(options.piDirectory);
    const within = relative(lexicalRoot, resolve(locator.sessionFilePath));
    const parts = within.split(sep);
    if (
      !isAbsolute(locator.sessionFilePath) ||
      parts.length !== 2 ||
      !parts[0]!.startsWith("--") ||
      !parts[0]!.endsWith("--") ||
      !parts[1]!.endsWith(".jsonl")
    )
      throw new Error("A Pi session file is outside the runner's history layout.");
    let root: string;
    try {
      root = await realpath(lexicalRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      root = lexicalRoot; // missing history is reported without blocking transcript packs
    }
    try {
      if ((await lstat(dirname(locator.sessionFilePath))).isSymbolicLink())
        throw new Error("A Pi history directory is a symbolic link.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let path: string;
    try {
      path = await realpath(locator.sessionFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      path = resolve(root, within); // the spool reports a missing file
    }
    const inside = relative(root, path);
    if (
      !isAbsolute(locator.sessionFilePath) ||
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside)
    )
      throw new Error("A Pi session file is outside the runner's history directory.");
    const fileId = piFileIdOf(path);
    if (seen.has(fileId)) continue;
    seen.add(fileId);
    files.push({ attachmentId: attachment.id, path: locator.sessionFilePath });
  }
  return files;
}
