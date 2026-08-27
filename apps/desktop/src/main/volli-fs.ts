/**
 * All Node fs work for the global-artifacts + `@file` rework
 * (docs/plans/global-artifacts.md): the whole-project file index (git
 * ls-files, gitignore-respecting, `.volli/artifacts/` force-included),
 * worktree-aware read/write/reveal and external-app launch of any repo file,
 * the single project-scoped `.volli/artifacts/` create flow, and a per-open-tab
 * debounced file watch —
 * plus, for the Project Files workspace (issue #106), a per-expanded-directory
 * watch that refreshes one listing at a time rather than mirroring the repo.
 * Mirrors pty.ts/ghostty-config.ts's shape: pure fs helpers exported for direct
 * testing against real temp dirs, thin Electron IPC wiring at the bottom. Every
 * op returns a typed `Result` rather than throwing across the IPC boundary —
 * same convention as data-ipc.ts.
 *
 * Two-layer path safety: the pure {@link isSafeRelPath} check (reject
 * `..`/absolute/backslash/empty-segment) plus a `realpath` containment check
 * inside the resolved root ({@link assertWithinRoot}) — guarding a symlink
 * swapped in for a directory (or the target file itself).
 */
import { existsSync, promises as fsp, statSync, watch as fsWatch } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, resolve, sep } from "node:path";
import { shell } from "electron";
import type { WebContents } from "electron";
import type Database from "better-sqlite3";
import {
  applySkillModes,
  artifactBaseName,
  classifyFileKind,
  DEPENDENCY_AND_BUILD_DIRS,
  errorMessage,
  imageMimeType,
  isArtifactRelPath,
  isSafeRelPath,
  isValidNewArtifactName,
  isVolliRelPath,
  projectArtifactsDir,
  projectCommandsDir,
  projectSkillsDir,
  resolveFileRoot,
  VOLLI_ARTIFACTS_REL_DIR,
  VOLLI_GITIGNORE_CONTENT,
  volliDir,
  withMarkdownExtension,
} from "@volli/shared";
import { FILE_CHANNELS, FILE_IPC } from "./ipc-descriptors";
import { systemExternalAppGateway } from "./external-apps";
import type { ExternalAppGateway } from "./external-apps";
import type { FileKind, FileSource, IndexedFile } from "@volli/shared";
import type {
  ArtifactCreateInput,
  ArtifactCreateResult,
  DirChangedEvent,
  DirPathInput,
  ExternalAppListResult,
  ExternalAppOpenFileInput,
  ExternalAppOpenWorktreeInput,
  FileChangedEvent,
  FileContent,
  FileIndexInput,
  FileIndexResult,
  FileIpcChannel,
  FilePathInput,
  FileReadResult,
  FileWriteInput,
  FileWriteResult,
  PromptTemplateCreateInput,
  PromptTemplateCreateResult,
  PromptTemplateIndexInput,
  PromptTemplateIndexResult,
  Result,
  RevealResult,
  VolliIpcEvent,
  WorktreeRevealInput,
} from "../ipc/contract";
import type { DbHandle } from "./data-ipc";
import { getProjectById } from "./db/projects-repo";
import { getTicketRow } from "./db/tickets-repo";
import type { TicketRow } from "./db/tickets-repo";
import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "./ipc-registry";
import type { IpcHandlerTable } from "./ipc-registry";
import { isPathWithinRoots } from "./project-roots";
import { loadPromptTemplates, writePromptTemplate } from "./prompt-templates";
import { worktreesHome } from "./worktree-runtime";
import { isInside } from "./worktree/paths";
import { loadSkills } from "./skills";

const execFileAsync = promisify(execFile);

/** Text-read cap (decision #7): utf8 files past this are truncated + flagged. */
const TEXT_CAP_BYTES = 1024 * 1024;
/** Images past this are treated as binary (a data-URI that large is not worth inlining). */
const IMAGE_CAP_BYTES = 10 * 1024 * 1024;
/** Leading window the write guard NUL-sniffs an existing file over (see {@link assertTextWritable}). */
const BINARY_SNIFF_BYTES = 64 * 1024;
/** File-index entry cap (~20k, decision on `truncated`). */
const INDEX_CAP = 20_000;
/**
 * Directory names never descended into by the fallback walk (and the git list
 * already excludes `.volli`). Git's own metadata and Volli's own directory,
 * plus the shared per-ecosystem dependency/build list the worktree copy walk
 * prunes ({@link DEPENDENCY_AND_BUILD_DIRS}) — this walk is the one that runs
 * when `git ls-files` could NOT answer, so nothing else is filtering a `.venv`
 * or a `target` out of the 20k cap for it.
 */
const FALLBACK_SKIP_DIRS = new Set([".git", ".volli", ...DEPENDENCY_AND_BUILD_DIRS]);

/**
 * The same names as a watch-event prefix (`node_modules/`), for the one thing
 * {@link DirWatchManager.matches} drops. Built once at module load rather than
 * per event: the scan itself is still one pass over the list per event, but a
 * watcher under an install fires thousands of times and there is no reason to
 * re-allocate the same nine strings for each one.
 */
const DEPENDENCY_AND_BUILD_DIR_PREFIXES = DEPENDENCY_AND_BUILD_DIRS.map((name) => `${name}${sep}`);

// ---- low-level fs helpers ----------------------------------------------------

/** The `code` of a Node `ErrnoException`-shaped value, or undefined. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Friendly text for an fs fault the renderer renders VERBATIM (the file pane's
 * error state, save toasts). The raw Node message (`ENOENT: no such file or
 * directory, stat '/abs/path'`) is a debugging string, not UI copy — and it
 * leaks the absolute path main resolved, which the renderer deliberately never
 * handles. Codes outside the table fall back to the raw message: an exotic
 * fault (EIO, ELOOP) is rare enough that a precise clue beats a vague blanket.
 */
export function fsFaultText(error: unknown): string {
  switch (errnoCode(error)) {
    case "ENOENT":
    case "ENOTDIR":
      return "File was not found";
    case "EACCES":
    case "EPERM":
      return "Permission was denied";
    case "EEXIST":
      return "File already exists";
    case "EISDIR":
      return "Not a file";
    default:
      return errorMessage(error);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates `.volli/` and writes its self-gitignore (`*`) if missing. Idempotent; never touches the user's root `.gitignore`. */
export async function ensureVolliDir(projectPath: string): Promise<void> {
  const dir = volliDir(projectPath);
  await fsp.mkdir(dir, { recursive: true });
  const gitignorePath = join(dir, ".gitignore");
  if (!(await pathExists(gitignorePath))) {
    await fsp.writeFile(gitignorePath, VOLLI_GITIGNORE_CONTENT, "utf8");
  }
}

/** Ensures `.volli/artifacts/` (and its `.volli` parent chain + self-gitignore). */
export async function ensureProjectArtifactsDir(projectPath: string): Promise<void> {
  await ensureVolliDir(projectPath);
  await fsp.mkdir(projectArtifactsDir(projectPath), { recursive: true });
}

// ---- resolution + path safety ------------------------------------------------

// The resolved root + source for a relPath (decision #6) is `resolveFileRoot`
// in `@volli/shared`: the renderer's Copy Path has to name the same file this
// module would open, so the rule is stated once and tested once.

/**
 * SEAM (global-artifacts decision #6): a ticket's live worktree root, or `null`
 * to resolve against the main checkout. Reads the first-class `worktree_path`
 * column (migration 003), which `pty/manager.ts` stamps when a ticket's
 * worktree is created and `ticket-commands.ts` clears when it is removed, then
 * confirms the directory still exists on disk — the column can outlive the dir
 * (a manual `git worktree remove`, a wiped worktree home), and a stale row must
 * degrade to the main checkout rather than resolve every read to a hole.
 */
async function worktreeRootFromRow(row: TicketRow): Promise<string | null> {
  const worktreePath = row.worktree_path;
  if (worktreePath === null) return null;
  try {
    return (await fsp.stat(worktreePath)).isDirectory() ? worktreePath : null;
  } catch {
    return null;
  }
}

/**
 * Verifies `filePath` stays inside `root` after symlink resolution — the second
 * path-safety layer beyond {@link isSafeRelPath}. A target that is itself a
 * symlink is rejected outright (before its target is followed); a nonexistent
 * target (a brand-new artifact) is verified via its parent directory instead.
 * Fails closed: a missing root is reported, not ignored.
 */
async function assertWithinRoot(
  root: string,
  filePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let rootReal: string;
  try {
    rootReal = await fsp.realpath(root);
  } catch {
    return { ok: false, error: "Project folder was not found" };
  }
  // A symlink target is rejected before following it (matches the old artifacts
  // guard): even a dangling one named like a file is caught here.
  try {
    if ((await fsp.lstat(filePath)).isSymbolicLink()) {
      return { ok: false, error: "Path is a symlink" };
    }
  } catch {
    // Nothing at this path yet (ENOENT) — a brand-new file; fall through.
  }
  let real: string;
  try {
    real = await fsp.realpath(filePath);
  } catch {
    // Nonexistent target: verify its parent directory stays within the root.
    try {
      real = await fsp.realpath(dirname(filePath));
    } catch {
      return { ok: false, error: "File was not found" };
    }
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    return { ok: false, error: "Resolved path escapes the project root" };
  }
  return { ok: true };
}

interface ResolvedFile {
  root: string;
  source: FileSource;
  filePath: string;
}

/**
 * Resolves a Project Files directory (issue #106) against the MAIN checkout:
 * the empty string is the project root (the one accepted spelling — `"."` fails
 * {@link isSafeRelPath} like any other dot segment), anything else runs the full
 * two-layer path safety before being confirmed to actually be a directory.
 */
async function resolveSafeDir(
  projectPath: string,
  relPath: string,
): Promise<{ ok: true; dirPath: string } | { ok: false; error: string }> {
  let dirPath: string;
  if (relPath === "") {
    // The root is CANONICALIZED, not symlink-checked: a project folder the user
    // picked may legitimately BE a symlink (`~/code/app` → `/Volumes/…`), and
    // `assertWithinRoot` — whose symlink rejection exists to catch a link
    // swapped in UNDER the root — would refuse the root against itself, killing
    // the sidebar's root watch for the whole project. Containment is vacuous
    // here (the root IS the root); every deeper path below still runs both
    // safety layers, resolved against this same root.
    try {
      dirPath = await fsp.realpath(projectPath);
    } catch {
      return { ok: false, error: "Project folder was not found" };
    }
  } else {
    const resolved = await resolveSafePath(projectPath, null, relPath);
    if (!resolved.ok) return resolved;
    dirPath = resolved.value.filePath;
  }
  const stat = await statOrNull(dirPath);
  if (stat === null) return { ok: false, error: "Directory was not found" };
  if (!stat.isDirectory()) return { ok: false, error: "Not a directory" };
  return { ok: true, dirPath };
}

/** Runs both path-safety layers, returning the resolved absolute path + its source, or a typed error. */
async function resolveSafePath(
  projectPath: string,
  worktreeRoot: string | null,
  relPath: string,
  options: { allowRoot?: boolean } = {},
): Promise<{ ok: true; value: ResolvedFile } | { ok: false; error: string }> {
  const { root, source } = resolveFileRoot({ projectPath, worktreePath: worktreeRoot, relPath });
  // The one caller that names a ROOT is the ticket-repository external-app
  // action. It never receives a renderer-supplied absolute path: `root` came
  // from resolveFileScope's project/ticket lookup, and realpath canonicalizes
  // it before any native app sees it. Ordinary file APIs retain the strict
  // non-empty relative-path rule below.
  if (options.allowRoot && relPath === "") {
    try {
      return { ok: true, value: { root, source, filePath: await fsp.realpath(root) } };
    } catch {
      return {
        ok: false,
        error:
          source === "worktree" ? "Worktree folder was not found" : "Project folder was not found",
      };
    }
  }
  if (!isSafeRelPath(relPath)) return { ok: false, error: "Invalid file path" };
  const filePath = join(root, relPath);
  const check = await assertWithinRoot(root, filePath);
  if (!check.ok) return check;
  return { ok: true, value: { root, source, filePath } };
}

// ---- file index --------------------------------------------------------------

/** `git ls-files --cached --others --exclude-standard`, gitignore-respecting; `null` when git isn't usable (not a repo, no git). */
async function gitListFiles(projectPath: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: projectPath, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split("\0").filter((entry) => entry.length > 0);
  } catch {
    return null;
  }
}

/**
 * Recursively lists FILE paths under `baseDir` (relative, `/`-joined, prefixed
 * with `relPrefix`), skipping `skipDirNames` and symlinks, bounded to `limit`
 * entries. A directory that can't be read is skipped rather than throwing —
 * the index is best-effort.
 */
async function walkFiles(
  baseDir: string,
  opts: { skipDirNames?: Set<string>; relPrefix?: string; limit: number },
): Promise<string[]> {
  const skip = opts.skipDirNames ?? new Set<string>();
  const results: string[] = [];
  async function recur(dir: string, rel: string): Promise<void> {
    if (results.length >= opts.limit) return;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (results.length >= opts.limit) return;
      if (dirent.isSymbolicLink()) continue;
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (skip.has(dirent.name)) continue;
        await recur(join(dir, dirent.name), childRel);
      } else if (dirent.isFile()) {
        results.push(childRel);
      }
    }
  }
  await recur(baseDir, opts.relPrefix ?? "");
  return results;
}

/** What {@link buildFileIndex} may be told beyond the project's main checkout. */
export interface BuildFileIndexOptions {
  /**
   * SEAM (decision #6, the same one {@link resolveSafePath} applies per path):
   * the ticket worktree the REPO half of the index is listed from, or `null`
   * for the main checkout. Artifacts are walked from `projectPath` either way,
   * because `.volli/**` always resolves to Main — so the index and a read of
   * one of its rows can never disagree about which file a relPath names.
   */
  worktreeRoot?: string | null;
  /** Entry ceiling; artifacts are pushed first so they survive truncation. */
  indexCap?: number;
}

/**
 * The scoped file index the `@` picker and quick-open rank over (decision #3):
 * the git file list of the scope's checkout (gitignore-respecting; fallback to
 * a bounded walk when git isn't usable) plus a force-included walk of Main's
 * `.volli/artifacts/` (`artifact: true`). Capped at ~20k entries — artifacts
 * come first so they survive truncation.
 */
export async function buildFileIndex(
  projectPath: string,
  options: BuildFileIndexOptions = {},
): Promise<{ files: IndexedFile[]; truncated: boolean }> {
  const indexCap = options.indexCap ?? INDEX_CAP;
  // The repo half follows the scope; the artifact half never does.
  const repoRoot = options.worktreeRoot ?? projectPath;
  const gitFiles = await gitListFiles(repoRoot);
  const repoRelPaths =
    gitFiles ?? (await walkFiles(repoRoot, { skipDirNames: FALLBACK_SKIP_DIRS, limit: indexCap }));
  const artifactRelPaths = await walkFiles(projectArtifactsDir(projectPath), {
    relPrefix: VOLLI_ARTIFACTS_REL_DIR,
    limit: indexCap,
  });

  const seen = new Set<string>();
  const files: IndexedFile[] = [];
  let truncated = false;
  // Stop classifying/deduping once the cap is hit: `git ls-files` is unbounded
  // (a 500k-file monorepo), and materializing entries only to slice them away
  // burns main-process CPU. A distinct path skipped at the cap sets `truncated`;
  // a duplicate never does (it is already in the index), keeping the flag exact.
  const push = (relPath: string, artifact: boolean): void => {
    if (seen.has(relPath)) return;
    if (files.length >= indexCap) {
      truncated = true;
      return;
    }
    seen.add(relPath);
    files.push({ relPath, kind: classifyFileKind(relPath), artifact });
  };
  // Artifacts first (force-included, ranked first, survive the cap).
  for (const rel of artifactRelPaths) push(rel, true);
  // git normally excludes `.volli` (gitignored), but guard the flag anyway.
  for (const rel of repoRelPaths) push(rel, isArtifactRelPath(rel));

  return { files, truncated };
}

// ---- read / write / create / reveal ------------------------------------------

/**
 * Reads up to `cap` bytes, LOOPING until EOF or `cap + 1` bytes are in hand —
 * a single `read()` can return a legitimate short count (NFS/FUSE), and
 * inferring truncation from one call would silently drop the file's tail and
 * report `truncated: false`, which the renderer would then baseline autosave on
 * and write back (data loss). `truncated` is true only when a real `cap + 1`th
 * byte exists. `hintSize` is the caller's stat `size` (may be stale): it sizes
 * the initial allocation (`min(hintSize, cap) + 1`) but never bounds the loop,
 * which keeps reading — growing the buffer if the file outgrew its stat — up to
 * the `cap + 1` ceiling.
 */
async function readCapped(
  filePath: string,
  cap: number,
  hintSize: number,
): Promise<{ buf: Buffer; truncated: boolean }> {
  const limit = cap + 1; // one past the cap: the +1th byte's existence proves truncation
  const handle = await fsp.open(filePath, "r");
  try {
    let buffer = Buffer.alloc(Math.min(Math.max(hintSize, 0), cap) + 1);
    let total = 0;
    for (;;) {
      if (total >= buffer.length) {
        // The file outgrew its stat hint: grow the buffer toward the ceiling.
        const grown = Buffer.alloc(Math.min(buffer.length * 2, limit));
        buffer.copy(grown);
        buffer = grown;
      }
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break; // EOF
      total += bytesRead;
      if (total >= limit) break; // read one past the cap — enough to flag truncation
    }
    return { buf: buffer.subarray(0, Math.min(total, cap)), truncated: total > cap };
  } finally {
    await handle.close();
  }
}

/**
 * Reads up to `length` LEADING bytes. Loops over short reads for the same
 * reason {@link readCapped} does (a single `read()` can legitimately return
 * fewer bytes than asked on NFS/FUSE), but never grows: the caller wants a
 * bounded prefix, not the file.
 */
async function readPrefix(filePath: string, length: number): Promise<Buffer> {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, total);
      if (bytesRead === 0) break; // EOF
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

/** Reads a resolved file into a render-ready {@link FileContent}: text (utf8, capped), image (data URI), or binary. */
async function readContent(filePath: string, relPath: string, size: number): Promise<FileContent> {
  const kind = classifyFileKind(relPath);
  if (kind === "image") {
    const mime = imageMimeType(relPath);
    if (mime !== null && size <= IMAGE_CAP_BYTES) {
      const buffer = await fsp.readFile(filePath);
      return { type: "image", dataUrl: `data:${mime};base64,${buffer.toString("base64")}` };
    }
    return { type: "binary" };
  }
  const { buf, truncated } = await readCapped(filePath, TEXT_CAP_BYTES, size);
  // NUL-sniff: a byte-zero anywhere in the sampled prefix means binary.
  if (buf.includes(0)) return { type: "binary" };
  return { type: "text", text: buf.toString("utf8"), truncated };
}

/**
 * Reads any resolved repo/artifact file worktree-awarely (decision #6/#7):
 * markdown/code/text as utf8 (1 MiB cap + `truncated`), images as an inline
 * `data:` URI, and NUL-sniffed or oversize content as `binary` (stub tab).
 */
export async function readFile(
  projectPath: string,
  worktreeRoot: string | null,
  relPath: string,
): Promise<FileReadResult> {
  const resolved = await resolveSafePath(projectPath, worktreeRoot, relPath);
  if (!resolved.ok) return resolved;
  const { source, filePath } = resolved.value;
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return { ok: false, error: "Not a file" };
    const kind: FileKind = classifyFileKind(relPath);
    const content = await readContent(filePath, relPath, stat.size);
    return { ok: true, source, kind, size: stat.size, mtime: stat.mtimeMs, content };
  } catch (error) {
    return { ok: false, error: fsFaultText(error) };
  }
}

/** `stat` for a path, or `null` when nothing is there — an ENOENT is an answer here, not a failure. */
async function statOrNull(path: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fsp.stat(path);
  } catch {
    return null;
  }
}

/**
 * The text-writability policy for an EXISTING file (issue #106): the editor
 * round-trips utf8 text, so a file it could not have faithfully shown the user
 * must never be written back over. Two refusals — a file past
 * {@link TEXT_CAP_BYTES} was served TRUNCATED (writing the buffer back would
 * silently drop its tail; large-file editing stays deliberately unsupported),
 * and on-disk binary was rendered as a stub, never as text.
 *
 * The binary verdict is EXACTLY {@link readContent}'s — a NUL anywhere in the
 * same window the reader would have served. Deliberately not stricter: a stricter
 * write guard would make a file the editor happily shows unwritable, stranding
 * the draft with no way out. Not looser either, which is what the sniff window
 * below is careful about.
 *
 * Cheap in the case that matters. The size verdict comes from the `stat` the
 * caller already took (no read at all). For a file within
 * {@link BINARY_SNIFF_BYTES} — every artifact, essentially every source file,
 * and so every ~1.5s autosave commit — the prefix IS the whole file, so one
 * short read settles it. Only a file past that window pays the full scan, and
 * those are explicit-save documents, not the autosave hot path.
 *
 * An earlier revision stopped at the prefix for every size and argued the gap
 * was unreachable because `readContent` full-scans, so no tab could exist to
 * save from. True today, but it made a data-integrity guarantee here depend on
 * another function's behavior staying put — so the scan is local again.
 */
async function assertTextWritable(
  filePath: string,
  size: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (size > TEXT_CAP_BYTES) return { ok: false, error: "File is too large to edit (over 1 MiB)" };
  const sniffed =
    size <= BINARY_SNIFF_BYTES
      ? await readPrefix(filePath, BINARY_SNIFF_BYTES)
      : (await readCapped(filePath, TEXT_CAP_BYTES, size)).buf;
  if (sniffed.includes(0)) return { ok: false, error: "Binary files cannot be edited" };
  return { ok: true };
}

/**
 * Writes utf8 text to a resolved file — decision #7's markdown-only rule
 * WIDENED (issue #106) to every file the Monaco workspace can faithfully round
 * trip. Same worktree-aware resolution and two-layer path safety as read, plus
 * the `expectedMtime` conflict guard: a mismatch (or a vanished file) is a
 * typed error rather than a silent clobber. Resolves with the fresh on-disk
 * mtime so the renderer can rebase its guard.
 *
 * What is refused, and why (each is a way the round trip would LOSE bytes, not
 * a matter of taste): image extensions (the tab shows a data URI, not text),
 * on-disk binary, anything past {@link TEXT_CAP_BYTES} in either direction —
 * see {@link assertTextWritable}.
 *
 * NEW-FILE POLICY: a write to a path with nothing on disk is refused. Project
 * Files edits files that already exist; creation/rename/delete are a separate,
 * reference-aware track. The single exception is `.volli/**`, which this app
 * owns and self-heals below — an agent's `git clean -xdf` wipes it, and the
 * open artifact tab's buffered edits must not be stranded.
 */
export async function writeFile(
  projectPath: string,
  worktreeRoot: string | null,
  relPath: string,
  content: string,
  expectedMtime?: number,
): Promise<FileWriteResult> {
  // Kind is decided by EXTENSION, before any I/O: an image tab renders a data
  // URI, never text, so a "save" against one could only ever be a utf8 clobber
  // of its bytes.
  if (classifyFileKind(relPath) === "image") {
    return { ok: false, error: "Images cannot be edited" };
  }
  // Symmetric with the read cap: a buffer that grew past it could not be read
  // back in full, so accepting it would strand the tail on the next open.
  if (Buffer.byteLength(content, "utf8") > TEXT_CAP_BYTES) {
    return { ok: false, error: "Content is too large to save (over 1 MiB)" };
  }
  // Self-heal a vanished `.volli/` before resolving (the old `writeArtifact`'s
  // `ensureTierDir`): `.volli` self-gitignores, so `git clean -xdf` deletes it
  // out from under an open artifact tab. Without this, every autosave fails
  // "File was not found" forever (`resolveSafePath` has no parent dir to
  // realpath-check) and the user's buffered edits are stranded. Only `.volli/**`
  // is ever recreated — never an arbitrary repo path.
  if (isVolliRelPath(relPath)) {
    try {
      if (isArtifactRelPath(relPath)) {
        await ensureProjectArtifactsDir(projectPath);
      } else {
        await ensureVolliDir(projectPath);
      }
    } catch (error) {
      // Same friendly mapping as the write itself — this failure reaches the
      // same save toast, and a raw mkdir errno is no better copy there.
      return { ok: false, error: fsFaultText(error) };
    }
  }
  const resolved = await resolveSafePath(projectPath, worktreeRoot, relPath);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  try {
    const current = await statOrNull(filePath);
    if (current !== null) {
      if (!current.isFile()) return { ok: false, error: "Not a file" };
      if (expectedMtime !== undefined && current.mtimeMs !== expectedMtime) {
        return { ok: false, error: "File changed on disk since it was opened" };
      }
      const writable = await assertTextWritable(filePath, current.size);
      if (!writable.ok) return writable;
    } else if (expectedMtime !== undefined) {
      return { ok: false, error: "File no longer exists on disk" };
    } else if (!isVolliRelPath(relPath)) {
      return { ok: false, error: "File does not exist on disk" };
    }
    await fsp.writeFile(filePath, content, "utf8");
    const stat = await fsp.stat(filePath);
    return { ok: true, mtime: stat.mtimeMs };
  } catch (error) {
    return { ok: false, error: fsFaultText(error) };
  }
}

/**
 * Creates a new, minimally-templated `.md` artifact in the project's single
 * `.volli/artifacts/` tier (decision #8). `rawName` is validated
 * (no separators/`..`/empty/leading-dot) then forced to `.md`. The `wx`
 * (`O_EXCL`) flag makes a name collision — even one an agent created
 * concurrently — fail with EEXIST rather than silently overwriting, and refuses
 * to follow a pre-existing symlink at the target name. Resolves with the
 * project-relative path (`.volli/artifacts/<name>.md`), insertable directly as
 * an `@ref`.
 */
export async function createArtifact(
  projectPath: string,
  rawName: string,
): Promise<ArtifactCreateResult> {
  if (!isValidNewArtifactName(rawName)) return { ok: false, error: "Invalid artifact name" };
  const name = withMarkdownExtension(rawName.trim());
  const relPath = `${VOLLI_ARTIFACTS_REL_DIR}/${name}`;

  await ensureProjectArtifactsDir(projectPath);
  const resolved = await resolveSafePath(projectPath, null, relPath);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;

  // Friendly fast path for the common collision; the `wx` flag below is the
  // real, race-free guard (closes the TOCTOU window where an agent could create
  // the same file between this check and the write).
  if (await pathExists(filePath)) {
    return { ok: false, error: `An artifact named "${name}" already exists` };
  }
  try {
    await fsp.writeFile(filePath, `# ${artifactBaseName(name)}\n\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { ok: true, relPath };
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      return { ok: false, error: `An artifact named "${name}" already exists` };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

/** Reveals a resolved file in Finder — same `shell.showItemInFolder` call as `volli:reveal-in-finder`, server-resolved so the renderer never sends an absolute path. */
export async function revealFile(
  projectPath: string,
  worktreeRoot: string | null,
  relPath: string,
): Promise<RevealResult> {
  const resolved = await resolveSafePath(projectPath, worktreeRoot, relPath);
  if (!resolved.ok) return resolved;
  try {
    shell.showItemInFolder(resolved.value.filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// ---- live watch (per open file tab) ------------------------------------------

const WATCH_DEBOUNCE_MS = 250;

/**
 * The machinery every watch subscription needs, independent of WHAT it
 * broadcasts: the watched directory, the debounce timer, and the re-arm
 * bookkeeping. A file watch adds a basename filter (see
 * {@link FileWatchSubscription}); a directory watch adds nothing.
 */
interface WatchSubscription {
  webContents: WebContents;
  projectId: string;
  /** The project's MAIN checkout path — used to recreate a wiped `.volli` watch dir on re-arm. */
  projectPath: string;
  /** What the subscriber asked for, echoed back in the change event. */
  relPath: string;
  /** The directory actually handed to `fs.watch` (a file watch uses the file's parent). */
  dir: string;
  watcher: ReturnType<typeof fsWatch> | null;
  debounceTimer: NodeJS.Timeout | null;
  onDestroyed: () => void;
  /** Guards against overlapping re-arms. */
  reArming: boolean;
  /** Pending bounded-retry timer for a missing watch dir (cleared on teardown). */
  retryTimer: NodeJS.Timeout | null;
  /**
   * How many live watch() callers share this subscription. FileView + DiffView
   * (and StrictMode remounts) can hold the same key; unwatch only tears down
   * when the count hits zero.
   */
  refCount: number;
}

interface FileWatchSubscription extends WatchSubscription {
  source: FileSource;
  ticketId: string | null;
  /** The file's basename — dir events for any other name are ignored. */
  base: string;
}

/**
 * The shared `fs.watch` lifecycle behind both watch surfaces: debounced
 * broadcast to the subscribing window only (window-scoped, same stance as
 * PtyManager), bounded re-arm when the watcher faults or its directory is
 * deleted-and-recreated, and teardown on renderer `destroyed`. Subclasses
 * supply only the two things that differ — which filesystem events count
 * ({@link matches}) and what event to send ({@link sendChanged}) — so the
 * retry logic exists exactly once.
 */
abstract class WatchManagerBase<S extends WatchSubscription> {
  protected readonly subs = new Map<string, S>();

  constructor(private readonly debounceMs: number = WATCH_DEBOUNCE_MS) {}

  /** Whether a raw `fs.watch` filename (null on coalesced/platform events) concerns this subscription. */
  protected abstract matches(sub: S, filename: string | null): boolean;

  /**
   * Sends this subscription's change event; the caller has already checked the
   * sender is alive. `final` marks the one event a torn-down subscription is
   * owed — the renderer cannot tell that apart from ordinary news on its own
   * (issue #134), so it is stated rather than implied.
   */
  protected abstract sendChanged(sub: S, final: boolean): void;

  /**
   * Registers and wires a fully-built subscription. A second watch on the same
   * key increments {@link WatchSubscription.refCount} and returns ok without
   * rewiring; a destroyed sender is a no-op.
   */
  protected install(key: string, sub: S): Result {
    const existing = this.subs.get(key);
    if (existing !== undefined) {
      existing.refCount += 1;
      return { ok: true };
    }
    if (sub.webContents.isDestroyed()) return { ok: true };

    sub.refCount = 1;
    this.subs.set(key, sub);
    try {
      this.wireWatcher(key, sub);
    } catch (error) {
      // Surface the install failure rather than leaving the tab believing live
      // updates are on (CLAUDE.md): deregister and report a typed error.
      sub.watcher?.close();
      this.subs.delete(key);
      return { ok: false, error: errorMessage(error) };
    }
    sub.webContents.once("destroyed", sub.onDestroyed);
    return { ok: true };
  }

  /**
   * Drops one watch() hold. Tears down only when the last holder releases;
   * unknown keys are a harmless no-op (collapse/unmount racing a prior teardown).
   */
  protected release(key: string): void {
    const sub = this.subs.get(key);
    if (sub === undefined) return;
    sub.refCount -= 1;
    if (sub.refCount <= 0) this.teardown(key);
  }

  private scheduleBroadcast(sub: S): void {
    if (sub.debounceTimer !== null) clearTimeout(sub.debounceTimer);
    sub.debounceTimer = setTimeout(() => {
      sub.debounceTimer = null;
      if (sub.webContents.isDestroyed()) return;
      this.sendChanged(sub, false);
    }, this.debounceMs);
  }

  private wireWatcher(key: string, sub: S): void {
    sub.watcher = fsWatch(sub.dir, (_eventType, filename) => {
      // The watched dir was deleted-and-recreated: re-arm onto the new inode.
      if (!existsSync(sub.dir)) {
        this.reArm(key, sub);
        return;
      }
      if (this.matches(sub, filename)) this.scheduleBroadcast(sub);
    });
    // An async watch fault (volume ejected, fd pressure) surfaces as an
    // EventEmitter 'error'; UNHANDLED it would crash main. Re-arm instead.
    sub.watcher.on("error", () => {
      this.reArm(key, sub);
    });
  }

  /**
   * Rebuilds the watcher in place after the watched dir changed underneath it
   * (deleted-and-recreated) or the watcher faulted. When the dir is still there
   * it rewires synchronously and broadcasts once (the tree may have changed).
   * When the dir is momentarily GONE it does NOT tear down permanently — an
   * agent's `rm -rf .volli && mkdir -p .volli/artifacts`, or a build wiping and
   * regenerating a dir, would otherwise leave the tab silently stale for life:
   * see {@link attemptReArm}. Never crashes main.
   */
  private reArm(key: string, sub: S): void {
    if (sub.reArming) return;
    if (this.subs.get(key) !== sub) return; // torn down while the event was queued
    sub.reArming = true;
    sub.watcher?.close();
    sub.watcher = null;
    this.attemptReArm(key, sub, 0);
  }

  /** Whether the watched dir lives inside the project's `.volli` tree (ours to recreate). */
  private isUnderVolliTree(sub: S): boolean {
    const root = volliDir(sub.projectPath);
    return sub.dir === root || sub.dir.startsWith(root + sep);
  }

  /** Recreates a wiped `.volli` watch dir (best-effort). `attemptReArm` re-checks existence after. */
  private async ensureVolliWatchDir(sub: S): Promise<void> {
    try {
      const artifactsDir = projectArtifactsDir(sub.projectPath);
      if (sub.dir === artifactsDir || sub.dir.startsWith(artifactsDir + sep)) {
        await ensureProjectArtifactsDir(sub.projectPath);
      } else {
        await ensureVolliDir(sub.projectPath);
      }
      // The watched dir may be deeper than the ensure helpers create.
      await fsp.mkdir(sub.dir, { recursive: true });
    } catch {
      // Best-effort: finishReArm re-checks existsSync and falls into retry/teardown.
    }
  }

  /**
   * One re-arm attempt. For a `.volli/**` dir we own, recreate it first (agent
   * wiped it, or `git clean`); an arbitrary dir is never mkdir'd. Then hand off
   * to {@link finishReArm}, which rewires if the dir is now present or schedules
   * a bounded retry otherwise. The `.volli` recreation is async, so this path is
   * NOT synchronous for `.volli` dirs; the plain-fault path (dir still present)
   * stays synchronous, matching the watcher-error re-arm contract.
   */
  private attemptReArm(key: string, sub: S, attempt: number): void {
    if (this.subs.get(key) !== sub) return; // torn down while the retry was queued
    if (!existsSync(sub.dir) && this.isUnderVolliTree(sub)) {
      void this.ensureVolliWatchDir(sub).finally(() => this.finishReArm(key, sub, attempt));
      return;
    }
    this.finishReArm(key, sub, attempt);
  }

  private readonly reArmRetryMax = 3;
  private readonly reArmRetryDelayMs = 1000;

  /**
   * Rewires when the watch dir is present; otherwise schedules a bounded retry
   * (dir may be mid-regeneration) and, once exhausted, tears down with one final
   * broadcast so the tab refetches rather than believing updates still flow.
   */
  private finishReArm(key: string, sub: S, attempt: number): void {
    if (this.subs.get(key) !== sub) return; // torn down while queued
    if (existsSync(sub.dir)) {
      try {
        this.wireWatcher(key, sub);
      } catch {
        // Same contract as the retry-exhausted path below: this subscription
        // ends up watcher-less either way, so it owes the subscriber one final
        // event — silence would leave the tab/tree believing updates flow. This
        // is the path where the dir (and usually the file) is STILL THERE, so
        // only the `final` flag distinguishes the event from ordinary news.
        this.teardown(key);
        if (!sub.webContents.isDestroyed()) this.sendChanged(sub, true);
        return;
      }
      sub.reArming = false;
      this.scheduleBroadcast(sub);
      return;
    }
    if (attempt + 1 < this.reArmRetryMax) {
      sub.retryTimer = setTimeout(() => {
        sub.retryTimer = null;
        this.attemptReArm(key, sub, attempt + 1);
      }, this.reArmRetryDelayMs);
      return;
    }
    this.teardown(key);
    if (!sub.webContents.isDestroyed()) this.sendChanged(sub, true);
  }

  protected teardown(key: string): void {
    const sub = this.subs.get(key);
    if (sub === undefined) return;
    sub.watcher?.close();
    if (sub.debounceTimer !== null) clearTimeout(sub.debounceTimer);
    if (sub.retryTimer !== null) clearTimeout(sub.retryTimer);
    if (!sub.webContents.isDestroyed()) {
      sub.webContents.removeListener("destroyed", sub.onDestroyed);
    }
    this.subs.delete(key);
  }
}

/**
 * Watches one open file tab and broadcasts a debounced `volli:file-changed`.
 * Watches the file's PARENT directory and filters events by basename so an
 * atomic replace (temp-write + rename, how most editors save) still fires.
 * One subscription per `(webContents, projectId, ticketId, relPath)`.
 */
export class FileWatchManager extends WatchManagerBase<FileWatchSubscription> {
  private keyFor(
    webContents: WebContents,
    projectId: string,
    ticketId: string | null,
    relPath: string,
  ): string {
    return `${webContents.id}:${projectId}:${ticketId ?? ""}:${relPath}`;
  }

  /** Idempotent wiring: a second watch on the same tab bumps refCount. `dir`/`base`/`source`/`projectPath` come from the caller's resolution. */
  watch(
    webContents: WebContents,
    projectId: string,
    ticketId: string | null,
    relPath: string,
    source: FileSource,
    dir: string,
    base: string,
    projectPath: string,
  ): Result {
    const key = this.keyFor(webContents, projectId, ticketId, relPath);
    return this.install(key, {
      webContents,
      projectId,
      projectPath,
      relPath,
      source,
      ticketId: source === "worktree" ? ticketId : null,
      dir,
      base,
      watcher: null,
      debounceTimer: null,
      onDestroyed: () => this.teardown(key),
      reArming: false,
      retryTimer: null,
      refCount: 1,
    });
  }

  /** Drops one hold; tears down only when the last FileView/DiffView (etc.) releases. */
  unwatch(
    webContents: WebContents,
    projectId: string,
    ticketId: string | null,
    relPath: string,
  ): void {
    this.release(this.keyFor(webContents, projectId, ticketId, relPath));
  }

  /**
   * fs.watch reports the basename (or null on some platforms/coalesced
   * events); a null filename can't be filtered, so broadcast conservatively.
   */
  protected override matches(sub: FileWatchSubscription, filename: string | null): boolean {
    return filename === null || filename === sub.base;
  }

  protected override sendChanged(sub: FileWatchSubscription, final: boolean): void {
    const payload: FileChangedEvent = {
      projectId: sub.projectId,
      ticketId: sub.ticketId,
      relPath: sub.relPath,
      source: sub.source,
      // Resolve after the debounce: an editor's temp-write + rename must
      // identify the final inode, not the file present when watch was armed.
      revision: this.currentRevision(join(sub.dir, sub.base)),
    };
    if (final) payload.final = true;
    sub.webContents.send("volli:file-changed" satisfies VolliIpcEvent, payload);
  }

  private currentRevision(filePath: string): number | null {
    try {
      return statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }
}

/**
 * Watches one EXPANDED Project Files directory (issue #106) and broadcasts a
 * debounced `volli:dir-changed` so the tree re-lists just that directory.
 * Non-recursive by construction — `fs.watch` is armed without `recursive`, so a
 * deep repo costs one watcher per open row rather than a hydrated subtree — and
 * main-checkout-scoped (CONCEPT #54), hence no ticketId in the key. Unlike a
 * file tab there is no basename to filter to — the payload names only the
 * directory, never its listing — so nearly every event counts; see
 * {@link DirWatchManager.matches} for the one exclusion.
 */
export class DirWatchManager extends WatchManagerBase<WatchSubscription> {
  private keyFor(webContents: WebContents, projectId: string, relPath: string): string {
    return `${webContents.id}:${projectId}:${relPath}`;
  }

  /** Idempotent wiring: a second watch on the same directory bumps refCount. `dir` is the caller's resolved absolute path. */
  watch(
    webContents: WebContents,
    projectId: string,
    relPath: string,
    dir: string,
    projectPath: string,
  ): Result {
    const key = this.keyFor(webContents, projectId, relPath);
    return this.install(key, {
      webContents,
      projectId,
      projectPath,
      relPath,
      dir,
      watcher: null,
      debounceTimer: null,
      onDestroyed: () => this.teardown(key),
      reArming: false,
      retryTimer: null,
      refCount: 1,
    });
  }

  /** Drops one hold; safe for a directory that was never watched (a collapse racing a teardown). */
  unwatch(webContents: WebContents, projectId: string, relPath: string): void {
    this.release(this.keyFor(webContents, projectId, relPath));
  }

  /**
   * Everything counts EXCEPT `.git`, which `volli:list-directory` filters out of
   * every level of the tree — so no amount of git churn (and a repo under an
   * agent produces a great deal of it, index locks and refs on every command)
   * can change what the user is looking at. Re-listing for it would be pure
   * main-process + IPC waste, and the sidebar's root watch stays armed for the
   * whole life of the tree, including while Files is off screen.
   *
   * A dependency or build directory ({@link DEPENDENCY_AND_BUILD_DIRS}) is
   * deliberately NOT excluded by name: each IS a visible row, so its
   * creation/removal must still refresh the level. Only writes DEEPER inside one
   * are dropped, which cannot change the listing either — and those are exactly
   * the events that arrive in floods (an install, a `cargo build`, a `.venv`
   * being populated). Only `node_modules` was named here until VC-160, so a
   * non-JS repo's flood was re-listed in full. A null filename
   * (coalesced/platform event) is unfilterable, so it broadcasts conservatively.
   */
  protected override matches(_sub: WatchSubscription, filename: string | null): boolean {
    if (filename === null) return true;
    if (filename === ".git" || filename.startsWith(`.git${sep}`)) return false;
    return !DEPENDENCY_AND_BUILD_DIR_PREFIXES.some((prefix) => filename.startsWith(prefix));
  }

  protected override sendChanged(sub: WatchSubscription, final: boolean): void {
    const payload: DirChangedEvent = { projectId: sub.projectId, relPath: sub.relPath };
    if (final) payload.final = true;
    sub.webContents.send("volli:dir-changed" satisfies VolliIpcEvent, payload);
  }
}

// ---- IPC wiring --------------------------------------------------------------

/** The main-repo path for a project id, or a typed error. */
function resolveProjectPath(
  db: Database.Database,
  projectId: string,
): { ok: true; projectPath: string } | { ok: false; error: string } {
  const project = getProjectById(db, projectId);
  if (!project) return { ok: false, error: "Unknown project" };
  return { ok: true, projectPath: project.path };
}

interface FileScope {
  projectPath: string;
  worktreeRoot: string | null;
  usesWorktree: boolean;
}

/**
 * The main-repo path plus the ticket's worktree root (the seam) for a file
 * request. `ticketId` is optional; when given it's checked against `projectId`
 * (defense-in-depth — a mismatched pair is rejected, not trusted).
 */
async function resolveFileScope(
  db: Database.Database,
  projectId: string,
  ticketId: string | undefined,
): Promise<{ ok: true; value: FileScope } | { ok: false; error: string }> {
  const project = resolveProjectPath(db, projectId);
  if (!project.ok) return project;
  if (ticketId === undefined) {
    return {
      ok: true,
      value: { projectPath: project.projectPath, worktreeRoot: null, usesWorktree: false },
    };
  }
  const row = getTicketRow(db, ticketId);
  if (!row) return { ok: false, error: "Unknown ticket" };
  if (row.project_id !== projectId)
    return { ok: false, error: "Ticket does not belong to project" };
  return {
    ok: true,
    value: {
      projectPath: project.projectPath,
      worktreeRoot: await worktreeRootFromRow(row),
      usesWorktree: row.uses_worktree !== 0,
    },
  };
}

/**
 * Resolves a live worktree before passing it to Finder or an external app.
 * `worktree_path` is durable data, not an authorization to open any directory:
 * it must remain inside the ticket's project root, a registered project root,
 * or the app-owned worktree home after canonicalization.
 */
async function resolveTrustedLiveWorktree(
  scope: FileScope,
): Promise<{ ok: true; value: ResolvedFile } | { ok: false; error: string }> {
  if (!scope.usesWorktree || scope.worktreeRoot === null) {
    return { ok: false, error: "Worktree folder was not found" };
  }

  let worktreeRoot: string;
  try {
    worktreeRoot = await fsp.realpath(resolve(scope.worktreeRoot));
  } catch {
    return { ok: false, error: "Worktree folder was not found" };
  }
  if (
    !isInside(scope.projectPath, worktreeRoot) &&
    !isPathWithinRoots(worktreeRoot) &&
    !isInside(worktreesHome(), worktreeRoot)
  ) {
    return { ok: false, error: "Worktree folder is outside known projects" };
  }
  return await resolveSafePath(scope.projectPath, worktreeRoot, "", { allowRoot: true });
}

/**
 * Resolves a file target destined for Finder or an external app. A ticket that
 * uses worktrees must resolve a trusted live worktree; it never silently opens
 * Main when that checkout is gone.
 */
async function resolveExternalFileTarget(
  scope: FileScope,
  ticketId: string | undefined,
  relPath: string,
): Promise<{ ok: true; value: ResolvedFile } | { ok: false; error: string }> {
  let worktreeRoot = scope.worktreeRoot;
  if (ticketId !== undefined && !isVolliRelPath(relPath)) {
    if (scope.usesWorktree) {
      const worktree = await resolveTrustedLiveWorktree(scope);
      if (!worktree.ok) return worktree;
      worktreeRoot = worktree.value.filePath;
    } else {
      // A ticket that opted out of worktrees correctly lives in Main. Do not
      // trust an unexpected stale worktree_path for a native-app action.
      worktreeRoot = null;
    }
  }
  return await resolveSafePath(scope.projectPath, worktreeRoot, relPath);
}

/** Resolves only a trusted LIVE ticket worktree: unlike a File read, it must never fall back to main. */
async function resolveLiveWorktree(
  db: Database.Database,
  projectId: string,
  ticketId: string,
): Promise<{ ok: true; value: ResolvedFile } | { ok: false; error: string }> {
  const scope = await resolveFileScope(db, projectId, ticketId);
  if (!scope.ok) return scope;
  return await resolveTrustedLiveWorktree(scope.value);
}

/** The live watch managers `registerFileIpcHandlers` owns — one per watch surface. */
export interface FileIpcWatchManagers {
  files: FileWatchManager;
  dirs: DirWatchManager;
}

/** What this surface needs that the db cannot tell it. */
export interface FileIpcOptions {
  /**
   * `<userData>/commands` — the global tier of the composer's `/` picker.
   * Injected rather than resolved here because `index.ts` is the one module
   * that may call `app.getPath("userData")`.
   */
  globalCommandsDir: string;
  /**
   * `<home>/.agents/skills` — the personal tier of the `/` picker's skills,
   * injected for `globalCommandsDir`'s reason: the home directory is resolved
   * once, in `index.ts`, and handed down rather than read here.
   */
  globalSkillsDir: string;
  /** Native app detection/launch, injectable so the IPC boundary stays testable without macOS. */
  externalApps?: ExternalAppGateway;
}

/**
 * Registers every file, directory, artifact, and external-app handler through
 * the shared guard→body→envelope registry (issue #98): `FILE_IPC` (@volli/shared)
 * supplies the descriptor table (validators + invalid-request messages) and
 * `registerGuardedIpcHandlers` applies guard → body → try/catch; this module
 * supplies only the handler bodies below. When the db failed to open, every
 * channel instead resolves with a typed `{ ok: false, error }`
 * (`registerDegradedIpcHandlers(FILE_CHANNELS, …)`) — same degraded-DB stance
 * as `registerDataIpcHandlers`. Returns both watch managers; watchers are
 * otherwise self-cleaning on window `destroyed`/explicit unwatch.
 */
export function registerFileIpcHandlers(
  handle: DbHandle,
  options: FileIpcOptions,
): FileIpcWatchManagers {
  const manager = new FileWatchManager();
  const dirManager = new DirWatchManager();

  if (!handle.ok) {
    registerDegradedIpcHandlers(FILE_CHANNELS, handle.error);
    return { files: manager, dirs: dirManager };
  }

  const db = handle.db;
  const externalApps = options.externalApps ?? systemExternalAppGateway;

  const handlers: IpcHandlerTable<FileIpcChannel> = {
    // Scope follows the surface that asked (VC-190): Home hands no ticketId and
    // gets Main; a Ticket workspace hands its own and gets that worktree —
    // through `resolveFileScope`, the same seam `volli:file-read` resolves
    // through, so quick-open can never offer a row the read then answers from
    // the other checkout.
    "volli:file-index": async (input: FileIndexInput): Promise<FileIndexResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      const { files, truncated } = await buildFileIndex(scope.value.projectPath, {
        worktreeRoot: scope.value.worktreeRoot,
      });
      return { ok: true, files, truncated };
    },

    "volli:file-read": async (input: FilePathInput): Promise<FileReadResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      return await readFile(scope.value.projectPath, scope.value.worktreeRoot, input.relPath);
    },

    "volli:external-app-list": async (): Promise<ExternalAppListResult> => ({
      ok: true,
      apps: await externalApps.list(),
    }),

    "volli:external-app-open-file": async (input: ExternalAppOpenFileInput): Promise<Result> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      const resolved = await resolveExternalFileTarget(scope.value, input.ticketId, input.relPath);
      if (!resolved.ok) return resolved;
      return await externalApps.open(input.appId, resolved.value.filePath);
    },

    "volli:external-app-open-worktree": async (
      input: ExternalAppOpenWorktreeInput,
    ): Promise<Result> => {
      const resolved = await resolveLiveWorktree(db, input.projectId, input.ticketId);
      if (!resolved.ok) return resolved;
      return await externalApps.open(input.appId, resolved.value.filePath);
    },

    "volli:worktree-reveal": async (input: WorktreeRevealInput): Promise<Result> => {
      const resolved = await resolveLiveWorktree(db, input.projectId, input.ticketId);
      if (!resolved.ok) return resolved;
      try {
        shell.showItemInFolder(resolved.value.filePath);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    "volli:file-write": async (input: FileWriteInput): Promise<FileWriteResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      return await writeFile(
        scope.value.projectPath,
        scope.value.worktreeRoot,
        input.relPath,
        input.content,
        input.expectedMtime,
      );
    },

    "volli:artifact-create": async (input: ArtifactCreateInput): Promise<ArtifactCreateResult> => {
      const project = resolveProjectPath(db, input.projectId);
      if (!project.ok) return project;
      return await createArtifact(project.projectPath, input.name);
    },

    "volli:file-reveal": async (input: FilePathInput): Promise<RevealResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      const resolved = await resolveExternalFileTarget(scope.value, input.ticketId, input.relPath);
      if (!resolved.ok) return resolved;
      try {
        shell.showItemInFolder(resolved.value.filePath);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    "volli:file-watch": async (input: FilePathInput, sender: WebContents): Promise<Result> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      const resolved = await resolveSafePath(
        scope.value.projectPath,
        scope.value.worktreeRoot,
        input.relPath,
      );
      if (!resolved.ok) return resolved;
      const { source, filePath } = resolved.value;
      return manager.watch(
        sender,
        input.projectId,
        input.ticketId ?? null,
        input.relPath,
        source,
        dirname(filePath),
        basename(filePath),
        scope.value.projectPath,
      );
    },

    // No try/catch previously guarded this handler either — `manager.unwatch`
    // is synchronous teardown (close/clearTimeout calls), not expected to
    // throw. Under the envelope a throw here now yields `{ ok: false }` rather
    // than an unhandled IPC rejection: a deliberate hardening, not a behavior
    // this handler relied on.
    "volli:file-unwatch": (input: FilePathInput, sender: WebContents): Result => {
      manager.unwatch(sender, input.projectId, input.ticketId ?? null, input.relPath);
      return { ok: true };
    },

    "volli:dir-watch": async (input: DirPathInput, sender: WebContents): Promise<Result> => {
      // Main-checkout-scoped on purpose (CONCEPT #54): no ticket lookup, so an
      // expanded tree row can never drift onto a worktree copy of the repo.
      const project = resolveProjectPath(db, input.projectId);
      if (!project.ok) return project;
      const resolved = await resolveSafeDir(project.projectPath, input.relPath);
      if (!resolved.ok) return resolved;
      return dirManager.watch(
        sender,
        input.projectId,
        input.relPath,
        resolved.dirPath,
        project.projectPath,
      );
    },

    // Unwatch takes no path resolution at all: a collapsed row must be able to
    // drop its subscription even if the directory has since been deleted (which
    // is often exactly why it collapsed).
    "volli:dir-unwatch": (input: DirPathInput, sender: WebContents): Result => {
      dirManager.unwatch(sender, input.projectId, input.relPath);
      return { ok: true };
    },

    // The `/` picker's supply — templates AND skills, one fetch. Project-keyed
    // like the file index and for the same reason: `.volli` is self-gitignored,
    // so keying a ticket session's commands to its worktree would hide exactly
    // the templates the project author wrote (see `projectCommandsDir`). The
    // three reads are independent, and any one tier that exists but cannot be
    // read is still an error the composer says out loud.
    /**
     * Creates one `/command` (VC-111). The scope picks which of the two
     * directories the reader already merges it lands in — so a project command
     * shadows a personal one of the same name exactly as it always has, and
     * the collision this refuses is only WITHIN the chosen directory.
     */
    "volli:prompt-template-create": async (
      input: PromptTemplateCreateInput,
    ): Promise<PromptTemplateCreateResult> => {
      const project = getProjectById(db, input.projectId);
      if (!project) return { ok: false, error: "Unknown project" };
      return writePromptTemplate({
        dir:
          input.scope === "project" ? projectCommandsDir(project.path) : options.globalCommandsDir,
        name: input.name,
        description: input.description,
        body: input.body,
      });
    },

    "volli:prompt-templates": async (
      input: PromptTemplateIndexInput,
    ): Promise<PromptTemplateIndexResult> => {
      const project = getProjectById(db, input.projectId);
      if (!project) return { ok: false, error: "Unknown project" };
      const [loaded, skills] = await Promise.all([
        loadPromptTemplates({
          projectCommandsDir: projectCommandsDir(project.path),
          globalCommandsDir: options.globalCommandsDir,
        }),
        loadSkills({
          projectSkillsDir: projectSkillsDir(project.path),
          globalSkillsDir: options.globalSkillsDir,
        }),
      ]);
      if (!loaded.ok) return loaded;
      if (!skills.ok) return skills;
      // A Settings write may land while the two directories are being read.
      // Resolve only against the row current after that wait, so no response
      // can expose the policy snapshot that merely supplied the stable path.
      const currentProject = getProjectById(db, input.projectId);
      if (!currentProject) return { ok: false, error: "Unknown project" };
      // The picker offers what this project actually has. A `manual` skill IS
      // still offered here — withholding it from the model's index is the
      // whole point of that mode, and it stays typable by name; only `off`
      // removes a row. The Skills pane asks for the UNRULED list instead
      // (`ruled: false`): it edits the rules, so a skill set to `off` must
      // stay on its screen to be turned back on.
      return {
        ok: true,
        templates: [...loaded.templates],
        skills:
          input.ruled === false
            ? [...skills.skills]
            : [...applySkillModes(skills.skills, currentProject.skillModes ?? {})],
      };
    },
  };

  registerGuardedIpcHandlers(FILE_IPC, handlers);

  return { files: manager, dirs: dirManager };
}
