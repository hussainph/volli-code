/**
 * `.worktreeinclude` parsing + the copy step (worktree-support §6). Fresh
 * worktrees are materialized by `git worktree add`, which carries every TRACKED
 * file. This step transports the files git DOESN'T carry — gitignored/untracked
 * local config (`.env`, harness local settings) — so an agent's checkout is
 * actually runnable. It reads a repo-root `.worktreeinclude` (the de-facto
 * standard Conductor and Claude Code converged on), layered over built-in
 * defaults.
 *
 * ── Pattern subset (gitignore-style; implemented here, no new deps) ──
 *  - One pattern per line; blank lines and `#`-comment lines are ignored;
 *    surrounding whitespace is trimmed.
 *  - `!pattern` negates (re-excludes) a previously included path.
 *  - A trailing `/` matches a directory and everything beneath it.
 *  - A leading `/`, or ANY internal `/`, anchors the pattern to the repo root;
 *    a pattern with no slash matches its basename at ANY depth.
 *  - `*` matches a run of non-`/` characters; `?` a single non-`/` character;
 *    a doubled star matches across `/` (any number of path segments), and a
 *    doubled star followed by a slash matches an optional leading path prefix.
 *
 * Evaluation is gitignore's LAST-MATCH-WINS over [defaults, then file lines],
 * so a `!` line in the file suppresses a built-in default. A path with no
 * match is not copied.
 *
 * ── Copy semantics ──
 * The MAIN checkout is walked; each matched file is copied to the worktree only
 * if it doesn't already exist there — which automatically skips tracked files
 * (already materialized) and never overwrites. Symlinks are copied AS symlinks
 * (recreated, never followed outside the root). Every source location and
 * destination is required inside the project root / worktree root respectively.
 *
 * Performance note: matching an unanchored basename pattern is depth-agnostic,
 * so the walk visits every directory it does not prune, and never follows
 * symlinked dirs. Two kinds are pruned: `.git`, which is git's own metadata and
 * can never be transported, and the {@link DEFAULT_PRUNED_DIRS} below, any of
 * which a `.worktreeinclude` line can ask for back by name. The walk and every copy run
 * through `fs/promises` — this step executes on Electron main, and the
 * synchronous version froze every window for the walk's whole duration on a
 * large Main checkout (VC-16's rainbow wheel).
 */
import { existsSync, readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { DEPENDENCY_AND_BUILD_DIRS } from "@volli/shared";

import { isInside } from "./paths";

/** Applied even with no `.worktreeinclude` file; a `!` line in the file can suppress them. */
export const DEFAULT_INCLUDE_PATTERNS = [".env*", ".claude/settings.local.json"] as const;

/**
 * Directory names the walk does not descend into unless a `.worktreeinclude`
 * line names one — the shared per-ecosystem dependency/build list
 * ({@link DEPENDENCY_AND_BUILD_DIRS}), which the file index's fallback walk and
 * the Project Files watcher read too, so the three cannot drift apart.
 *
 * `node_modules` is the member this walk measured, and it earns the place twice
 * over. It is the dominant cost of the walk on a JS checkout — the seconds
 * VC-16 reported — and it is also a correctness trap: `.env*` is an unanchored
 * default, packages ship `.env.example` files, and a depth-agnostic walk
 * transported other people's samples into the agent's checkout. Both halves of
 * that hold for a Python `.venv` or a Go `vendor` too, and the cost was simply
 * never measured here because the checkout under the walk was this repository
 * (VC-160's bias audit).
 *
 * Deliberately NOT a general ignore list. A directory that is merely large is
 * still walked: these are the ones whose contents are, by construction, not
 * ours — see the membership rule in `walk-prune.ts`.
 */
export const DEFAULT_PRUNED_DIRS = DEPENDENCY_AND_BUILD_DIRS;

const INCLUDE_FILE_NAME = ".worktreeinclude";

interface CompiledPattern {
  negate: boolean;
  regex: RegExp;
  raw: string;
}

/** Regex metacharacters that must be escaped when a literal glob char maps to a regex. */
const REGEX_SPECIAL = new Set([
  ".",
  "*",
  "+",
  "?",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "\\",
]);

/** Translates the glob subset into a regex body (path separators stay literal `/`). */
function translateGlob(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += REGEX_SPECIAL.has(ch) ? "\\" + ch : ch;
    }
  }
  return out;
}

/** Compiles one raw line into a matcher over POSIX-style relative paths, or `null` for blank/comment lines. */
export function compileIncludePattern(rawLine: string): CompiledPattern | null {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;

  let body = trimmed;
  let negate = false;
  if (body.startsWith("!")) {
    negate = true;
    body = body.slice(1);
  }
  const leadingSlash = body.startsWith("/");
  if (leadingSlash) body = body.slice(1);
  const dirOnly = body.endsWith("/");
  if (dirOnly) body = body.replace(/\/+$/, "");

  const anchored = leadingSlash || body.includes("/");
  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A dir pattern must be a strict prefix of the file path; a file pattern
  // matches the path itself, or (if it named a directory) anything beneath it.
  const suffix = dirOnly ? "/.+$" : "(?:/.+)?$";
  return { negate, regex: new RegExp(prefix + translateGlob(body) + suffix), raw: trimmed };
}

/**
 * The effective ordered pattern list for a project: defaults first, then the
 * `.worktreeinclude` lines (so a file `!` line overrides a default). Reads the
 * file if present; a missing file yields the defaults alone.
 */
export function loadIncludePatterns(projectRoot: string): CompiledPattern[] {
  const patterns: CompiledPattern[] = [];
  for (const raw of DEFAULT_INCLUDE_PATTERNS) {
    const compiled = compileIncludePattern(raw);
    if (compiled) patterns.push(compiled);
  }
  const filePath = join(projectRoot, INCLUDE_FILE_NAME);
  if (existsSync(filePath)) {
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      const compiled = compileIncludePattern(line);
      if (compiled) patterns.push(compiled);
    }
  }
  return patterns;
}

/** Last-match-wins over the ordered patterns; unmatched paths are excluded. */
export function isIncluded(patterns: readonly CompiledPattern[], relPath: string): boolean {
  let included = false;
  for (const pattern of patterns) {
    if (pattern.regex.test(relPath)) included = !pattern.negate;
  }
  return included;
}

/** POSIX-style relative path from `root` to `full` (always `/`-separated for matching). */
function toPosixRelative(root: string, full: string): string {
  return relative(root, full).split(/[\\/]/).join("/");
}

interface WalkEntry {
  full: string;
  relPath: string;
  isSymlink: boolean;
}

/**
 * The directory names to skip for THIS project, given its effective patterns:
 * {@link DEFAULT_PRUNED_DIRS} minus every segment a non-negated pattern names.
 *
 * Only a non-negated line takes a directory off the list. A `!node_modules/`
 * line can only ever exclude, so descending for it would buy nothing and make
 * writing the line slower than omitting it — the one reading of it that is
 * certainly not what its author meant.
 */
function prunedDirNames(patterns: readonly CompiledPattern[]): ReadonlySet<string> {
  const pruned = new Set<string>(DEFAULT_PRUNED_DIRS);
  for (const pattern of patterns) {
    if (pattern.negate) continue;
    for (const segment of pattern.raw.split("/")) pruned.delete(segment);
  }
  return pruned;
}

/** Recursively yields every file/symlink under `root`, skipping `.git` + `pruned` and never following symlinked dirs. */
async function* walkFiles(
  root: string,
  dir: string,
  pruned: ReadonlySet<string>,
): AsyncGenerator<WalkEntry> {
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    if (dirent.name === ".git") continue;
    const full = join(dir, dirent.name);
    if (dirent.isSymbolicLink()) {
      yield { full, relPath: toPosixRelative(root, full), isSymlink: true };
    } else if (dirent.isDirectory()) {
      if (pruned.has(dirent.name)) continue;
      yield* walkFiles(root, full, pruned);
    } else if (dirent.isFile()) {
      yield { full, relPath: toPosixRelative(root, full), isSymlink: false };
    }
  }
}

export interface CopyResult {
  /** POSIX relative paths actually copied into the worktree (excludes skips). */
  copied: string[];
}

/**
 * Copies every matched, git-uncarried file from the main checkout into the
 * worktree. Existing destination files are skipped (never overwritten, which
 * covers tracked files). Symlinks are recreated as symlinks. Every source
 * location and destination is guarded inside its root.
 */
export async function copyIncludedFiles(
  projectRoot: string,
  worktreeRoot: string,
): Promise<CopyResult> {
  const patterns = loadIncludePatterns(projectRoot);
  const pruned = prunedDirNames(patterns);
  const copied: string[] = [];

  for await (const entry of walkFiles(projectRoot, projectRoot, pruned)) {
    if (!isIncluded(patterns, entry.relPath)) continue;

    // Source guard: the file's LOCATION (not a symlink's target) must sit
    // inside the project root — the walk guarantees this, asserted defensively.
    if (!isInside(projectRoot, dirname(entry.full)) && dirname(entry.full) !== projectRoot) {
      throw new Error(`Refusing to copy from outside the project root: ${entry.full}`);
    }

    const dest = join(worktreeRoot, entry.relPath);
    // Destination guard: reject any `../escape` that would land outside the worktree.
    if (!isInside(worktreeRoot, dest)) {
      throw new Error(`Refusing to copy to outside the worktree root: ${dest}`);
    }
    // Never overwrite (skips tracked files). `lstat` not `existsSync`: a
    // dangling symlink git may have materialized would read "absent" through
    // `existsSync` (it follows the link), then the `symlink` below throws
    // EEXIST and fails the whole ensure — lstat sees the link itself.
    if ((await lstatQuiet(dest)) !== null) continue;

    await mkdir(dirname(dest), { recursive: true });
    if (entry.isSymlink) {
      // Recreate the link verbatim — never read through it, so a link pointing
      // outside the root transports the link, not the external contents.
      await symlink(await readlink(entry.full), dest);
    } else if ((await lstat(entry.full)).isFile()) {
      await copyFile(entry.full, dest);
    }
    copied.push(entry.relPath);
  }

  return { copied };
}

/** `lstat` that answers `null` for a missing path instead of throwing ENOENT. */
async function lstatQuiet(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}
