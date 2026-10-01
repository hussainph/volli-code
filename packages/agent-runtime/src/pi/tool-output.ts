/**
 * A tool result too long for the model: the middle cut out, the whole saved
 * beside the Session (VC-469).
 *
 * Pi 0.99 answers a long MCP result the way Codex answers long tool output:
 * the model reads the start and the end of the text around a
 * `…N chars truncated…` marker, and the whole text goes to a file the result
 * names, so a model that needs the middle can read it in parts. That replaced a
 * hard refusal past 256 KiB, which cost the model the whole result to protect
 * it from most of one. This module is that answer, with two differences from
 * Pi's own:
 *
 * - **Where the file lives.** Pi writes to the OS temp directory. Here the
 *   file goes in a directory beside the attachment's recovery sidecar, under
 *   the runtime's own data directory, so it lives exactly as long as the
 *   conversation that names it: Volli removes it when it reclaims that sidecar,
 *   and never sooner. That directory is also excluded from backups with the
 *   rest of the sidecars, which matters because a tool result can carry
 *   anything its server could see.
 * - **What bounds it.** Pi's file is unbounded. Here one file holds at most
 *   {@link MCP_RESULT_MAX_BYTES} of text, the directory at most
 *   {@link TOOL_OUTPUT_DIRECTORY_MAX_BYTES}, and the result says plainly when
 *   either bound cost the model part of the whole.
 *
 * Every file starts with a line saying what it is and that it is untrusted
 * data, and a `read` of one gets the same notice in its result (see
 * `createSessionTools`), so the trust marking that the original result carried
 * does not fall away when the model reads the rest of it later.
 *
 * The cut restates the marker format and its byte budget, not Pi's code: the
 * start and the end get half the budget each, both cut on a character boundary.
 */

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { containsPath, errorMessage, MCP_RESULT_MAX_BYTES } from "@volli/shared";
import { normalizeToolCall, resolveReadableRoot } from "../authority/normalize";

/** The suffix that turns a sidecar's path into the path of its saved output. */
export const TOOL_OUTPUT_DIRECTORY_SUFFIX = ".tool-output";

/** The most one attachment saves in total; past it, a long result is cut and not saved. */
export const TOOL_OUTPUT_DIRECTORY_MAX_BYTES = 256 * 1_024 * 1_024;

/**
 * The directory one attachment saves long tool output in: beside its sidecar,
 * named after it.
 *
 * A sibling rather than a child of a shared root, so the two cannot be parted:
 * whatever removes the sidecar names the directory too. Pi's repository lists
 * only `.jsonl` files and skips directories, and so does the orphan scanner,
 * so neither mistakes it for a sidecar.
 */
export function toolOutputDirectoryFor(sidecarPath: string): string {
  return `${sidecarPath.replace(/\.jsonl$/u, "")}${TOOL_OUTPUT_DIRECTORY_SUFFIX}`;
}

/** Text that did not fit, as the model reads it. */
export interface MiddleCut {
  /** The start and the end of the text around a `…N chars truncated…` marker. */
  text: string;
  /** Characters (code points) left out of {@link text}. */
  removedChars: number;
  /** UTF-8 bytes of the whole text. */
  totalBytes: number;
  /** Lines in the whole text. */
  totalLines: number;
  /** UTF-8 bytes of its longest line. */
  longestLineBytes: number;
}

/**
 * The longest line Pi's `read` returns: past it, `read` refuses the line and
 * points at the shell. Pi's `DEFAULT_MAX_BYTES`, restated.
 */
export const READ_LINE_MAX_BYTES = 50 * 1_024;

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * The start and the end of `text` within `maxBytes` of UTF-8, or `null` when
 * the whole of it fits.
 */
export function cutMiddle(text: string, maxBytes: number): MiddleCut | null {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return null;
  let headEnd = Math.floor(maxBytes / 2);
  while (headEnd > 0 && isContinuationByte(bytes[headEnd])) headEnd -= 1;
  let tailStart = bytes.length - (maxBytes - Math.floor(maxBytes / 2));
  while (tailStart < bytes.length && isContinuationByte(bytes[tailStart])) tailStart += 1;
  let removedChars = 0;
  for (let index = headEnd; index < tailStart; index += 1) {
    if (!isContinuationByte(bytes[index])) removedChars += 1;
  }
  // A final newline ends the last line rather than starting another.
  let totalLines = bytes[bytes.length - 1] === 0x0a ? 0 : 1;
  let longestLineBytes = 0;
  let lineStart = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index < bytes.length && bytes[index] !== 0x0a) continue;
    longestLineBytes = Math.max(longestLineBytes, index - lineStart);
    lineStart = index + 1;
    if (index < bytes.length) totalLines += 1;
  }
  const head = bytes.subarray(0, headEnd).toString("utf8");
  const tail = bytes.subarray(tailStart).toString("utf8");
  return {
    text: `${head}…${removedChars} chars truncated…${tail}`,
    removedChars,
    totalBytes: bytes.length,
    totalLines,
    longestLineBytes,
  };
}

/** The first `maxBytes` of `text`'s UTF-8, cut on a character boundary. */
function utf8Prefix(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && isContinuationByte(bytes[end])) end -= 1;
  return bytes.subarray(0, end);
}

/** What saving one long result came to. */
export type ToolOutputSave =
  | {
      saved: true;
      path: string;
      /** UTF-8 bytes of the text the file holds; under `totalBytes` when the file bound cut it. */
      savedBytes: number;
      totalBytes: number;
    }
  | { saved: false; reason: string; totalBytes: number };

export interface ToolOutputStoreOptions {
  /** The attachment's own directory, from {@link toolOutputDirectoryFor}. */
  directory: string;
  /**
   * Directories of earlier attachments whose conversation this one carries
   * (VC-457): their results name files there, so the Session may read them.
   */
  carriedDirectories?: readonly string[];
  /**
   * The runtime's data directory. A read of any saved output under it is
   * marked untrusted, whichever attachment saved it: marking too much costs a
   * sentence, marking too little drops the warning.
   */
  dataDirectory?: string;
  /** The Session workspace, which a relative `read` path resolves against. */
  workspacePath: string;
  /** Most text bytes in one file. */
  fileMaxBytes?: number;
  /** Most bytes in the whole directory. */
  directoryMaxBytes?: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

/** A call id as a file-name segment: provider ids are opaque and may hold anything. */
function fileSegment(callId: string): string {
  const safe = callId.replace(/[^A-Za-z0-9_-]+/gu, "_").slice(0, 64);
  return safe.length === 0 ? "call" : safe;
}

/**
 * One attachment's saved tool output.
 *
 * The directory is made on the first save, never at attach, so an attachment
 * whose results all fit leaves nothing behind. Saves are serialized: the
 * directory bound is a running total, and two results saved at once must not
 * both read it before either adds to it. The total starts from what the
 * directory already holds, because a reattached Session keeps saving into the
 * directory its earlier attachment of the same sidecar filled.
 */
export class ToolOutputStore {
  readonly directory: string;
  /** Where this Session may read saved output: its own directory, then any it carries. */
  readonly readableDirectories: readonly string[];
  readonly #dataDirectory: string | undefined;
  readonly #workspacePath: string;
  readonly #fileMaxBytes: number;
  readonly #directoryMaxBytes: number;
  #used: number | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: ToolOutputStoreOptions) {
    this.directory = options.directory;
    this.readableDirectories = [options.directory, ...(options.carriedDirectories ?? [])];
    this.#dataDirectory = options.dataDirectory;
    this.#workspacePath = options.workspacePath;
    this.#fileMaxBytes = options.fileMaxBytes ?? MCP_RESULT_MAX_BYTES;
    this.#directoryMaxBytes = options.directoryMaxBytes ?? TOOL_OUTPUT_DIRECTORY_MAX_BYTES;
  }

  /**
   * Save `text` whole (up to the file bound), behind `header`, as a file named
   * for `callId`. Never rejects: a result that could not be saved is still a
   * result, and the reason goes to the model in place of a path.
   */
  save(input: { callId: string; header: string; text: string }): Promise<ToolOutputSave> {
    const run = this.#chain.then(() => this.#save(input));
    this.#chain = run;
    return run;
  }

  async #save(input: { callId: string; header: string; text: string }): Promise<ToolOutputSave> {
    const bytes = Buffer.from(input.text, "utf8");
    const totalBytes = bytes.length;
    try {
      const kept = utf8Prefix(bytes, this.#fileMaxBytes);
      const file = Buffer.concat([Buffer.from(`${input.header}\n\n`, "utf8"), kept]);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const used = this.#used ?? (await this.#measure());
      if (used + file.length > this.#directoryMaxBytes) {
        this.#used = used;
        return {
          saved: false,
          reason: `this Session's saved tool output has reached its ${formatBytes(this.#directoryMaxBytes)} limit`,
          totalBytes,
        };
      }
      const path = join(
        this.directory,
        `${fileSegment(input.callId)}.${randomBytes(4).toString("hex")}.txt`,
      );
      // `wx`: a fresh file or nothing, so a name that somehow exists already —
      // a symlink planted there included — is never written through.
      await writeFile(path, file, { flag: "wx", mode: 0o600 });
      this.#used = used + file.length;
      return { saved: true, path, savedBytes: kept.length, totalBytes };
    } catch (error) {
      return {
        saved: false,
        reason: `it could not be written: ${errorMessage(error)}`,
        totalBytes,
      };
    }
  }

  async #measure(): Promise<number> {
    let total = 0;
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      total += (await lstat(join(this.directory, entry.name))).size;
    }
    return total;
  }

  /**
   * Whether a `read` tool's `path` argument opens saved tool output: a file in
   * one of {@link readableDirectories}, or in any attachment's `.tool-output`
   * directory under the data directory.
   *
   * Resolved the way the read tool and the authority gate resolve it — Pi's
   * own path normalization, the workspace as the base, symlinks followed — and
   * compared against a directory only while that is a real directory, so a
   * link planted in its place marks nothing.
   */
  holds(path: unknown): boolean {
    let read: string;
    try {
      read = normalizeToolCall({
        tool: "read",
        args: { path },
        workspacePath: this.#workspacePath,
      }).reads[0]!;
    } catch {
      return false;
    }
    for (const directory of this.readableDirectories) {
      const root = resolveReadableRoot(directory);
      if (root !== undefined && containsPath(root, read)) return true;
    }
    const data =
      this.#dataDirectory === undefined ? undefined : resolveReadableRoot(this.#dataDirectory);
    if (data === undefined) return false;
    const within = relative(data, read);
    if (within.startsWith("..") || isAbsolute(within)) return false;
    // `<data>/<workspace folder>/<sidecar>.tool-output/<file>`.
    const parts = within.split(sep);
    return parts.length >= 3 && parts[1]!.endsWith(TOOL_OUTPUT_DIRECTORY_SUFFIX);
  }
}

/** How the bound text and the file it points at read to the model. */
export function cutResultText(cut: MiddleCut, save: ToolOutputSave, maxBytes: number): string {
  const tokens = Math.ceil(cut.totalBytes / 4);
  // The file opens with Volli's two-line header, so the output starts at line 3.
  const how = "read it with offset/limit; the output starts at line 3";
  const where = !save.saved
    ? `[The full output could not be saved: ${save.reason}.]`
    : save.savedBytes < save.totalBytes
      ? `[The first ${formatBytes(save.savedBytes)} of ${formatBytes(save.totalBytes)} are saved to ${save.path} (${how}); the rest is past the ${formatBytes(maxBytes)} limit on one result.]`
      : `[Full output: ${save.path} (${how})]`;
  // `read` refuses a line past its own bound, and a long result is often one
  // line (minified JSON). Say so here rather than let the model find out.
  const longLines =
    save.saved && cut.longestLineBytes > READ_LINE_MAX_BYTES
      ? `\n[Some lines are longer than read returns (${formatBytes(READ_LINE_MAX_BYTES)}). Read those in byte ranges from the shell, for example: tail -c +<byte> <file> | head -c ${READ_LINE_MAX_BYTES}]`
      : "";
  return `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${cut.totalLines}\n\n${cut.text}\n\n${where}${longLines}`;
}

/** What a result whose text was cut records about the cut, beside its content. */
export interface ToolOutputCut {
  /** UTF-8 bytes of the whole text. */
  totalBytes: number;
  /** Lines in the whole text. */
  totalLines: number;
  /** Characters left out of what the model read. */
  removedChars: number;
  /** The file holding the whole text, or `null` when it could not be saved. */
  fullOutputPath: string | null;
  /** UTF-8 bytes of the text that file holds; under `totalBytes` when the file bound cut it. */
  savedBytes: number;
}

export function toolOutputCut(cut: MiddleCut, save: ToolOutputSave): ToolOutputCut {
  return {
    totalBytes: cut.totalBytes,
    totalLines: cut.totalLines,
    removedChars: cut.removedChars,
    fullOutputPath: save.saved ? save.path : null,
    savedBytes: save.saved ? save.savedBytes : 0,
  };
}
