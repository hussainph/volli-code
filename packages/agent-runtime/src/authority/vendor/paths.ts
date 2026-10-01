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

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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

/** How many symlinks one resolution follows before it calls the path unresolvable, as `MAXSYMLINKS`. */
const MAX_LINKS = 32;

/**
 * The absolute, symlink-free path an operand denotes, spelled the way the
 * filesystem stores it, or undefined when no such path can exist.
 *
 * Undefined is a refusal, not an absence: a symlink cycle, an over-long
 * component, or an unreadable ancestor all mean the resolver cannot say what
 * file this is, and a caller that cannot say must not allow.
 *
 * Resolved one REAL component at a time, the way the kernel walks a path, and
 * that is the VC-45 fix. Upstream resolved a symlink's target lexically against
 * the link's own directory, so `x -> s/../LaunchAgents/x.plist` with `s ->
 * ~/Library/Caches` read as `<dir>/LaunchAgents/x.plist` — the `..` cancelled
 * `s` — while the kernel resolves `s` first and lands in `~/Library`. Here a
 * link's target is spliced back into the queue of components still to walk,
 * so `s` is followed before `..` is applied to where it led.
 *
 * A component that does not exist yet ends the filesystem walk; what follows
 * is appended lexically, because nothing that does not exist can be a link.
 *
 * The existing prefix is then spelled through `realpath.native`, which returns
 * the name as stored: case, Unicode case (`.sſh` is `.ssh` on APFS) and
 * normalization form all collapse to one spelling, so a policy comparing
 * components compares what the kernel compares.
 */
export function resolvePathForPolicy(path: string): string | undefined {
  const queue = resolve(path).split("/").filter(Boolean);
  let resolved = "/";
  let existing = true;
  let links = 0;
  while (queue.length > 0) {
    const component = queue.shift()!;
    if (component === ".") continue;
    if (component === "..") {
      resolved = dirname(resolved);
      continue;
    }
    const candidate = join(resolved, component);
    if (!existing) {
      resolved = candidate;
      continue;
    }
    let entry;
    try {
      entry = lstatSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      existing = false;
      resolved = candidate;
      continue;
    }
    if (!entry.isSymbolicLink()) {
      resolved = candidate;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) return undefined;
    let target: string;
    try {
      target = readlinkSync(candidate);
    } catch {
      /* v8 ignore next -- lstat reported a link an instant ago; readlink fails only if it vanished in between, and an unreadable link is an unresolvable path. */
      return undefined;
    }
    if (isAbsolute(target)) resolved = "/";
    queue.unshift(...target.split("/").filter(Boolean));
  }
  return spelledAsStored(resolved);
}

/** The longest existing prefix through `realpath.native`, with the rest appended. */
function spelledAsStored(path: string): string | undefined {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      missing.unshift(basename(current));
      current = dirname(current);
    }
  }
}
