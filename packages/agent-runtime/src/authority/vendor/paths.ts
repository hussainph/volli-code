/**
 * Filesystem path resolution for policy, ported from pi-automode.
 *
 * A policy decision is only as honest as the path it reads. `~/.zshrc`,
 * `./../../.zshrc`, and a symlink planted inside the workspace are the same
 * file, and a rule that compares raw operands sees three different ones. So
 * every operand is resolved here — to an absolute path, through symlinks —
 * before any rule looks at it.
 *
 * {@link resolvePathForPolicy} resolves a path that does not exist yet by
 * resolving its nearest existing ancestor and rejoining the missing segments.
 * That is the case that matters most: a `write` creating a new file has no
 * inode to canonicalize, and treating it as unresolvable would let every new
 * path be allowed by absence.
 *
 * See `./README.md` for the upstream revision and the divergences.
 */

import { readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/** The invoking user's home directory, read once, as upstream reads it. */
export const HOME = homedir();

/**
 * Resolve a tool's `path` argument the way the tool itself will.
 *
 * Deliberately does not expand `~` or `$HOME`: Pi's file tools resolve their
 * `path` with `path.resolve` against the workspace and nothing else, so
 * expanding here would hand the rules a path other than the one opened.
 */
export function resolveInputPath(cwd: string, value: string): string | undefined {
  const raw = value.trim();
  if (raw === "") return undefined;
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

/**
 * Resolve a shell operand, where `~` and `$HOME` are the shell's job to expand.
 *
 * Returns undefined for tokens that denote no location at all: the bare `-`
 * stdin/stdout convention, and anything beginning with `&`, which is a file
 * descriptor or a job-control operator the lexer left behind.
 */
export function shellPathTokenToPath(token: string, cwd: string): string | undefined {
  const trimmed = token.trim();
  if (trimmed === "" || trimmed === "-" || trimmed.startsWith("&")) return undefined;
  if (trimmed === "~" || trimmed === "$HOME" || trimmed === "${HOME}") return HOME;
  const expanded = trimmed.startsWith("~/")
    ? resolve(HOME, trimmed.slice(2))
    : trimmed.replace(/^\$(?:HOME|\{HOME\})(?=\/)/, HOME);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * The absolute, symlink-free path an operand denotes, or undefined when no such
 * path can exist.
 *
 * Undefined is a refusal, not an absence: a symlink cycle, an over-long
 * component, or an unreadable ancestor all mean the resolver cannot say what
 * file this is, and a caller that cannot say must not allow.
 */
export function resolvePathForPolicy(path: string): string | undefined {
  return resolveThroughLinks(resolve(path), new Set());
}

/**
 * Walk toward the root until something resolves, then rebuild what was missing.
 *
 * Termination does not rest on a root check: `readlinkSync("/")` reports
 * `EINVAL`, which is not one of the two codes that keep the walk going, so the
 * loop always stops at the filesystem root at the latest.
 */
function resolveThroughLinks(path: string, visited: Set<string>): string | undefined {
  let current = path;
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...missing);
    } catch {
      // Not canonicalizable as it stands; the next two branches say why.
    }
    let target: string;
    try {
      target = readlinkSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      missing.unshift(basename(current));
      current = dirname(current);
      continue;
    }
    if (visited.has(current)) return undefined;
    visited.add(current);
    return resolveThroughLinks(resolve(dirname(current), target, ...missing), visited);
  }
}
