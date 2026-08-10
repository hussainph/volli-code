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
 * What a shell operand denotes, when the answer is not always a path.
 *
 * Three outcomes rather than two, because "this token is not a location" and
 * "this token is a location I cannot compute" are different facts and the
 * caller acts on them differently. Collapsing them is how `~someone` came to
 * resolve to `<workspace>/~someone` and be allowed.
 */
export type ShellOperand =
  | { kind: "path"; path: string }
  | { kind: "no-location" }
  | { kind: "unresolvable"; reason: string };

const NO_LOCATION: ShellOperand = { kind: "no-location" };

/**
 * A `$` that begins a variable reference, wherever it sits in the token.
 *
 * Discriminating on what follows the `$` rather than on position is what lets
 * `build$SUFFIX` and `out$DIR/y` be caught — the shell expands those to
 * somewhere this layer never judged — while `^foo$`, `s/foo$/bar/` and
 * `cost $5` stay ordinary text. A trailing `$`, or one before a digit or most
 * punctuation, names no variable. `(` counts, because `$(…)` is command
 * substitution — the shell expands that too.
 */
const VARIABLE_REFERENCE = /\$[A-Za-z_{(]/;

/**
 * Resolve a shell operand, where `~` and `$HOME` are the shell's job to expand.
 *
 * `no-location` covers tokens that denote nothing: the bare `-` stdin/stdout
 * convention, and anything beginning with `&`, which is a file descriptor or a
 * job-control operator the lexer left behind.
 *
 * `unresolvable` covers the two expansions only a real shell can perform.
 * Another user's home cannot be derived without inventing a path, and an
 * arbitrary variable cannot be read from an environment this process does not
 * have. Whether that is fatal depends on where the operand sits, which is the
 * caller's question, not this function's.
 *
 * Quoting is already lost by the time a token arrives, so `'$literal'` — which
 * a shell would not expand — reads the same as `$literal` and is reported
 * unresolvable too. Over-refusal, in the one direction that is safe.
 */
export function shellPathTokenToPath(token: string, cwd: string): ShellOperand {
  const trimmed = token.trim();
  if (trimmed === "" || trimmed === "-" || trimmed.startsWith("&")) return NO_LOCATION;
  if (trimmed === "~" || trimmed === "$HOME" || trimmed === "${HOME}") {
    return { kind: "path", path: HOME };
  }
  if (trimmed.startsWith("~/")) return { kind: "path", path: resolve(HOME, trimmed.slice(2)) };
  if (trimmed.startsWith("~")) {
    return {
      kind: "unresolvable",
      reason: `"${trimmed}" names another user's home directory, which cannot be resolved.`,
    };
  }
  const expanded = trimmed.replace(/^\$(?:HOME|\{HOME\})(?=\/)/, HOME);
  if (VARIABLE_REFERENCE.test(expanded)) {
    return {
      kind: "unresolvable",
      reason: `"${trimmed}" expands through a variable only the shell can read; name the paths literally so they can be checked.`,
    };
  }
  return { kind: "path", path: isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded) };
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
