/**
 * The capability axis: what a Session's tools can reach at all, as ONE policy
 * that every enforcement layer reads (VC-45 — slices 1 and 2 of the two-axis
 * authority rearchitecture).
 *
 * The plan's diagnosis was two layers enforcing the same operation and knowing
 * nothing of each other. The shell ran behind Seatbelt with reads allowed
 * machine-wide except the user's home, so it could read another user's `.ssh`;
 * the file tools ran behind a userspace guard that refused everything outside
 * the workspace, so they could not read a sibling repository. Same product, same
 * operation, an over-tight rule and an open hole. This module is the cure: the
 * answer is computed here, once, as data, and the layers only compile it.
 *
 * - **Reads are machine-wide minus a secrets denylist** — {@link HOME_SECRET_PATHS}
 *   under the user's home, every top-level dotfile there, other users' homes,
 *   the system keychains, and whatever the host names as its own private state
 *   (Volli's `userData`: the database, `mcp-credentials.json`, backups, every
 *   Session's sidecar and saved output). Carve-backs re-open exactly what the
 *   Session itself was handed inside a denied tree, such as its own saved tool
 *   output (VC-469).
 * - **Writes land in `writableRoots`** — the workspace, the git directory a
 *   Ticket worktree commits into, and whatever the project declared — minus the
 *   metadata carved out of every root ({@link writeCarveOut}). A secret is never
 *   writable, wherever the roots are.
 *
 * Three consumers, one policy. The authority gate's path rules
 * (`./authority-policy.ts`) judge a call against it; `ScopedExecutionEnv`'s
 * file guard judges every file-tool operation against it; and the same
 * environment compiles it into the Seatbelt profile the shell runs under. So
 * "the same answer whichever tool asks" is a property of the data rather than of
 * three hand-kept copies agreeing.
 *
 * Pure, like everything in this package. Resolving the policy — reading the
 * home directory, canonicalizing paths through symlinks, finding the git
 * directory a worktree points at — needs a filesystem and happens in
 * `@volli/agent-runtime`. What crosses into here is a {@link CapabilityPolicy} of
 * absolute, canonical paths.
 *
 * Two comparisons, and they are not interchangeable — the reasoning is
 * `./authority-policy.ts`'s case-folding note, restated where it now lives. A
 * test whose true answer is "denied" folds case, because APFS resolves `.SSH`
 * to `.ssh` and a deny-list must cover every spelling of itself. A test whose
 * true answer is "allowed" compares literally, because folding it would let a
 * genuinely distinct path on a case-sensitive volume read as inside a grant.
 */

/**
 * Whether a Session's tools run behind walls at all.
 *
 * - `off` — the runtime's own defaults: the shell runs as the user with the
 *   network reachable, and the file tools reach whatever the user can. Only the
 *   authority gate (when the project enforces it) stands in the way, and it
 *   cannot see into a shell command.
 * - `scoped` — the shell runs behind Seatbelt and the file tools behind a guard,
 *   both compiled from the one {@link CapabilityPolicy}. The network stays denied
 *   inside the sandbox: egress opens only together with the Tier 3 classifier
 *   (VC-28 v1), never before it — the plan's pairing rule.
 *
 * A separate dial from the enforcement posture, and deliberately so: the plan's
 * whole diagnosis was "one dial doing two jobs". Enforcement asks whether the
 * rule pack binds; containment asks what the environment permits. Both vendors
 * ship them apart (Codex's sandbox mode beside its approval policy, Claude
 * Code's sandbox beside its permission mode).
 */
export const CONTAINMENT_MODES = ["off", "scoped"] as const;

export type ContainmentMode = (typeof CONTAINMENT_MODES)[number];

/**
 * Locations under a home directory that hold credentials, tokens, history or
 * other people's data, relative to that home.
 *
 * Each entry denies its whole subtree (a file entry is a subtree of one).
 * Grouped by why it is here rather than alphabetically, so a reviewer can see
 * the category a new entry belongs to:
 *
 * - **Shell and tool dotfiles.** An rc file is where a token is `export`ed;
 *   history is where one was typed. Every top-level dotfile the home actually
 *   holds is denied too (the runtime enumerates them at attach), and these are
 *   named so they stay denied if they appear later. `.gitconfig` is among them:
 *   it can carry a credential in a URL rewrite, and a contained shell is handed
 *   the user's commit identity instead (`ScopedExecutionEnv`).
 * - **Credential directories** the plan names (`.ssh`, `.aws`, `.config`,
 *   `.pi`) and their peers.
 * - **Other agent tools' credential stores** — Claude Code, Codex, Gemini,
 *   Cursor, Continue, opencode and the rest. An agent that can read another
 *   agent's token can act as that agent.
 * - **macOS stores** — keychains, cookies, sandboxed-app containers, mail and
 *   messages, and `Application Support`, which is where Volli's own `userData`
 *   lives along with every other app's tokens and browser profiles.
 *
 * Deliberately NOT here: the toolchains that happen to live in dot-directories
 * (`.nvm`, `.cargo/bin`, `.rustup`, `.pyenv`, `.bun`, `.local/bin`), the package
 * stores (`Library/pnpm`, `Library/Caches`), Volli's own worktree home
 * (`.volli`), and the skills directory the skills index tells a Session to read
 * (`.agents`). Denying those would refuse the reads the plan opened reads FOR.
 */
export const HOME_SECRET_PATHS = [
  // Shell and tool dotfiles.
  ".netrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".git-credentials",
  ".gitconfig",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".mysql_history",
  ".sqlite_history",
  ".lesshst",
  ".viminfo",
  ".env",
  ".boto",
  ".s3cfg",
  ".pgpass",
  ".my.cnf",
  ".vault-token",
  ".dockercfg",
  ".Xauthority",
  // Credential directories.
  ".ssh",
  ".aws",
  ".config",
  ".pi",
  ".gnupg",
  ".docker",
  ".kube",
  ".azure",
  ".oci",
  ".password-store",
  ".terraform.d",
  ".subversion",
  ".gem/credentials",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  ".gradle/gradle.properties",
  ".local/share/keyrings",
  // Other agent tools' credential stores.
  ".claude",
  ".claude.json",
  ".codex",
  ".gemini",
  ".cursor",
  ".continue",
  ".factory",
  ".qwen",
  ".codeium",
  ".copilot",
  ".local/share/opencode",
  ".local/share/crush",
  ".local/share/amp",
  // macOS stores.
  "Library/Keychains",
  "Library/Application Support",
  "Library/Cookies",
  "Library/Containers",
  "Library/Group Containers",
  "Library/Mail",
  "Library/Messages",
  "Library/Safari",
  "Library/Accounts",
  "Library/HTTPStorages",
  "Library/IdentityServices",
] as const;

/** Machine-wide locations that hold credentials, outside any one home. */
export const SYSTEM_SECRET_PATHS = ["/Library/Keychains"] as const;

/**
 * Names carved out of every writable root by Seatbelt itself in a Scoped
 * Session, beyond the four the plan carves (VC-45 slice 2).
 *
 * `@anthropic-ai/sandbox-runtime` denies writes to these at any depth on every
 * macOS profile it builds, whatever the caller configures, because each one
 * changes what another tool runs the next time it starts: a shell profile, a
 * global git config, an editor's task runner, another agent's commands. The
 * kernel cannot be talked out of them, so the file tools carry the same list —
 * otherwise `edit .vscode/settings.json` would succeed where
 * `sed -i … .vscode/settings.json` failed, which is the two-layer disagreement
 * this module exists to end. `scoped-execution-env.test.ts` holds this list to
 * SRT's own exports, so an SRT bump that grows its list fails a test rather
 * than reopening the gap.
 */
export const SANDBOX_PROTECTED_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
] as const;

/** Directories SRT carves out of every writable root, at any depth. See {@link SANDBOX_PROTECTED_FILES}. */
export const SANDBOX_PROTECTED_DIRECTORIES = [
  ".vscode",
  ".idea",
  ".claude/commands",
  ".claude/agents",
] as const;

/**
 * The capability policy one attachment runs under, resolved.
 *
 * Every path is absolute and canonical — symlinks resolved, no trailing slash —
 * because both consumers compare components, and a policy that named
 * `/var/folders/…` while the kernel saw `/private/var/folders/…` would be two
 * policies.
 */
export interface CapabilityPolicy {
  /** Subtrees no tool may read or write. */
  readonly readDeny: readonly string[];
  /**
   * Subtrees carved back out of {@link readDeny} for reading only.
   *
   * Only an entry that lies inside some denied subtree means anything, and the
   * resolver keeps only those — so a grant can never contain a deny, and the
   * deepest match always decides (see {@link readDenial}). That is also exactly
   * what Seatbelt's own last-match-wins ordering computes for the profile this
   * compiles to, which is why the two layers cannot disagree about nesting.
   */
  readonly readAllow: readonly string[];
  /** Roots writes may land under, the Session workspace first. */
  readonly writableRoots: readonly string[];
  /**
   * Whether {@link SANDBOX_PROTECTED_FILES} and
   * {@link SANDBOX_PROTECTED_DIRECTORIES} are carved out too. True exactly when
   * the walls are Seatbelt's, which carves them whether asked to or not.
   */
  readonly sandboxCarveOuts: boolean;
}

/** Why the capability policy refused a path. Each maps onto one rule the gate can cite. */
export type CapabilityDenial =
  | "secret"
  | "outside-roots"
  | "git-metadata"
  | "volli-state"
  | "tool-config";

export type CapabilityVerdict =
  | { readonly outcome: "allow" }
  | {
      readonly outcome: "deny";
      readonly denial: CapabilityDenial;
      /** Written for the model, like every refusal: it names the path and says what to do instead. */
      readonly reason: string;
    };

const ALLOW: CapabilityVerdict = { outcome: "allow" };

/** The non-empty path components, compared as written. */
export function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function foldedSegments(path: string): string[] {
  return pathSegments(path).map((segment) => segment.toLowerCase());
}

function containsSegments(root: readonly string[], candidate: readonly string[]): boolean {
  return candidate.length >= root.length && root.every((part, index) => candidate[index] === part);
}

/**
 * Literal containment, for every test whose *true* answer is "allowed".
 *
 * `/ws-evil` is not inside `/ws`, and on a case-sensitive volume neither is
 * `/WS/secret`. Both paths must already be absolute and lexically resolved;
 * this compares components and probes nothing.
 */
export function containsPath(root: string, candidate: string): boolean {
  return containsSegments(pathSegments(root), pathSegments(candidate));
}

/**
 * Folded containment, for every test whose *true* answer is "denied": APFS
 * resolves `.SSH` to `.ssh`, so a guarded location covers every spelling of
 * itself.
 */
export function guardsPath(guarded: string, candidate: string): boolean {
  return containsSegments(foldedSegments(guarded), foldedSegments(candidate));
}

/** The deepest entry of `entries` that covers `path`, or undefined. */
function deepest(
  entries: readonly string[],
  path: string,
  covers: (entry: string, path: string) => boolean,
): string | undefined {
  let found: string | undefined;
  for (const entry of entries) {
    if (!covers(entry, path)) continue;
    if (found === undefined || pathSegments(entry).length > pathSegments(found).length) {
      found = entry;
    }
  }
  return found;
}

/**
 * The denied subtree `path` falls in, or undefined when it may be read.
 *
 * The deepest match decides, and a tie goes to the deny. With grants only ever
 * nested inside denies, that is the whole of the precedence: a Session's own
 * saved output inside Volli's `userData` is readable, and nothing else there is.
 */
export function readDenial(policy: CapabilityPolicy, path: string): string | undefined {
  const deny = deepest(policy.readDeny, path, guardsPath);
  if (deny === undefined) return undefined;
  const allow = deepest(policy.readAllow, path, containsPath);
  if (allow !== undefined && pathSegments(allow).length > pathSegments(deny).length) {
    return undefined;
  }
  return deny;
}

function secretVerdict(path: string, deny: string): CapabilityVerdict {
  return {
    outcome: "deny",
    denial: "secret",
    reason: `${path} is inside ${deny}, which holds credentials or another party's data, so no tool may read or write it. Do not reach for it another way; if the task needs what is there, ask the user.`,
  };
}

/** Whether `path` may be read under `policy`. */
export function capabilityRead(policy: CapabilityPolicy, path: string): CapabilityVerdict {
  const deny = readDenial(policy, path);
  return deny === undefined ? ALLOW : secretVerdict(path, deny);
}

/**
 * Whether the components below a `.git` name executable plumbing: `config` and
 * `config.worktree`, anything under `hooks`, a linked worktree's own
 * `worktrees/<name>/config.worktree`, and any `hooks` or `config` inside a
 * submodule's directory (`modules/<name…>/…` — a submodule's name may itself
 * contain slashes, so any depth counts).
 *
 * Only those. Everything else under `.git` — the index, refs, objects, logs —
 * is what `git commit` writes, and a Session that cannot write it cannot do its
 * job. Hooks and config are the paths ordinary git operation never writes and
 * the only ones that change what *later* commands do.
 *
 * Each clause is one pattern in {@link sandboxWriteCarveOuts}, read the way
 * Seatbelt reads a deny glob — the match and everything beneath it — so the
 * file tools and the kernel refuse the same paths.
 */
function isGitPlumbingTail(below: readonly string[]): boolean {
  const [head] = below;
  if (head === "hooks" || head === "config" || head === "config.worktree") return true;
  if (head === "worktrees") return below[2] === "config.worktree";
  if (head === "modules")
    return below.slice(2).some((part) => part === "hooks" || part === "config");
  return false;
}

/** Whether folded components hold a `.git` whose tail is plumbing. */
function holdsGitPlumbing(segments: readonly string[]): boolean {
  return segments.some(
    (segment, index) => segment === ".git" && isGitPlumbingTail(segments.slice(index + 1)),
  );
}

/** Whether `path` is git plumbing that changes what later commands run, at any depth. */
export function isGitPlumbingPath(path: string): boolean {
  return holdsGitPlumbing(foldedSegments(path));
}

/** True when a folded relative entry (`.claude/commands`) occurs as a run of segments in `segments`. */
function occursAt(segments: readonly string[], entry: string): boolean {
  const needle = entry.toLowerCase().split("/");
  for (let index = 0; index + needle.length <= segments.length; index += 1) {
    if (needle.every((part, offset) => segments[index + offset] === part)) return true;
  }
  return false;
}

type CarveOut = Exclude<CapabilityDenial, "secret" | "outside-roots">;

/**
 * Which carve-out `path` falls in, judged from inside one writable root.
 *
 * `scope` is the path's components below the root — or, for a root that IS a
 * git directory (the common directory a Ticket worktree commits into), below
 * its parent, so that root's own `.git` component is seen.
 */
function carveOutWithin(root: string, path: string, sandboxCarveOuts: boolean): CarveOut | null {
  const rootSegments = foldedSegments(root);
  const below = foldedSegments(path).slice(rootSegments.length);
  const scope = rootSegments.at(-1) === ".git" ? [".git", ...below] : below;
  if (holdsGitPlumbing(scope) || scope.includes(".gitmodules")) return "git-metadata";
  if (below[0] === ".volli") return "volli-state";
  if (!sandboxCarveOuts) return null;
  if (scope.some((segment) => (SANDBOX_PROTECTED_FILES as readonly string[]).includes(segment))) {
    return "tool-config";
  }
  return SANDBOX_PROTECTED_DIRECTORIES.some((entry) => occursAt(scope, entry))
    ? "tool-config"
    : null;
}

/**
 * Which metadata carve-out `path` falls in, or null when it is ordinary or
 * outside every root.
 *
 * The plan's four, carved out of every root: `.git/hooks` and `.git/config`
 * (with their submodule and worktree forms), `.gitmodules`, and `.volli/` at a
 * root's top. In a Scoped Session, Seatbelt's own list as well — see
 * {@link SANDBOX_PROTECTED_FILES}.
 *
 * Judged below each root that holds the path, and refused if any of them
 * carves it — exactly how the kernel reads one pattern set per root. A `.git`
 * and `.gitmodules` are matched at any depth below a root, as Seatbelt matches
 * them, because a nested repository's hooks run exactly like the top one's.
 * `.volli` is matched only at a root's top, the one place Volli keeps state.
 */
export function writeCarveOut(
  policy: Pick<CapabilityPolicy, "writableRoots" | "sandboxCarveOuts">,
  path: string,
): CarveOut | null {
  for (const root of policy.writableRoots) {
    if (!containsPath(root, path)) continue;
    const carveOut = carveOutWithin(root, path, policy.sandboxCarveOuts);
    if (carveOut !== null) return carveOut;
  }
  return null;
}

/**
 * {@link writeCarveOut} in the kernel's spelling: the deny globs one writable
 * root contributes to a Seatbelt profile.
 *
 * Kept beside the predicate it mirrors so the two change together. Each
 * pattern is read by `@anthropic-ai/sandbox-runtime` as a deny that covers its
 * match and everything beneath it. The patterns are rooted at `root` rather than
 * left as SRT's bare `**` globs because SRT resolves a relative glob against its
 * host process's working directory, which is `/` in a packaged app and the
 * repository in development — the same pattern would mean two different things.
 */
export function sandboxWriteCarveOuts(root: string, sandboxCarveOuts: boolean): string[] {
  const gitRoot = foldedSegments(root).at(-1) === ".git";
  const git = gitRoot ? [root, `${root}/**/.git`] : [`${root}/**/.git`];
  return [
    `${root}/.volli`,
    ...git.flatMap((dir) => [
      `${dir}/hooks`,
      `${dir}/config`,
      `${dir}/config.worktree`,
      `${dir}/worktrees/*/config.worktree`,
      `${dir}/modules/**/hooks`,
      `${dir}/modules/**/config`,
    ]),
    `${root}/**/.gitmodules`,
    ...(sandboxCarveOuts
      ? [...SANDBOX_PROTECTED_FILES, ...SANDBOX_PROTECTED_DIRECTORIES].map(
          (entry) => `${root}/**/${entry}`,
        )
      : []),
  ];
}

const CARVE_OUT_REASONS: Record<CarveOut, (path: string) => string> = {
  "git-metadata": (path) =>
    `Writing ${path} is not permitted; git hooks and config change what later commands run. Use git itself for ordinary repository changes.`,
  "volli-state": (path) =>
    `Writing ${path} is not permitted; .volli holds Volli's own state, not the project's.`,
  "tool-config": (path) =>
    `Writing ${path} is not permitted in a Scoped Session; it configures what another tool runs the next time it starts, so the sandbox carves it out of every writable root.`,
};

/**
 * Sinks a write may name that are not files at all.
 *
 * `2>/dev/null` turns up in ordinary build and test commands, so refusing it
 * would spend the Session's fallback budget on nothing — and Seatbelt's own
 * profile allows exactly these whatever the roots are.
 */
const DEVICE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"]);

/** Whether `path` is a device sink rather than a file a write could change. */
export function isDeviceSink(path: string): boolean {
  return DEVICE_SINKS.has(path) || containsPath("/dev/fd", path);
}

/** Whether `path` may be written under `policy`. */
export function capabilityWrite(policy: CapabilityPolicy, path: string): CapabilityVerdict {
  if (isDeviceSink(path)) return ALLOW;
  const deny = writeDenial(policy, path);
  if (deny !== undefined) return secretVerdict(path, deny);
  if (!policy.writableRoots.some((root) => containsPath(root, path))) {
    return {
      outcome: "deny",
      denial: "outside-roots",
      reason: `${path} is outside this Session's writable roots (${policy.writableRoots.join(", ")}); every write must land inside one of them.`,
    };
  }
  const carveOut = writeCarveOut(policy, path);
  if (carveOut !== null) {
    return { outcome: "deny", denial: carveOut, reason: CARVE_OUT_REASONS[carveOut](path) };
  }
  return ALLOW;
}

/**
 * The denied subtree a write to `path` would land in, or undefined.
 *
 * A read grant is not a write grant — a Session's own saved output is readable
 * and still not a place it may write — so only writable roots weigh against a
 * deny here, and only a root DEEPER than the deny: a project that declared
 * `~/.config/myapp` writable meant it, while a root laid over a whole home
 * (`~`) does not make `~/.ssh` writable. A tie goes to the deny. This is the
 * write half of Seatbelt's last-match-wins, given the profile emits a deny only
 * for a secret that lies inside a root.
 */
export function writeDenial(policy: CapabilityPolicy, path: string): string | undefined {
  const deny = deepest(policy.readDeny, path, guardsPath);
  if (deny === undefined) return undefined;
  const root = deepest(policy.writableRoots, path, containsPath);
  if (root !== undefined && pathSegments(root).length > pathSegments(deny).length) {
    return undefined;
  }
  return deny;
}
