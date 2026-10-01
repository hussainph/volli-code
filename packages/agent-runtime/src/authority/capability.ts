/**
 * One attachment's {@link CapabilityPolicy}, resolved against the machine
 * (VC-45).
 *
 * `@volli/shared` owns what the policy MEANS — the two denylist tiers, the
 * carve-outs, the verdicts — and may not touch a disk. Everything that needs
 * one happens here, once, at attach: the home directory is read for the
 * dotfiles it actually holds, the users' directory for the other homes, `Application
 * Support` for the browser and Electron credential stores it holds, a Ticket
 * worktree's `.git` file for the slices of the repository its commits need,
 * the denied trees for hard links, and every path is canonicalized through the
 * filesystem, so the gate and the kernel are handed the same strings.
 *
 * Resolved once rather than per call because both layers must agree, and the
 * kernel's profile is fixed per command from this same object. A dotfile
 * created after attach is the price, and the named lists in `@volli/shared` are
 * what keep the ones that matter covered whether or not they existed yet.
 */

import { lstatSync, opendirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  containsPath,
  HOME_CREDENTIAL_PATHS,
  HOME_PRIVATE_PATHS,
  pathSegments,
  SYSTEM_CREDENTIAL_PATHS,
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
   * The host's own data: Volli's `userData`, which holds the database and its
   * WAL, the policy and approvals, backups, and every Session's sidecar and
   * saved output. The runtime adds its own session data directory as well.
   * Private to READ — a person may approve a read of the database once — and
   * never writable: no root, grant or approval makes a change to it allowed.
   */
  privateRoots?: readonly string[];
  /** The host's own credential files, in the credential tier: `mcp-credentials.json`. */
  credentialPaths?: readonly string[];
  /**
   * The small set of live host files whose contents determine Volli's state or
   * authority: the database and SQLite sidecars, plus the MCP credential store.
   * Their device/inode identities are captured at attach so a pre-planted hard
   * link inside the workspace cannot make Seatbelt's path matching miss them.
   */
  criticalHostDataPaths?: readonly string[];
  /**
   * Read-only grants inside the private tier: this Session's own saved tool
   * output (VC-469), what the host exposes on purpose (the directory the
   * `volli` shim lives in), and the user's global git excludes and attributes
   * a contained git is pointed at. A grant that is a symlink at its own root
   * grants nothing: resolving it would hand the grant to wherever it points.
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
  /** `$XDG_CONFIG_HOME`, when it points somewhere other than `~/.config`. Defaults to the process's. */
  xdgConfigHome?: string;
  /** Source index entry limit; exceeded limits refuse attachment, never return a partial policy. */
  linkIndexBudget?: number;
  /** Writable-root alias walk entry limit. Defaults to `ALIAS_INDEX_BUDGET`. */
  aliasIndexBudget?: number;
  /** Combined source/alias indexing deadline. Defaults to `LINK_INDEX_TIMEOUT_MS`. */
  linkIndexTimeoutMs?: number;
}

/** Absolute, link-free and spelled as stored, or the lexical form when nothing resolves. */
function canonical(path: string): string {
  return resolvePathForPolicy(path) ?? resolve(path);
}

/**
 * A denied location in both its spellings: as named, with its parent resolved,
 * and as the target a link there resolves to. The gate canonicalizes every
 * path it judges, and Seatbelt matches the resolved vnode — so a `~/.config`
 * that links into a dotfiles repository is protected only if the repository's
 * copy is denied too.
 */
function bothSpellings(path: string): string[] {
  const named = join(canonical(dirname(resolve(path))), basename(path));
  const target = canonical(path);
  return target === named ? [named] : [named, target];
}

/** A grant's canonical root, or undefined when the root itself is a symlink. */
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

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A dotfile that is really a link to a directory is a dot-directory, judged by name. */
function linksToDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every top-level dotfile the home holds — a file or a link, never a
 * directory: rc files, histories, tokens. A dot-DIRECTORY is denied only when
 * it is named, because toolchains live in them and so do Volli's own worktrees
 * and the skills a Session is told to read.
 */
function homeDotfiles(home: string): string[] {
  return entriesOf(home)
    .filter((entry) => entry.name.startsWith(".") && !entry.isDirectory)
    .map((entry) => join(home, entry.name))
    .filter((path) => !linksToDirectory(path));
}

/** Where a platform keeps its users' homes, or undefined where this does not know. */
export function usersRootFor(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") return "/Users";
  if (platform === "linux") return "/home";
  return undefined;
}

/**
 * Every other user's home, enumerated rather than denied as one tree with this
 * home carved back, because a carve-back inside a deny inside a carve-back is a
 * nesting the kernel's last-match-wins ordering does not keep. `Shared` is the
 * macOS directory every user may read and write.
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

/** Chromium-family browsers whose profiles keep cookies, logins and the key that unlocks them. */
const CHROMIUM_ROOTS = [
  "Google/Chrome",
  "Google/Chrome Beta",
  "Google/Chrome Canary",
  "Chromium",
  "BraveSoftware/Brave-Browser",
  "Microsoft Edge",
  "Arc/User Data",
  "Vivaldi",
  "com.operasoftware.Opera",
] as const;

/** Files in a Chromium or Electron profile that hold credentials or the safeStorage key. */
const CHROMIUM_PROFILE_FILES = [
  "Cookies",
  "Network/Cookies",
  "Login Data",
  "Login Data For Account",
  "Web Data",
] as const;

const FIREFOX_PROFILE_FILES = ["cookies.sqlite", "logins.json", "key4.db", "key3.db"] as const;

/**
 * The credential files under `Application Support` that this machine holds,
 * enumerated so they can sit in the credential tier while the rest of
 * `Application Support` stays merely private: every app's `Local State` (the
 * Chromium/Electron safeStorage key) and cookie stores, every Chromium-family
 * browser profile's cookies and logins, every Firefox profile's.
 *
 * Existing files only, so the profile stays small. One created after attach is
 * still in the private tier, so it is still refused — only overridably.
 */
function applicationCredentials(home: string): string[] {
  const support = join(home, "Library", "Application Support");
  const found: string[] = [];
  const keep = (path: string) => {
    if (exists(path)) found.push(path);
  };
  for (const app of entriesOf(support).filter((entry) => entry.isDirectory)) {
    const root = join(support, app.name);
    keep(join(root, "Local State"));
    for (const file of CHROMIUM_PROFILE_FILES) keep(join(root, file));
  }
  for (const browser of CHROMIUM_ROOTS) {
    const root = join(support, browser);
    keep(join(root, "Local State"));
    for (const profile of entriesOf(root).filter((entry) => entry.isDirectory)) {
      for (const file of CHROMIUM_PROFILE_FILES) keep(join(root, profile.name, file));
    }
  }
  const firefox = join(support, "Firefox", "Profiles");
  for (const profile of entriesOf(firefox).filter((entry) => entry.isDirectory)) {
    for (const file of FIREFOX_PROFILE_FILES) keep(join(firefox, profile.name, file));
  }
  return found;
}

/** What a linked worktree's `.git` file says about where its repository lives. */
export interface WorktreeGit {
  /** The worktree's own administrative directory: `<common>/worktrees/<name>`. */
  gitDir: string;
  /** The repository's common git directory. */
  commonDir: string;
  /** The branch the worktree has checked out, or null when HEAD is detached. */
  branch: string | null;
}

/**
 * A Ticket worktree's repository, read from its `.git` file and the
 * `commondir` and `HEAD` beside the worktree's administrative directory.
 * Undefined for a Main checkout, whose `.git` is a directory inside the
 * workspace, and for anything that does not read as a linked worktree.
 */
export function worktreeGitOf(workspacePath: string): WorktreeGit | undefined {
  let pointer: string;
  try {
    pointer = readFileSync(join(workspacePath, ".git"), "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/mu.exec(pointer);
  if (match === null) return undefined;
  const gitDir = canonical(resolve(workspacePath, match[1]!.trim()));
  let common: string;
  try {
    common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
  } catch {
    return undefined;
  }
  let branch: string | null = null;
  try {
    const head = /^ref:\s*refs\/heads\/(.+)$/mu.exec(readFileSync(join(gitDir, "HEAD"), "utf8"));
    branch = head === null ? null : head[1]!.trim();
  } catch {
    branch = null;
  }
  return {
    gitDir,
    commonDir: canonical(isAbsolute(common) ? common : resolve(gitDir, common)),
    branch,
  };
}

/** The repository's common git directory for a Ticket worktree, as {@link worktreeGitOf} reads it. */
export function gitCommonDirOf(workspacePath: string): string | undefined {
  return worktreeGitOf(workspacePath)?.commonDir;
}

/**
 * The slices of a Ticket worktree's common git directory its commits need, and
 * no more (VC-45 review, S1).
 *
 * `objects/` (alternates carved out), the worktree's own administrative
 * directory (where its HEAD, index, logs and rebase state live; its
 * `commondir`, `gitdir` and `config.worktree` carved out), and its own branch's
 * ref, the lock git renames over it, and its reflog. Plus `packed-refs.lock`
 * alone: git 2.48 takes that lock on every ref update and prints an error
 * when it cannot, though it never renames it over `packed-refs` unless a ref
 * is being deleted — which the file itself, not writable, then refuses. A
 * stale lock left behind blocks the Main checkout's next ref deletion until
 * removed, and does nothing else. Not the Main checkout's HEAD or index, not
 * another worktree's, not `packed-refs`, not another branch: commit, amend and
 * a rebase of this branch onto its base all work; `git stash`, creating a
 * branch or tag, and `git gc` writing `packed-refs` do not, because each
 * writes state the Main checkout and every other worktree share.
 */
function worktreeRoots(git: WorktreeGit): string[] {
  const roots = [
    join(git.commonDir, "objects"),
    git.gitDir,
    join(git.commonDir, "packed-refs.lock"),
  ];
  if (git.branch !== null) {
    const ref = join(git.commonDir, "refs", "heads", git.branch);
    roots.push(ref, `${ref}.lock`, join(git.commonDir, "logs", "refs", "heads", git.branch));
  }
  return roots;
}

/**
 * Literal paths no write may reach in this workspace (VC-45 review, B3):
 * a Ticket worktree's `.git` FILE, which names the directory every later git
 * command trusts, and a Main checkout's other worktrees' administrative
 * directories, whose HEAD and index belong to other Sessions.
 */
function protectedPathsOf(workspace: string): string[] {
  let entry;
  try {
    entry = lstatSync(join(workspace, ".git"));
  } catch {
    return [];
  }
  return entry.isDirectory() ? [join(workspace, ".git", "worktrees")] : [join(workspace, ".git")];
}

/** Finite attach cost; an incomplete index refuses attachment rather than opening a wall. */
const LINK_INDEX_BUDGET = 65_536;
const ALIAS_INDEX_BUDGET = 250_000;
const LINK_INDEX_TIMEOUT_MS = 5_000;

function fileIdentity(path: string): { identity: string; path: string } | undefined {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.nlink < 2) return undefined;
    return { identity: `${entry.dev}:${entry.ino}`, path };
  } catch {
    return undefined;
  }
}

/**
 * Walk once, without following symlinks or materializing a huge directory
 * listing. Overlapping roots are visited only once. Source permission errors
 * can be skipped: the user (and hence the sandbox) cannot read those files.
 * An unlistable granted root instead refuses attachment, as do exhausted entry
 * and wall-clock bounds. No caller ever receives a partially scanned policy.
 */
function walkLinkedFiles(
  roots: readonly string[],
  limit: number,
  deadline: number,
  sources: boolean,
  found: (identity: string, path: string) => void,
): void {
  let remaining = limit;
  const checkTime = () => {
    if (performance.now() >= deadline) {
      throw new Error("Capability hard-link index time limit exceeded; refusing attachment.");
    }
  };
  const check = () => {
    checkTime();
    if (remaining-- <= 0) {
      throw new Error("Capability hard-link index entry limit exceeded; refusing attachment.");
    }
  };
  const visit = (path: string): void => {
    check();
    let entry;
    try {
      entry = lstatSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === "ENOENT" ||
        code === "ENOTDIR" ||
        (sources && (code === "EACCES" || code === "EPERM"))
      )
        return;
      throw error;
    }
    if (entry.isFile() && entry.nlink > 1) found(`${entry.dev}:${entry.ino}`, path);
    if (!entry.isDirectory()) return;
    let directory;
    try {
      directory = opendirSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (sources && (code === "EACCES" || code === "EPERM")) return;
      throw error;
    }
    try {
      for (let child = directory.readSync(); child !== null; child = directory.readSync()) {
        visit(join(path, child.name));
      }
    } finally {
      directory.closeSync();
    }
  };
  const distinct = unique(roots);
  for (const root of distinct.filter(
    (inner) => !distinct.some((outer) => outer !== inner && containsPath(outer, inner)),
  ))
    visit(root);
  checkTime();
}

/**
 * Multiply-linked credential files and home dotfiles, indexed by device/inode.
 * Private directories are not walked: aliases to their non-credential files
 * remain a documented private-tier limit. Credential indexing is complete or
 * attachment is refused, never silently truncated at the budget.
 */
function linkedFilesIn(
  roots: readonly string[],
  limit: number,
  deadline: number,
): Record<string, string> {
  const linked: Record<string, string> = {};
  walkLinkedFiles(roots, limit, deadline, true, (identity, path) => {
    linked[identity] = path;
  });
  return linked;
}

/** Every granted name for a protected inode, including runtime and worktree git roots. */
function protectedAliases(
  roots: readonly string[],
  credentials: Readonly<Record<string, string>>,
  critical: Readonly<Record<string, string>>,
  limit: number,
  deadline: number,
): { credentials: string[]; critical: string[] } {
  const aliases: { credentials: string[]; critical: string[] } = { credentials: [], critical: [] };
  if (Object.keys(credentials).length === 0 && Object.keys(critical).length === 0) return aliases;
  walkLinkedFiles(roots, limit, deadline, false, (identity, path) => {
    if (credentials[identity] !== undefined && path !== credentials[identity])
      aliases.credentials.push(path);
    if (critical[identity] !== undefined && path !== critical[identity])
      aliases.critical.push(path);
  });
  return aliases;
}

/** Whether `inner` lies strictly inside `outer`. */
function strictlyInside(outer: string, inner: string): boolean {
  return containsPath(outer, inner) && pathSegments(inner).length > pathSegments(outer).length;
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/** The credential entries of `HOME_CREDENTIAL_PATHS` that live under `~/.config`, rebased onto another config home. */
function configCredentials(configHome: string): string[] {
  return HOME_CREDENTIAL_PATHS.filter((entry) => entry.startsWith(".config/")).map((entry) =>
    join(configHome, entry.slice(".config/".length)),
  );
}

/** One attachment's capability policy. */
export function resolveCapabilityPolicy(input: CapabilityResolution): CapabilityPolicy {
  const home = canonical(input.home ?? homedir());
  const workspace = canonical(input.workspacePath);
  const git = worktreeGitOf(workspace);
  const writableRoots = unique([
    workspace,
    ...(git === undefined ? [] : worktreeRoots(git)),
    ...(input.writableRoots ?? []).map(canonical),
    ...(input.runtimeRoots ?? []).map(canonical),
  ]);
  const xdg = input.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const configHome =
    xdg !== undefined && isAbsolute(xdg) && canonical(xdg) !== join(home, ".config")
      ? canonical(xdg)
      : undefined;
  const credentialDeny = unique(
    [
      ...HOME_CREDENTIAL_PATHS.map((entry) => join(home, entry)),
      ...(configHome === undefined ? [] : configCredentials(configHome)),
      ...applicationCredentials(home),
      ...SYSTEM_CREDENTIAL_PATHS,
      ...(input.credentialPaths ?? []),
    ].flatMap(bothSpellings),
  );
  const hostDataDeny = unique((input.privateRoots ?? []).flatMap(bothSpellings));
  const privateDeny = unique(
    [
      ...HOME_PRIVATE_PATHS.map((entry) => join(home, entry)),
      ...homeDotfiles(home),
      ...(configHome === undefined ? [] : [configHome]),
      ...otherHomes(home, input.usersRoot ?? usersRootFor(process.platform)),
      ...hostDataDeny,
    ].flatMap(bothSpellings),
  );
  const deadline = performance.now() + (input.linkIndexTimeoutMs ?? LINK_INDEX_TIMEOUT_MS);
  const deniedLinks = linkedFilesIn(
    [...credentialDeny, ...homeDotfiles(home)],
    input.linkIndexBudget ?? LINK_INDEX_BUDGET,
    deadline,
  );
  const credentialLinks = Object.fromEntries(
    Object.entries(deniedLinks).filter(([, path]) =>
      credentialDeny.some((deny) => containsPath(deny, path)),
    ),
  );
  const criticalLinks = Object.fromEntries(
    (input.criticalHostDataPaths ?? []).map(canonical).flatMap((path) => {
      const file = fileIdentity(path);
      return file === undefined ? [] : [[file.identity, file.path]];
    }),
  );
  const aliases = protectedAliases(
    writableRoots,
    credentialLinks,
    criticalLinks,
    input.aliasIndexBudget ?? ALIAS_INDEX_BUDGET,
    deadline,
  );
  // These names belong to the credential tier too, not merely a shell-specific
  // deny: every layer judges the same paths. SRT's denyWrite also protects their
  // unlink/create operations and every ancestor against rename/relink escapes.
  credentialDeny.push(...aliases.credentials);
  const denies = [...credentialDeny, ...privateDeny];
  // A grant means something only inside (or at) a private entry, and never
  // inside a credential one: no grant reaches key material. And none may sit
  // inside a deny that is itself strictly inside another grant — the kernel
  // re-applies such a deny after every grant, which would revoke the inner
  // grant while the gate's deepest-match kept it.
  // A root inside the host's data is one nobody may write, so it grants no
  // read there either: only the runtime's own grants reach into that data.
  const candidates = unique([
    ...(input.grants ?? []).flatMap((grant) => grantRoot(grant) ?? []),
    ...writableRoots.filter((root) => !hostDataDeny.some((deny) => containsPath(deny, root))),
  ]).filter(
    (grant) =>
      privateDeny.some((deny) => containsPath(deny, grant)) &&
      !credentialDeny.some((deny) => containsPath(deny, grant)),
  );
  const readAllow = candidates.filter(
    (inner) =>
      !candidates.some(
        (outer) =>
          outer !== inner &&
          denies.some((deny) => strictlyInside(outer, deny) && containsPath(deny, inner)),
      ),
  );
  return {
    credentialDeny,
    privateDeny,
    hostDataDeny,
    readAllow,
    writableRoots,
    protectedPaths: protectedPathsOf(workspace),
    sandboxCarveOuts: input.sandboxCarveOuts,
    hostDataAliases: unique(aliases.critical),
    linkedFiles: { ...deniedLinks, ...criticalLinks },
  };
}
