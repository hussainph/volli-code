/**
 * All Node fs work for the global-artifacts + `@file` rework
 * (docs/plans/global-artifacts.md): the whole-project file index (git
 * ls-files, gitignore-respecting, `.volli/artifacts/` force-included),
 * worktree-aware read/write/reveal of any repo file, the single project-scoped
 * `.volli/artifacts/` create flow, and a per-open-tab debounced file watch.
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
import { existsSync, promises as fsp, watch as fsWatch } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, sep } from "node:path";
import { shell } from "electron";
import type { WebContents } from "electron";
import type Database from "better-sqlite3";
import {
  artifactBaseName,
  classifyFileKind,
  errorMessage,
  FILE_CHANNELS,
  FILE_IPC,
  imageMimeType,
  isArtifactRelPath,
  isSafeRelPath,
  isValidNewArtifactName,
  projectArtifactsDir,
  VOLLI_ARTIFACTS_REL_DIR,
  VOLLI_GITIGNORE_CONTENT,
  volliDir,
  withMarkdownExtension,
} from "@volli/shared";
import type {
  ArtifactCreateInput,
  ArtifactCreateResult,
  FileChangedEvent,
  FileContent,
  FileIndexInput,
  FileIndexResult,
  FileIpcChannel,
  FileKind,
  FilePathInput,
  FileReadResult,
  FileSource,
  FileWriteInput,
  FileWriteResult,
  IndexedFile,
  Result,
  RevealResult,
  VolliIpcEvent,
} from "@volli/shared";
import type { DbHandle } from "./data-ipc";
import { getProjectById } from "./db/projects-repo";
import { getTicketRow } from "./db/tickets-repo";
import type { TicketRow } from "./db/tickets-repo";
import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "./ipc-registry";
import type { IpcHandlerTable } from "./ipc-registry";

const execFileAsync = promisify(execFile);

/** Text-read cap (decision #7): utf8 files past this are truncated + flagged. */
const TEXT_CAP_BYTES = 1024 * 1024;
/** Images past this are treated as binary (a data-URI that large is not worth inlining). */
const IMAGE_CAP_BYTES = 10 * 1024 * 1024;
/** File-index entry cap (~20k, decision on `truncated`). */
const INDEX_CAP = 20_000;
/** Directory names never descended into by the fallback walk (and the git list already excludes `.volli`). */
const FALLBACK_SKIP_DIRS = new Set([".git", "node_modules", ".volli"]);

// ---- low-level fs helpers ----------------------------------------------------

/** The `code` of a Node `ErrnoException`-shaped value, or undefined. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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

/** Whether a project-relative path is (or is under) `.volli/` — always resolved against the MAIN checkout. */
function isVolliRelPath(relPath: string): boolean {
  return relPath === ".volli" || relPath.startsWith(".volli/");
}

/**
 * The resolved root + source for a relPath (decision #6): `.volli/**` always
 * resolves to the MAIN checkout; any other path resolves to the ticket's live
 * worktree when one is given, else the main checkout.
 */
function resolveRootFor(
  projectPath: string,
  worktreeRoot: string | null,
  relPath: string,
): { root: string; source: FileSource } {
  if (worktreeRoot !== null && !isVolliRelPath(relPath)) {
    return { root: worktreeRoot, source: "worktree" };
  }
  return { root: projectPath, source: "main" };
}

/**
 * SEAM (global-artifacts decision #6): a ticket's live worktree root, or `null`
 * to resolve against the main checkout. Reads the first-class `worktree_path`
 * column (migration 003) and confirms the directory exists on disk. No infra
 * populates `worktree_path` yet — worktree creation is future work (see the
 * cwd comment in pty.ts) — so in practice this ALWAYS returns null today and
 * every repo path resolves to the main checkout. When worktree automation
 * lands and begins writing `worktree_path`, resolution starts honoring it here
 * with no other change to this module.
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

/** Runs both path-safety layers, returning the resolved absolute path + its source, or a typed error. */
async function resolveSafePath(
  projectPath: string,
  worktreeRoot: string | null,
  relPath: string,
): Promise<{ ok: true; value: ResolvedFile } | { ok: false; error: string }> {
  if (!isSafeRelPath(relPath)) return { ok: false, error: "Invalid file path" };
  const { root, source } = resolveRootFor(projectPath, worktreeRoot, relPath);
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

/**
 * The whole-project file index the `@` picker ranks over (decision #3): the
 * git file list (gitignore-respecting; fallback to a bounded walk when git
 * isn't usable) plus a force-included walk of `.volli/artifacts/`
 * (`artifact: true`). Capped at ~20k entries — artifacts come first so they
 * survive truncation.
 */
export async function buildFileIndex(
  projectPath: string,
  indexCap: number = INDEX_CAP,
): Promise<{ files: IndexedFile[]; truncated: boolean }> {
  const gitFiles = await gitListFiles(projectPath);
  const repoRelPaths =
    gitFiles ??
    (await walkFiles(projectPath, { skipDirNames: FALLBACK_SKIP_DIRS, limit: indexCap }));
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
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Writes markdown content (utf8) to a resolved file (decision #7): markdown-only
 * (main enforces the extension), same worktree-aware resolution as read, and an
 * `expectedMtime` conflict guard — a mismatch (or a vanished file) is a typed
 * error rather than a silent clobber. Resolves with the fresh on-disk mtime so
 * the renderer can rebase its conflict guard.
 */
export async function writeFile(
  projectPath: string,
  worktreeRoot: string | null,
  relPath: string,
  content: string,
  expectedMtime?: number,
): Promise<FileWriteResult> {
  if (classifyFileKind(relPath) !== "markdown") {
    return { ok: false, error: "Only markdown files can be edited" };
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
      return { ok: false, error: errorMessage(error) };
    }
  }
  const resolved = await resolveSafePath(projectPath, worktreeRoot, relPath);
  if (!resolved.ok) return resolved;
  const { filePath } = resolved.value;
  try {
    if (expectedMtime !== undefined) {
      let currentMtime: number;
      try {
        currentMtime = (await fsp.stat(filePath)).mtimeMs;
      } catch {
        return { ok: false, error: "File no longer exists on disk" };
      }
      if (currentMtime !== expectedMtime) {
        return { ok: false, error: "File changed on disk since it was opened" };
      }
    }
    await fsp.writeFile(filePath, content, "utf8");
    const stat = await fsp.stat(filePath);
    return { ok: true, mtime: stat.mtimeMs };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
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

interface FileWatchSubscription {
  webContents: WebContents;
  projectId: string;
  /** The project's MAIN checkout path — used to recreate a wiped `.volli` watch dir on re-arm. */
  projectPath: string;
  relPath: string;
  source: FileSource;
  /** The watched directory (the file's parent) and the file's basename to filter dir events by. */
  dir: string;
  base: string;
  watcher: ReturnType<typeof fsWatch> | null;
  debounceTimer: NodeJS.Timeout | null;
  onDestroyed: () => void;
  /** Guards against overlapping re-arms. */
  reArming: boolean;
  /** Pending bounded-retry timer for a missing watch dir (cleared on teardown). */
  retryTimer: NodeJS.Timeout | null;
}

/**
 * Watches one open file tab and broadcasts a debounced `volli:file-changed`
 * event to the subscribing window only (window-scoped, same stance as
 * PtyManager). Watches the file's PARENT directory and filters events by
 * basename so an atomic replace (temp-write + rename, how most editors save)
 * still fires — reusing the ArtifactWatchManager re-arm/debounce pattern.
 * One subscription per `(webContents, projectId, ticketId, relPath)`.
 */
export class FileWatchManager {
  private readonly subs = new Map<string, FileWatchSubscription>();

  constructor(private readonly debounceMs: number = WATCH_DEBOUNCE_MS) {}

  private keyFor(
    webContents: WebContents,
    projectId: string,
    ticketId: string | null,
    relPath: string,
  ): string {
    return `${webContents.id}:${projectId}:${ticketId ?? ""}:${relPath}`;
  }

  /** Idempotent: watching an already-watched tab is a no-op. `dir`/`base`/`source`/`projectPath` come from the caller's resolution. */
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
    if (this.subs.has(key)) return { ok: true };
    if (webContents.isDestroyed()) return { ok: true };

    const sub: FileWatchSubscription = {
      webContents,
      projectId,
      projectPath,
      relPath,
      source,
      dir,
      base,
      watcher: null,
      debounceTimer: null,
      onDestroyed: () => this.teardown(key),
      reArming: false,
      retryTimer: null,
    };
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
    webContents.once("destroyed", sub.onDestroyed);
    return { ok: true };
  }

  private scheduleBroadcast(sub: FileWatchSubscription): void {
    if (sub.debounceTimer !== null) clearTimeout(sub.debounceTimer);
    sub.debounceTimer = setTimeout(() => {
      sub.debounceTimer = null;
      if (sub.webContents.isDestroyed()) return;
      const payload: FileChangedEvent = {
        projectId: sub.projectId,
        relPath: sub.relPath,
        source: sub.source,
      };
      sub.webContents.send("volli:file-changed" satisfies VolliIpcEvent, payload);
    }, this.debounceMs);
  }

  private wireWatcher(key: string, sub: FileWatchSubscription): void {
    sub.watcher = fsWatch(sub.dir, (_eventType, filename) => {
      // The watched dir was deleted-and-recreated: re-arm onto the new inode.
      if (!existsSync(sub.dir)) {
        this.reArm(key, sub);
        return;
      }
      // fs.watch reports the basename (or null on some platforms/coalesced
      // events); a null filename can't be filtered, so broadcast conservatively.
      if (filename === null || filename === sub.base) this.scheduleBroadcast(sub);
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
  private reArm(key: string, sub: FileWatchSubscription): void {
    if (sub.reArming) return;
    if (this.subs.get(key) !== sub) return; // torn down while the event was queued
    sub.reArming = true;
    sub.watcher?.close();
    sub.watcher = null;
    this.attemptReArm(key, sub, 0);
  }

  /** Whether the watched dir lives inside the project's `.volli` tree (ours to recreate). */
  private isUnderVolliTree(sub: FileWatchSubscription): boolean {
    const root = volliDir(sub.projectPath);
    return sub.dir === root || sub.dir.startsWith(root + sep);
  }

  /** Recreates a wiped `.volli` watch dir (best-effort). `attemptReArm` re-checks existence after. */
  private async ensureVolliWatchDir(sub: FileWatchSubscription): Promise<void> {
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
  private attemptReArm(key: string, sub: FileWatchSubscription, attempt: number): void {
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
  private finishReArm(key: string, sub: FileWatchSubscription, attempt: number): void {
    if (this.subs.get(key) !== sub) return; // torn down while queued
    if (existsSync(sub.dir)) {
      try {
        this.wireWatcher(key, sub);
      } catch {
        this.teardown(key);
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
    if (!sub.webContents.isDestroyed()) {
      const payload: FileChangedEvent = {
        projectId: sub.projectId,
        relPath: sub.relPath,
        source: sub.source,
      };
      sub.webContents.send("volli:file-changed" satisfies VolliIpcEvent, payload);
    }
  }

  unwatch(
    webContents: WebContents,
    projectId: string,
    ticketId: string | null,
    relPath: string,
  ): void {
    this.teardown(this.keyFor(webContents, projectId, ticketId, relPath));
  }

  private teardown(key: string): void {
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

/**
 * The main-repo path plus the ticket's worktree root (the seam) for a file
 * request. `ticketId` is optional; when given it's checked against `projectId`
 * (defense-in-depth — a mismatched pair is rejected, not trusted).
 */
async function resolveFileScope(
  db: Database.Database,
  projectId: string,
  ticketId: string | undefined,
): Promise<
  { ok: true; projectPath: string; worktreeRoot: string | null } | { ok: false; error: string }
> {
  const project = resolveProjectPath(db, projectId);
  if (!project.ok) return project;
  if (ticketId === undefined)
    return { ok: true, projectPath: project.projectPath, worktreeRoot: null };
  const row = getTicketRow(db, ticketId);
  if (!row) return { ok: false, error: "Unknown ticket" };
  if (row.project_id !== projectId)
    return { ok: false, error: "Ticket does not belong to project" };
  return {
    ok: true,
    projectPath: project.projectPath,
    worktreeRoot: await worktreeRootFromRow(row),
  };
}

/**
 * Registers every `volli:file-*` / `volli:artifact-create` handler through the
 * shared guard→body→envelope registry (issue #98): `FILE_IPC` (@volli/shared)
 * supplies the descriptor table (validators + invalid-request messages) and
 * `registerGuardedIpcHandlers` applies guard → body → try/catch; this module
 * supplies only the handler bodies below. When the db failed to open, every
 * channel instead resolves with a typed `{ ok: false, error }`
 * (`registerDegradedIpcHandlers(FILE_CHANNELS, …)`) — same degraded-DB stance
 * as `registerDataIpcHandlers`. Returns the watch manager; watchers are
 * otherwise self-cleaning on window `destroyed`/explicit unwatch.
 */
export function registerFileIpcHandlers(handle: DbHandle): FileWatchManager {
  const manager = new FileWatchManager();

  if (!handle.ok) {
    registerDegradedIpcHandlers(FILE_CHANNELS, handle.error);
    return manager;
  }

  const db = handle.db;

  const handlers: IpcHandlerTable<FileIpcChannel> = {
    "volli:file-index": async (input: FileIndexInput): Promise<FileIndexResult> => {
      const project = resolveProjectPath(db, input.projectId);
      if (!project.ok) return project;
      const { files, truncated } = await buildFileIndex(project.projectPath);
      return { ok: true, files, truncated };
    },

    "volli:file-read": async (input: FilePathInput): Promise<FileReadResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      return await readFile(scope.projectPath, scope.worktreeRoot, input.relPath);
    },

    "volli:file-write": async (input: FileWriteInput): Promise<FileWriteResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      return await writeFile(
        scope.projectPath,
        scope.worktreeRoot,
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
      return await revealFile(scope.projectPath, scope.worktreeRoot, input.relPath);
    },

    "volli:file-watch": async (input: FilePathInput, sender: WebContents): Promise<Result> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      const resolved = await resolveSafePath(scope.projectPath, scope.worktreeRoot, input.relPath);
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
        scope.projectPath,
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
  };

  registerGuardedIpcHandlers(FILE_IPC, handlers);

  return manager;
}
