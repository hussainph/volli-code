/**
 * A tool result too long for the model: the middle cut out, the whole saved
 * beside the Session (VC-469).
 *
 * Pi 0.99 answers a long MCP result the way Codex answers long tool output:
 * the model reads the start and the end of the text around a
 * `…N chars truncated…` marker, and the whole text goes to a file the result
 * names, so a model that needs the middle can read it in parts. That replaced a
 * hard refusal past 256 KiB, which cost the model the whole result to protect
 * it from most of one. This module is that answer, with three differences from
 * Pi's own:
 *
 * - **Where the file lives.** Pi writes to the OS temp directory. Here the
 *   file goes in a directory beside the attachment's recovery sidecar, under
 *   the runtime's own data directory, which Volli's backup bundle leaves out
 *   (a tool result can carry anything its server could see).
 * - **How long it lives.** Saved output is a cache of something the model has
 *   already read the ends of, so it is bounded rather than kept: across every
 *   attachment it holds at most {@link TOOL_OUTPUT_TOTAL_MAX_BYTES}, and the
 *   oldest files go first when a new one needs the room
 *   ({@link ToolOutputLedger}). Main also removes a Session's saved output
 *   when its ticket is archived or deleted, and with its sidecar when a
 *   person cleans up orphaned sidecars.
 * - **What bounds one result.** One file holds at most
 *   {@link MCP_RESULT_MAX_BYTES} of text and one attachment at most
 *   {@link TOOL_OUTPUT_DIRECTORY_MAX_BYTES}, and the result says plainly when
 *   a bound cost the model part of the whole.
 *
 * Every file starts with a line saying what it is and that it is untrusted
 * data, and a `read` of one gets the same notice in its result (see
 * `createSessionTools`), so the trust marking that the original result carried
 * does not fall away when the model reads the rest of it later. Lines longer
 * than `read` returns are split in the file for the same reason: a model that
 * had to fall back on the shell to read them would read them unmarked.
 *
 * The cut restates the marker format and its byte budget, not Pi's code: the
 * start and the end get half the budget each, both cut on a character boundary.
 */

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { containsPath, errorMessage, MCP_RESULT_MAX_BYTES } from "@volli/shared";
import { normalizeToolCall, resolveReadableRoot } from "../authority/normalize";

/** The suffix that turns a sidecar's path into the path of its saved output. */
export const TOOL_OUTPUT_DIRECTORY_SUFFIX = ".tool-output";

/** The most one attachment saves in total; past it, a long result is cut and not saved. */
export const TOOL_OUTPUT_DIRECTORY_MAX_BYTES = 256 * 1_024 * 1_024;

/** The most every attachment's saved output holds together; past it, the oldest files go. */
export const TOOL_OUTPUT_TOTAL_MAX_BYTES = 1_024 * 1_024 * 1_024;

/**
 * The longest line a saved file holds. Pi's `read` refuses a line past 50 KB
 * and points at the shell, so a longer line is split across several here.
 */
export const SAVED_LINE_MAX_BYTES = 16 * 1_024;

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

/**
 * Whether `path` has the shape of a saved-output path under `dataDirectory`:
 * `<data>/<workspace folder>/<sidecar>.tool-output/…`. Lexical only.
 */
function isSavedOutputPath(dataDirectory: string, path: string, depth: number): boolean {
  const within = relative(dataDirectory, path);
  if (within.startsWith("..") || isAbsolute(within)) return false;
  const parts = within.split(sep);
  return parts.length >= depth && parts[1]!.endsWith(TOOL_OUTPUT_DIRECTORY_SUFFIX);
}

/**
 * The saved-output directories a Session's own history names (VC-469).
 *
 * Each long result recorded its file's path, and a fresh attachment that
 * carries an earlier conversation (VC-457) carries those results with it, so
 * the directories a Session may read are the ones its history names: its own,
 * an earlier attachment's after a relaunch, and every link of a carried chain.
 * Only a path inside the runtime's data directory, shaped like saved output,
 * counts — whatever a result recorded is checked again here.
 */
export function savedOutputDirectoriesIn(
  paths: Iterable<unknown>,
  dataDirectory: string,
): string[] {
  const data = resolve(dataDirectory);
  const directories = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || !isAbsolute(path)) continue;
    const file = resolve(path);
    if (isSavedOutputPath(data, file, 3)) directories.add(dirname(file));
  }
  return [...directories];
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
}

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
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) totalLines += 1;
  }
  const head = bytes.subarray(0, headEnd).toString("utf8");
  const tail = bytes.subarray(tailStart).toString("utf8");
  return {
    text: `${head}…${removedChars} chars truncated…${tail}`,
    removedChars,
    totalBytes: bytes.length,
    totalLines,
  };
}

/** The first `maxBytes` of `text`'s UTF-8, cut on a character boundary. */
function utf8Prefix(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && isContinuationByte(bytes[end])) end -= 1;
  return bytes.subarray(0, end);
}

/**
 * `bytes` with every line over `maxBytes` split onto several, each split on a
 * character boundary, and whether any was. Nothing else changes.
 */
export function splitLongLines(bytes: Buffer, maxBytes: number): { bytes: Buffer; split: boolean } {
  const pieces: Buffer[] = [];
  let split = false;
  let lineStart = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index < bytes.length && bytes[index] !== 0x0a) continue;
    let start = lineStart;
    while (index - start > maxBytes) {
      let end = start + maxBytes;
      while (end > start && isContinuationByte(bytes[end])) end -= 1;
      // A bound smaller than one character still moves past that character.
      if (end === start) {
        end += 1;
        while (isContinuationByte(bytes[end])) end += 1;
      }
      pieces.push(bytes.subarray(start, end));
      start = end;
      if (start < index) pieces.push(Buffer.from("\n"));
      split = true;
    }
    pieces.push(bytes.subarray(start, Math.min(index + 1, bytes.length)));
    lineStart = index + 1;
  }
  return split ? { bytes: Buffer.concat(pieces), split } : { bytes, split };
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

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_024 * 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(1)} GiB`;
}

/** One saved file, as the ledger orders them. */
interface SavedFile {
  path: string;
  bytes: number;
  modifiedAt: number;
}

/** A directory's entries, or none when it cannot be read. */
async function entries(directory: string) {
  return readdir(directory, { withFileTypes: true }).catch(() => []);
}

/** Every saved file under `dataDirectory`, oldest first. A missing directory holds none. */
export async function listSavedOutput(dataDirectory: string): Promise<SavedFile[]> {
  const files: SavedFile[] = [];
  for (const workspace of await entries(dataDirectory)) {
    if (!workspace.isDirectory()) continue;
    const workspaceDirectory = join(dataDirectory, workspace.name);
    for (const output of await entries(workspaceDirectory)) {
      if (!output.isDirectory() || !output.name.endsWith(TOOL_OUTPUT_DIRECTORY_SUFFIX)) continue;
      const outputDirectory = join(workspaceDirectory, output.name);
      for (const file of await entries(outputDirectory)) {
        if (!file.isFile()) continue;
        const path = join(outputDirectory, file.name);
        /* v8 ignore start -- a file removed between its listing and this stat (main cleaning up a ticket) is skipped; the race is not reproducible on demand. */
        const stats = await lstat(path).catch(() => undefined);
        if (stats !== undefined) files.push({ path, bytes: stats.size, modifiedAt: stats.mtimeMs });
        /* v8 ignore stop */
      }
    }
  }
  return files.toSorted((left, right) => left.modifiedAt - right.modifiedAt);
}

/**
 * The bound across every attachment's saved output, held by one runtime.
 *
 * Every save goes through {@link admit}, one at a time, so the total it keeps
 * is the total on disk. It is read from disk the first time, and again whenever
 * a save would cross the bound, because main removes saved output on its own
 * (a ticket archived, a sidecar cleaned up) and a stale total would evict files
 * nobody needed to lose. Past the bound the oldest files go first, down to
 * nine tenths of it, so the next saves do not each pay for a fresh read.
 */
export class ToolOutputLedger {
  readonly #dataDirectory: string;
  readonly #maxBytes: number;
  #files: SavedFile[] | undefined;
  #total = 0;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: { dataDirectory: string; maxBytes?: number }) {
    this.#dataDirectory = options.dataDirectory;
    this.#maxBytes = options.maxBytes ?? TOOL_OUTPUT_TOTAL_MAX_BYTES;
  }

  /**
   * Make room for a file of `bytes` and run `write`, which creates it and
   * returns its path. `false` when the file alone is over the bound. A
   * rejection from `write` is the caller's; the ledger is unchanged by it.
   */
  admit(bytes: number, write: () => Promise<string>): Promise<boolean> {
    const run = this.#chain.then(() => this.#admit(bytes, write));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #admit(bytes: number, write: () => Promise<string>): Promise<boolean> {
    if (bytes > this.#maxBytes) return false;
    if (this.#files === undefined || this.#total + bytes > this.#maxBytes) await this.#read();
    const files = this.#files!;
    const target =
      this.#total + bytes > this.#maxBytes ? Math.floor(this.#maxBytes * 0.9) : Infinity;
    while (files.length > 0 && this.#total + bytes > target) {
      const oldest = files.shift()!;
      await rm(oldest.path, { force: true });
      this.#total -= oldest.bytes;
    }
    const path = await write();
    files.push({ path, bytes, modifiedAt: Date.now() });
    this.#total += bytes;
    return true;
  }

  async #read(): Promise<void> {
    this.#files = await listSavedOutput(this.#dataDirectory);
    this.#total = this.#files.reduce((sum, file) => sum + file.bytes, 0);
  }
}

export interface ToolOutputStoreOptions {
  /** The attachment's own directory, from {@link toolOutputDirectoryFor}. */
  directory: string;
  /**
   * Other saved-output directories this Session's history names, from
   * {@link savedOutputDirectoriesIn}: its results point there, so it may read
   * them.
   */
  namedDirectories?: readonly string[];
  /**
   * The runtime's data directory. A read of any saved output under it is
   * marked untrusted, whichever attachment saved it: marking too much costs a
   * sentence, marking too little drops the warning.
   */
  dataDirectory?: string;
  /** The bound across every attachment; absent, only this attachment's bounds apply. */
  ledger?: ToolOutputLedger;
  /** The Session workspace, which a relative `read` path resolves against. */
  workspacePath: string;
  /** Most text bytes in one file. */
  fileMaxBytes?: number;
  /** Most bytes in the whole directory. */
  directoryMaxBytes?: number;
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
  /** Where this Session may read saved output: its own directory, then the ones its history names. */
  readonly readableDirectories: readonly string[];
  readonly #dataDirectory: string | undefined;
  readonly #ledger: ToolOutputLedger | undefined;
  readonly #workspacePath: string;
  readonly #fileMaxBytes: number;
  readonly #directoryMaxBytes: number;
  #used: number | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: ToolOutputStoreOptions) {
    this.directory = options.directory;
    this.readableDirectories = [
      options.directory,
      ...(options.namedDirectories ?? []).filter((named) => named !== options.directory),
    ];
    this.#dataDirectory = options.dataDirectory;
    this.#ledger = options.ledger;
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
      const body = splitLongLines(kept, SAVED_LINE_MAX_BYTES);
      const header = body.split
        ? `${input.header} Lines longer than ${formatBytes(SAVED_LINE_MAX_BYTES)} are split across several lines here; the text is otherwise exactly what the tool returned.`
        : input.header;
      const file = Buffer.concat([Buffer.from(`${header}\n\n`, "utf8"), body.bytes]);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // `mkdir` succeeds quietly on a link standing where the directory goes,
      // and every write below would then land wherever it points.
      if (!(await lstat(this.directory)).isDirectory()) {
        return {
          saved: false,
          reason: "its directory is not a real directory",
          totalBytes,
        };
      }
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
      // `wx`: a fresh file or nothing. The name is random and the directory
      // was just checked to be a real one, so nothing — a symlink planted at
      // the name included — is ever written through.
      const write = async (): Promise<string> => {
        await writeFile(path, file, { flag: "wx", mode: 0o600 });
        return path;
      };
      if (this.#ledger === undefined) await write();
      else if (!(await this.#ledger.admit(file.length, write))) {
        return {
          saved: false,
          reason: `it is over the ${formatBytes(TOOL_OUTPUT_TOTAL_MAX_BYTES)} limit on all saved tool output`,
          totalBytes,
        };
      }
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
    return data !== undefined && isSavedOutputPath(data, read, 3);
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
  return `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${cut.totalLines}\n\n${cut.text}\n\n${where}`;
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
