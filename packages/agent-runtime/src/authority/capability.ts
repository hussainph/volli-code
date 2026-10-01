/**
 * One attachment's {@link CapabilityPolicy}, resolved against the machine
 * (VC-45).
 *
 * `@volli/shared` owns what the policy MEANS — the secrets denylist, the
 * carve-outs, the verdicts — and may not touch a disk. Everything that needs
 * one happens here, once, at attach: the home directory is read for the
 * dotfiles it actually holds, the users' directory for the other homes it
 * actually holds, a Ticket worktree's `.git` file for the directory its commits
 * land in, and every path is canonicalized through symlinks, so the gate and the
 * kernel are handed the same strings to compare.
 *
 * Resolved once rather than per call because both layers must agree, and the
 * kernel's profile is fixed per command from this same object: a per-call
 * re-resolution in the gate alone would be a second policy. A dotfile created
 * after attach is the price, and the named list in `HOME_SECRET_PATHS` is what
 * keeps the ones that matter covered whether or not they existed yet.
 */

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  containsPath,
  HOME_SECRET_PATHS,
  pathSegments,
  SYSTEM_SECRET_PATHS,
  type CapabilityPolicy,
} from "@volli/shared";
import { resolvePathForPolicy } from "./vendor/paths";

export interface CapabilityResolution {
  /** The Session workspace; always the first writable root. */
  workspacePath: string;
  /** The project's declared writable roots, as its policy stated them. */
  writableRoots?: readonly string[];
  /**
   * Further writable roots the runtime itself owns for this attachment — a
   * contained shell's scratch directory. Never policy, so never pinned.
   */
  runtimeRoots?: readonly string[];
  /**
   * The host's own private state, denied to every tool: Volli's `userData`,
   * which holds the database, `mcp-credentials.json`, backups, and every
   * Session's sidecar and saved output. The runtime adds its own session data
   * directory whether or not the host names it.
   */
  privateRoots?: readonly string[];
  /**
   * Read-only grants inside a denied tree: this Session's own saved tool output
   * (VC-469), and whatever the host exposes to its Sessions on purpose (the
   * directory the `volli` shim lives in). A grant that is a symlink at its own
   * root grants nothing, for `resolveReadableRoot`'s reason: resolving it would
   * hand the grant to wherever the link points.
   */
  grants?: readonly string[];
  /** Whether Seatbelt's own carve-outs apply — true exactly for a Scoped Session. */
  sandboxCarveOuts: boolean;
  /** The user's home. Defaults to the process's. */
  home?: string;
  /**
   * Where users' homes live, so the others can be denied outright. Defaults to
   * the platform's (`/Users`, `/home`); a home outside it denies no siblings.
   */
  usersRoot?: string;
}

/** Absolute and symlink-free, or the lexical form when nothing on the way resolves. */
function canonical(path: string): string {
  return resolvePathForPolicy(path) ?? resolve(path);
}

/**
 * A denied location in both its spellings: as named, with its parent resolved,
 * and as the target a link there resolves to.
 *
 * Both, because the two layers see different ones. The gate canonicalizes every
 * path it judges, and Seatbelt matches the resolved vnode — so a `~/.config`
 * that links into a dotfiles repository is only protected if the repository's
 * copy is denied too. The name is kept beside it so a link that is swapped
 * after attach still reaches nothing by its familiar path.
 */
function bothSpellings(path: string): string[] {
  const named = join(canonical(dirname(resolve(path))), basename(path));
  const target = canonical(path);
  return target === named ? [named] : [named, target];
}

/**
 * A grant's canonical root, or undefined when the root itself is a symlink.
 *
 * The parent is canonicalized and the last component re-joined only after
 * `lstat` says it is a real directory, or nothing at all yet — a Session's own
 * saved output does not exist until its first long result.
 */
function grantRoot(path: string): string | undefined {
  try {
    if (lstatSync(path).isSymbolicLink()) return undefined;
  } catch {
    // Absent: the grant covers it once it exists.
  }
  return join(canonical(dirname(resolve(path))), basename(path));
}

/** The names in a directory, or none when it cannot be listed. */
function entriesOf(directory: string): { name: string; isDirectory: boolean }[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    return [];
  }
}

/**
 * Every top-level dotfile the home holds — a file or a link, never a
 * directory. The plan's "home dotfiles": rc files, histories, tokens. A
 * dot-DIRECTORY is denied only when it is named, because toolchains live in
 * them (`.nvm`, `.rustup`, `.cargo/bin`) and so do Volli's own worktrees
 * (`.volli`) and the skills a Session is told to read (`.agents`).
 */
function homeDotfiles(home: string): string[] {
  return entriesOf(home)
    .filter((entry) => entry.name.startsWith(".") && !entry.isDirectory)
    .map((entry) => join(home, entry.name))
    .filter((path) => !linksToDirectory(path));
}

/** A dotfile that is really a link to a directory is a dot-directory, judged by name. */
function linksToDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Where a platform keeps its users' homes, or undefined where this does not know. */
export function usersRootFor(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") return "/Users";
  if (platform === "linux") return "/home";
  return undefined;
}

/**
 * Every other user's home, denied outright — the hole the old profile left by
 * denying only the current user's. Enumerated rather than denied as one tree
 * with this home carved back, because a carve-back inside a deny inside a
 * carve-back is a nesting the kernel's last-match-wins ordering does not keep.
 * `Shared` is the macOS directory every user may read and write.
 */
function otherHomes(home: string, usersRoot: string | undefined): string[] {
  if (usersRoot === undefined || dirname(home) !== usersRoot) return [];
  return entriesOf(usersRoot)
    .filter(
      (entry) =>
        entry.isDirectory &&
        entry.name !== basename(home) &&
        entry.name !== "Shared" &&
        !entry.name.startsWith("."),
    )
    .map((entry) => join(usersRoot, entry.name));
}

/**
 * The directory a Ticket worktree's commits land in: the main repository's
 * `.git`, named by the `gitdir:` line of the worktree's `.git` file and the
 * `commondir` file beside it. Undefined for a Main checkout, whose `.git` is
 * already inside the workspace, and for anything that does not read as a
 * linked worktree.
 *
 * It is a writable root because a worktree that cannot write its objects and
 * refs cannot commit — the old boundary's quiet breakage. Its hooks and config
 * are carved out like every root's.
 */
export function gitCommonDirOf(workspacePath: string): string | undefined {
  let pointer: string;
  try {
    pointer = readFileSync(join(workspacePath, ".git"), "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/mu.exec(pointer);
  if (match === null) return undefined;
  const gitDir = resolve(workspacePath, match[1]!.trim());
  let common: string;
  try {
    common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
  } catch {
    return undefined;
  }
  return canonical(isAbsolute(common) ? common : resolve(gitDir, common));
}

/** Whether `inner` lies strictly inside `outer`. */
function strictlyInside(outer: string, inner: string): boolean {
  return containsPath(outer, inner) && pathSegments(inner).length > pathSegments(outer).length;
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/** One attachment's capability policy. */
export function resolveCapabilityPolicy(input: CapabilityResolution): CapabilityPolicy {
  const home = canonical(input.home ?? homedir());
  const workspace = canonical(input.workspacePath);
  const commonDir = gitCommonDirOf(workspace);
  const writableRoots = unique([
    workspace,
    ...(commonDir === undefined ? [] : [commonDir]),
    ...(input.writableRoots ?? []).map(canonical),
    ...(input.runtimeRoots ?? []).map(canonical),
  ]);
  const readDeny = unique(
    [
      ...HOME_SECRET_PATHS.map((entry) => join(home, entry)),
      ...homeDotfiles(home),
      ...otherHomes(home, input.usersRoot ?? usersRootFor(process.platform)),
      ...SYSTEM_SECRET_PATHS,
      ...(input.privateRoots ?? []),
    ].flatMap(bothSpellings),
  );
  // A grant means something only inside a denied tree, and must never contain
  // one: the kernel re-applies a deny nested inside a grant AFTER every grant,
  // which would silently revoke a grant nested inside that deny in turn. So a
  // root inside a secret store is readable, and a root over one (a whole home)
  // simply is not a grant — the secrets under it stay denied, which is right.
  const readAllow = unique(
    [...(input.grants ?? []).flatMap((grant) => grantRoot(grant) ?? []), ...writableRoots].filter(
      (grant) =>
        readDeny.some((deny) => strictlyInside(deny, grant)) &&
        !readDeny.some((deny) => containsPath(grant, deny)),
    ),
  );
  return { readDeny, readAllow, writableRoots, sandboxCarveOuts: input.sandboxCarveOuts };
}
