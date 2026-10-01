/**
 * The capability axis: what a Session's tools can reach at all, as ONE policy
 * that every enforcement layer reads (VC-45 — slices 1 and 2 of the two-axis
 * authority rearchitecture).
 *
 * The plan's diagnosis was two layers enforcing the same operation and knowing
 * nothing of each other. The shell ran behind Seatbelt with reads allowed
 * machine-wide except the user's home, so it could read another user's `.ssh`;
 * the file tools ran behind a userspace guard that refused everything outside
 * the workspace, so they could not read a sibling repository. This module is
 * the cure: the answer is computed here, once, as data, and the layers compile
 * it.
 *
 * - **Reads are machine-wide minus a denylist in two tiers.** The *credential*
 *   tier ({@link HOME_CREDENTIAL_PATHS}, keychains, browser cookie and login
 *   stores, the host's credential file) is key material: a read of it is the
 *   credential. The *private* tier ({@link HOME_PRIVATE_PATHS}, every top-level
 *   home dotfile, other users' homes, the host's own data) is other people's or
 *   other programs' state that a person might reasonably let a Session read.
 *   Carve-backs re-open exactly what the Session itself was handed inside the
 *   private tier, such as its own saved tool output (VC-469) and its workspace.
 * - **Writes land in `writableRoots`** minus the metadata carved out of every
 *   root ({@link writeCarveOut}) and the literal paths the resolver protects
 *   ({@link CapabilityPolicy.protectedPaths}). A credential is never writable.
 *
 * Three consumers, one policy. The authority gate's path rules
 * (`./authority-policy.ts`) judge a call against it; `ScopedExecutionEnv`'s
 * file guard judges every file-tool operation against it; and the same
 * environment compiles it into the Seatbelt profile the shell runs under.
 *
 * WHAT "THE SAME ANSWER" MEANS, honestly. Between the file guard and Seatbelt
 * it means the same verdict for the same file, under every spelling the kernel
 * resolves — case variants, Unicode case and normalization forms, the
 * `/System/Volumes/Data` firmlink — because the runtime canonicalizes paths
 * through the filesystem before they reach here, and the comparisons below fold
 * what canonicalization cannot reach. Two seams remain and are named where they
 * live: a hard link to a credential that already exists is invisible to
 * Seatbelt (the file guard and gate catch the ones the resolver indexed), and
 * the file guard checks before it opens (slice 8). The gate's view of a SHELL
 * command is weaker still: it reads the operands a lexer can see, and a path
 * hidden in a variable, `$(…)` or a script never reaches it. Only a Scoped
 * Session has the kernel behind it.
 *
 * Pure, like everything in this package. Resolving the policy — reading the
 * home directory, canonicalizing paths, finding the git directory a worktree
 * points at — happens in `@volli/agent-runtime`.
 */

/**
 * Whether a Session's tools run behind walls at all.
 *
 * - `off` — the runtime's own defaults: the shell runs as the user with the
 *   network reachable, and the file tools reach whatever the user can. Only the
 *   authority gate (when the project enforces it) stands in the way, and it
 *   sees a shell command only as far as a lexer can.
 * - `scoped` — the shell runs behind Seatbelt and the file tools behind a guard,
 *   both compiled from the one {@link CapabilityPolicy}. The network stays denied
 *   inside the sandbox: egress opens only together with the Tier 3 classifier
 *   (VC-28 v1), never before it — the plan's pairing rule.
 *
 * A separate dial from the enforcement posture, and deliberately so: the plan's
 * whole diagnosis was "one dial doing two jobs". Enforcement asks whether the
 * rule pack binds; containment asks what the environment permits. A person can
 * pick walls without rules (`enforcement: "off"`, `containment: "scoped"`), and
 * both vendors ship the two apart (Codex's sandbox mode beside its approval
 * policy, Claude Code's sandbox beside its permission mode).
 */
export const CONTAINMENT_MODES = ["off", "scoped"] as const;

export type ContainmentMode = (typeof CONTAINMENT_MODES)[number];

/**
 * Credential material under a home directory, relative to it: keys, tokens,
 * and the files that hold them. The *credential* tier.
 *
 * Narrow on purpose. A read here IS the credential, so this list is what no
 * person's "yes" reaches — `path.credentials` is never overridable, because
 * credentials never enter the model's context; everything that is merely
 * private belongs in {@link HOME_PRIVATE_PATHS}, behind an ordinary approval.
 * Directories are listed whole only where any file in them can be a key
 * (`.ssh`, `.gnupg`, `.password-store`); elsewhere the specific file is named
 * and its directory sits in the private tier.
 */
export const HOME_CREDENTIAL_PATHS = [
  // Keys and key stores.
  ".ssh",
  ".gnupg",
  ".password-store",
  ".ollama/id_ed25519",
  // Token and password files.
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".yarnrc.yml",
  ".pypirc",
  ".pgpass",
  ".my.cnf",
  ".boto",
  ".s3cfg",
  ".vault-token",
  ".dockercfg",
  ".Xauthority",
  ".aws/credentials",
  ".aws/sso",
  ".aws/cli",
  ".azure",
  ".oci",
  ".docker/config.json",
  ".kube/config",
  ".gem/credentials",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  ".gradle/gradle.properties",
  ".terraform.d/credentials.tfrc.json",
  ".composer/auth.json",
  ".bundle/config",
  ".dbt/profiles.yml",
  ".cache/huggingface/token",
  ".config/gh/hosts.yml",
  ".config/gcloud/credentials.db",
  ".config/gcloud/access_tokens.db",
  ".config/gcloud/legacy_credentials",
  ".config/hub",
  ".config/github-copilot",
  // Platform CLIs.
  ".fly",
  ".supabase/access-token",
  ".railway/config.json",
  ".expo/state.json",
  ".wrangler/config",
  "Library/Preferences/.wrangler",
  // Other agent tools' sign-ins.
  ".pi/agent/auth.json",
  ".claude/.credentials.json",
  ".claude.json",
  ".codex/auth.json",
  ".gemini/oauth_creds.json",
  ".qwen/oauth_creds.json",
  ".continue/config.json",
  ".continue/config.yaml",
  ".local/share/opencode/auth.json",
  ".local/share/keyrings",
  // macOS credential stores.
  "Library/Keychains",
  "Library/Cookies",
  "Library/HTTPStorages",
  "Library/Accounts",
  "Library/Containers/com.apple.Safari/Data/Library/Cookies",
] as const;

/**
 * Private state under a home directory, relative to it: the *private* tier.
 *
 * Not key material, but other programs' and other people's data — shell
 * profiles and history, the whole of `~/.config`, other agents' directories,
 * and the macOS stores where apps keep theirs (`Application Support`, where
 * Volli's own `userData` lives). Every top-level dotfile the home actually
 * holds is added by the resolver too.
 *
 * Deliberately NOT here: the toolchains that live in dot-directories (`.nvm`,
 * `.cargo/bin`, `.rustup`, `.pyenv`, `.bun`, `.local/bin`), the package stores
 * (`Library/pnpm`, `Library/Caches`), Volli's own worktree home (`.volli`), and
 * the skills directory the skills index tells a Session to read (`.agents`).
 */
export const HOME_PRIVATE_PATHS = [
  // Shell and tool dotfiles.
  ".gitconfig",
  ".yarnrc",
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
  // Configuration directories.
  ".config",
  ".aws",
  ".docker",
  ".kube",
  ".terraform.d",
  ".subversion",
  ".supabase",
  ".railway",
  ".expo",
  ".wrangler",
  ".dbt",
  ".ollama",
  // Other agent tools' homes.
  ".pi",
  ".claude",
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
  "Library/Application Support",
  "Library/Containers",
  "Library/Group Containers",
  "Library/Mail",
  "Library/Messages",
  "Library/Safari",
  "Library/IdentityServices",
] as const;

/** Machine-wide credential stores, outside any one home. */
export const SYSTEM_CREDENTIAL_PATHS = ["/Library/Keychains"] as const;

/**
 * Names carved out of every writable root by Seatbelt itself in a Scoped
 * Session, beyond the ones the plan carves (VC-45 slice 2).
 *
 * `@anthropic-ai/sandbox-runtime` denies writes to these on every macOS
 * profile it builds, whatever the caller configures, because each one changes
 * what another tool runs the next time it starts. The kernel cannot be talked
 * out of them, so the file tools carry the same list — otherwise
 * `edit .vscode/settings.json` would succeed where `sed -i` failed.
 * `scoped-execution-env.test.ts` holds this list to SRT's own exports.
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
 * Every path is absolute and canonical — symlinks resolved, spelled as the
 * filesystem stores it, no trailing slash — because both consumers compare
 * components.
 */
export interface CapabilityPolicy {
  /** Credential material: never read, never written, whatever else is granted. */
  readonly credentialDeny: readonly string[];
  /** The private tier: refused unless a grant at least as deep re-opens it. */
  readonly privateDeny: readonly string[];
  /**
   * The host's own data — Volli's `userData`: its database and WAL, its policy
   * and approvals, its stored MCP credentials, every Session's sidecar and
   * saved output. Read as private (each entry is in {@link privateDeny} too, so
   * a person may let a Session read the database once); WRITTEN as hard as a
   * credential, whatever root or approval says otherwise. An approval that
   * reached here could let a Session edit its own approvals or policy.
   */
  readonly hostDataDeny: readonly string[];
  /**
   * Subtrees carved back out of {@link privateDeny} for reading.
   *
   * Only an entry inside or equal to some private entry means anything, and
   * the resolver keeps only those, never one inside a credential entry. The
   * deepest match decides, and a grant wins a tie with a private entry — a
   * workspace that IS `~/.pi` reads its own tree — while a credential entry
   * inside that grant stays denied. That is also what Seatbelt's
   * last-match-wins computes for the profile this compiles to.
   */
  readonly readAllow: readonly string[];
  /** Roots writes may land under, the Session workspace first. */
  readonly writableRoots: readonly string[];
  /**
   * Literal paths the resolver found that must not be written however they are
   * reached: a Ticket worktree's `.git` file (which names the git directory
   * every later git command trusts), a Main checkout's other worktrees'
   * administrative directories, and the like. Each denies its subtree.
   */
  readonly protectedPaths: readonly string[];
  /**
   * Whether {@link SANDBOX_PROTECTED_FILES} and
   * {@link SANDBOX_PROTECTED_DIRECTORIES} are carved out too. True exactly when
   * the walls are Seatbelt's, which carves them whether asked to or not.
   */
  readonly sandboxCarveOuts: boolean;
  /**
   * Literal names inside the workspace that share an inode with one of the
   * host's critical live files. Seatbelt matches paths rather than inodes, so
   * these names are explicit write denials in every command profile.
   */
  readonly hostDataAliases: readonly string[];
  /**
   * Hard links into the denylist the resolver indexed, as `"<device>:<inode>"`
   * to the denied path that file also has. A second name for a credential is
   * the credential; Seatbelt matches names and cannot see this, so the file
   * guard and the gate translate a multiply-linked file through here.
   */
  readonly linkedFiles: Readonly<Record<string, string>>;
}

/**
 * Which tier a denied path fell in. `host-data` is a write-only tier: a read of
 * the host's data is `private`, a change to it is `host-data`.
 */
export type DenyTier = "credential" | "host-data" | "private";

/** Why the capability policy refused a path. Each maps onto one rule the gate can cite. */
export type CapabilityDenial =
  | DenyTier
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

/** A denied entry and the tier it belongs to. */
export interface Denial {
  readonly entry: string;
  readonly tier: DenyTier;
}

const ALLOW: CapabilityVerdict = { outcome: "allow" };

/**
 * The firmlink every macOS path under `/` is also reachable through. The kernel
 * resolves `/System/Volumes/Data/Users/x/.ssh` to the same vnode as
 * `/Users/x/.ssh`, and a filesystem realpath keeps the long spelling, so the
 * comparisons below strip it.
 */
export const DATA_VOLUME_PREFIX = "/System/Volumes/Data";

function dealias(path: string): string {
  return path === DATA_VOLUME_PREFIX
    ? "/"
    : path.startsWith(`${DATA_VOLUME_PREFIX}/`)
      ? path.slice(DATA_VOLUME_PREFIX.length)
      : path;
}

/** The non-empty path components, compared as written. */
export function pathSegments(path: string): string[] {
  return dealias(path)
    .split("/")
    .filter((segment) => segment.length > 0);
}

/**
 * One component folded the way the deny side compares it: Unicode case folding
 * across normalization forms, and then some.
 *
 * APFS compares names case-insensitively and normalization-insensitively, and
 * folds beyond ASCII — `.sſh` (U+017F) names `.ssh`. `toLowerCase` alone does
 * not fold `ſ`; going through upper case does, and NFD collapses composed and
 * decomposed spellings. This over-folds in places APFS would not (fullwidth
 * forms, `ß`), which can only widen a deny-list — the safe direction. The
 * runtime canonicalizes existing paths through the filesystem before they
 * reach here; this covers what canonicalization cannot reach, a name that does
 * not exist yet.
 */
export function foldSegment(segment: string): string {
  return segment.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD");
}

function foldedSegments(path: string): string[] {
  return pathSegments(path).map(foldSegment);
}

function containsSegments(root: readonly string[], candidate: readonly string[]): boolean {
  return candidate.length >= root.length && root.every((part, index) => candidate[index] === part);
}

/**
 * Literal containment, for every test whose *true* answer is "allowed".
 *
 * `/ws-evil` is not inside `/ws`, and on a case-sensitive volume neither is
 * `/WS/secret`. Both paths must already be absolute and lexically resolved;
 * this compares components and probes nothing. The data-volume firmlink is the
 * one alias it sees through.
 */
export function containsPath(root: string, candidate: string): boolean {
  return containsSegments(pathSegments(root), pathSegments(candidate));
}

/** Folded containment, for every test whose *true* answer is "denied". */
export function guardsPath(guarded: string, candidate: string): boolean {
  return containsSegments(foldedSegments(guarded), foldedSegments(candidate));
}

function depth(path: string): number {
  return pathSegments(path).length;
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
    if (found === undefined || depth(entry) > depth(found)) found = entry;
  }
  return found;
}

/**
 * The denied entry `path` falls in, or undefined when it may be read.
 *
 * A credential entry always wins: no grant reaches into key material. In the
 * private tier the deepest match decides, and a grant wins a tie.
 */
export function readDenial(policy: CapabilityPolicy, path: string): Denial | undefined {
  const credential = deepest(policy.credentialDeny, path, guardsPath);
  if (credential !== undefined) return { entry: credential, tier: "credential" };
  const denied = deepest(policy.privateDeny, path, guardsPath);
  if (denied === undefined) return undefined;
  const grant = deepest(policy.readAllow, path, containsPath);
  if (grant !== undefined && depth(grant) >= depth(denied)) return undefined;
  return { entry: denied, tier: "private" };
}

/**
 * The denied entry a write to `path` would land in, or undefined.
 *
 * A read grant is not a write grant, so only writable roots weigh against a
 * private entry here — and only one at least as deep: a project that declared
 * `~/.config/myapp` writable meant it, a workspace that IS `~/.pi` writes its
 * own tree, and a root laid over a whole home does not make `~/.zshrc`
 * writable. A credential is never writable. This is the write half of
 * Seatbelt's last-match-wins, given the profile denies a private entry only
 * where it lies strictly inside a root, and a credential or host-data entry
 * wherever it meets one. The host's data is never writable either.
 */
export function writeDenial(policy: CapabilityPolicy, path: string): Denial | undefined {
  const credential = deepest(policy.credentialDeny, path, guardsPath);
  if (credential !== undefined) return { entry: credential, tier: "credential" };
  // No root weighs against the host's data: a root over `userData` is a
  // declaration nobody may make good on.
  const hostData = deepest(policy.hostDataDeny, path, guardsPath);
  if (hostData !== undefined) return { entry: hostData, tier: "host-data" };
  const denied = deepest(policy.privateDeny, path, guardsPath);
  if (denied === undefined) return undefined;
  const root = deepest(policy.writableRoots, path, containsPath);
  if (root !== undefined && depth(root) >= depth(denied)) return undefined;
  return { entry: denied, tier: "private" };
}

const DENIAL_REASONS: Record<DenyTier, (path: string, entry: string) => string> = {
  credential: (path, entry) =>
    `${path} is inside ${entry}, which holds credentials, so no tool may read or write it. Do not reach for it another way; if the task needs it, ask the user to provide what you need.`,
  "host-data": (path, entry) =>
    `${path} is inside ${entry}, which holds Volli's own data — its database, policy, approvals and other Sessions' records — so no Session may change it, with or without approval. Do not reach for it another way.`,
  private: (path, entry) =>
    `${path} is inside ${entry}, which holds private data outside this Session's work, so reading it needs the user's approval. Do not reach for it another way; ask the user if the task needs it.`,
};

/** The sentence a denied path is refused with, by tier. */
export function denialReason(path: string, denial: Denial): string {
  return DENIAL_REASONS[denial.tier](path, denial.entry);
}

function tierVerdict(path: string, denial: Denial): CapabilityVerdict {
  return { outcome: "deny", denial: denial.tier, reason: denialReason(path, denial) };
}

/** Whether `path` may be read under `policy`. */
export function capabilityRead(policy: CapabilityPolicy, path: string): CapabilityVerdict {
  const denial = readDenial(policy, path);
  return denial === undefined ? ALLOW : tierVerdict(path, denial);
}

/** True when a path or a pattern carries a shell glob character. */
export function hasGlob(path: string): boolean {
  return /[*?[]/u.test(path);
}

/** One glob component as an anchored expression over folded names. */
function segmentPattern(segment: string): RegExp {
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else if (character === "[") {
      const close = segment.indexOf("]", index + 2);
      if (close === -1) {
        source += "\\[";
        continue;
      }
      const body = segment.slice(index + 1, close);
      source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      index = close;
    } else source += character.replace(/[.^$+{}()|\\]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

/**
 * Whether one pattern component can name one entry component, both folded.
 *
 * A leading wildcard does not match a leading dot, as in the shell's own
 * expansion: `~/*` does not reach `~/.ssh`.
 */
function componentMatches(pattern: string, name: string): boolean {
  if (!hasGlob(pattern)) return pattern === name;
  if (name.startsWith(".") && !pattern.startsWith(".")) return false;
  return segmentPattern(pattern).test(name);
}

/**
 * How far a shell operand reaches toward one denied entry: `inside` when it can
 * name the entry or something in it, `ancestor` when it can name a directory
 * above it, or null. Glob-aware, so `~/.ss?/id*` and `~/.ss[h]` reach `~/.ssh`.
 */
export function operandReach(operand: string, entry: string): "inside" | "ancestor" | null {
  const pattern = foldedSegments(operand);
  const target = foldedSegments(entry);
  const shared = Math.min(pattern.length, target.length);
  for (let index = 0; index < shared; index += 1) {
    if (!componentMatches(pattern[index]!, target[index]!)) return null;
  }
  return pattern.length >= target.length ? "inside" : "ancestor";
}

/**
 * The denied entry a shell operand reaches, or undefined.
 *
 * A literal operand is judged like a file-tool read, grants included. A glob
 * operand is judged against every entry it could expand into, grants ignored —
 * a pattern that might name a credential is not one a lexer can clear. A
 * `recursive` reader (`grep -r`, `rg`, `tar`, `cp -r`, `rsync`, `zip`, `ln`)
 * is also refused for an operand ABOVE a denied entry, because it reads — or
 * links — everything under the directory it is handed.
 */
export function operandDenial(
  policy: CapabilityPolicy,
  operand: string,
  recursive: boolean,
): Denial | undefined {
  if (!hasGlob(operand)) {
    const direct = readDenial(policy, operand);
    if (direct !== undefined || !recursive) return direct;
  }
  const reaches = (entry: string) => {
    const reach = operandReach(operand, entry);
    return reach === "inside" || (recursive && reach === "ancestor");
  };
  const credential = policy.credentialDeny.find(reaches);
  if (credential !== undefined) return { entry: credential, tier: "credential" };
  const denied = policy.privateDeny.find(
    (entry) => reaches(entry) && readDenial(policy, entry) !== undefined,
  );
  return denied === undefined ? undefined : { entry: denied, tier: "private" };
}

/**
 * The host-data entry a command that can CHANGE files would reach through
 * `operand`, or undefined (VC-480: approvals and policy are never approvable).
 *
 * A shell operand is not marked read or write, so the caller decides which
 * commands can change what they name. Such a command reaches an entry when the
 * operand lies inside it, and — when `wholeTree` (a recursive removal, a move,
 * a recursive mode change) — when the operand lies above it. Glob-aware like
 * {@link operandDenial}.
 */
export function hostDataReach(
  policy: CapabilityPolicy,
  operand: string,
  wholeTree: boolean,
): Denial | undefined {
  const entry = policy.hostDataDeny.find((candidate) => {
    const reach = operandReach(operand, candidate);
    return reach === "inside" || (wholeTree && reach === "ancestor");
  });
  return entry === undefined ? undefined : { entry, tier: "host-data" };
}

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

/**
 * Whether the components below a `.git` name executable or redirecting
 * plumbing — the paths that change what LATER git commands run or where they
 * look, which ordinary git operation never writes:
 *
 * - `config` (and its `config.lock`, which git renames over it), `hooks`, and
 *   `config.worktree`;
 * - inside `worktrees/<name>/`: `commondir`, `gitdir` and `config.worktree`,
 *   which tell git where a linked worktree's repository is;
 * - inside a submodule's `modules/<name…>/` (names may hold slashes): any
 *   `hooks` or `config`;
 * - `objects/info/alternates` and `http-alternates`, which point object lookup
 *   at another repository.
 *
 * Each clause is one pattern in {@link sandboxWriteCarveOuts}, read the way
 * Seatbelt reads a deny — the match and everything beneath it.
 */
function isGitPlumbingTail(below: readonly string[]): boolean {
  const [head] = below;
  if (head === "hooks" || head === "config" || head === "config.lock") return true;
  if (head === "config.worktree") return true;
  if (head === "worktrees") {
    return below[2] === "commondir" || below[2] === "gitdir" || below[2] === "config.worktree";
  }
  if (head === "modules")
    return below.slice(2).some((part) => part === "hooks" || part === "config");
  if (head === "objects")
    return below[1] === "info" && /^(http-)?alternates$/u.test(below[2] ?? "");
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

type CarveOut = Exclude<CapabilityDenial, DenyTier | "outside-roots">;

/**
 * Which carve-out `path` falls in, judged from inside one writable root.
 *
 * A root that lies inside a git directory (a Ticket worktree's slices of the
 * common git directory: its objects, its own `worktrees/<self>`, its branch)
 * is judged from that `.git` component down. Any other root is judged from its
 * top: its own `.git` by the plumbing tails, and a `.git` deeper in the tree —
 * a nested repository, a submodule's `.git` file — whole, because renaming or
 * rewriting one redirects every later git command run there.
 */
function carveOutWithin(root: string, path: string, sandboxCarveOuts: boolean): CarveOut | null {
  const rootSegments = foldedSegments(root);
  const pathFolded = foldedSegments(path);
  const gitIndex = rootSegments.lastIndexOf(".git");
  const below = pathFolded.slice(rootSegments.length);
  const scope = gitIndex === -1 ? below : pathFolded.slice(gitIndex);
  if (holdsGitPlumbing(scope) || scope.includes(".gitmodules")) return "git-metadata";
  if (gitIndex === -1 && below.slice(1).includes(".git")) return "git-metadata";
  if (gitIndex === -1 && below[0] === ".volli") return "volli-state";
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
 * outside every root: the resolver's protected paths, then the plan's
 * carve-outs below each root that holds the path (`.git` plumbing,
 * `.gitmodules`, `.volli/`), then — in a Scoped Session — Seatbelt's own list.
 */
export function writeCarveOut(
  policy: Pick<CapabilityPolicy, "writableRoots" | "sandboxCarveOuts" | "protectedPaths">,
  path: string,
): CarveOut | null {
  if (policy.protectedPaths.some((protectedPath) => guardsPath(protectedPath, path))) {
    return "git-metadata";
  }
  for (const root of policy.writableRoots) {
    if (!containsPath(root, path)) continue;
    const carveOut = carveOutWithin(root, path, policy.sandboxCarveOuts);
    if (carveOut !== null) return carveOut;
  }
  return null;
}

/** The plumbing tails under one git directory, in Seatbelt's spelling. */
function gitPlumbingPatterns(gitDir: string): string[] {
  return [
    // Literal, so SRT's move-blocking also refuses renaming every ancestor —
    // `mv .git .g` included — which a glob's fixed prefix would not cover.
    `${gitDir}/hooks`,
    `${gitDir}/config`,
    `${gitDir}/config.lock`,
    `${gitDir}/config.worktree`,
    `${gitDir}/objects/info/alternates`,
    `${gitDir}/objects/info/http-alternates`,
    `${gitDir}/worktrees/*/commondir`,
    `${gitDir}/worktrees/*/gitdir`,
    `${gitDir}/worktrees/*/config.worktree`,
    `${gitDir}/modules/**/hooks`,
    `${gitDir}/modules/**/config`,
  ];
}

/**
 * {@link writeCarveOut} in the kernel's spelling: the deny patterns one
 * writable root contributes to a Seatbelt profile.
 *
 * Kept beside the predicate it mirrors so the two change together. Each
 * pattern is read by `@anthropic-ai/sandbox-runtime` as a deny that covers its
 * match and everything beneath it. Patterns are rooted at `root` rather than
 * left as SRT's bare `**` globs, because SRT resolves a relative glob against
 * its host process's working directory.
 */
export function sandboxWriteCarveOuts(root: string, sandboxCarveOuts: boolean): string[] {
  const segments = root.split("/");
  const gitIndex = segments.lastIndexOf(".git");
  if (gitIndex !== -1) {
    // A slice of a git directory: its plumbing, spelled from that directory.
    return gitPlumbingPatterns(segments.slice(0, gitIndex + 1).join("/"));
  }
  return [
    `${root}/.volli`,
    ...gitPlumbingPatterns(`${root}/.git`),
    // A `.git` below the top — a nested repository or a submodule's `.git`
    // file — whole: rewriting or renaming it redirects git there.
    `${root}/*/**/.git`,
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
    `Writing ${path} is not permitted; git hooks, config and repository pointers change what later git commands run. Use git itself for ordinary repository changes.`,
  "volli-state": (path) =>
    `Writing ${path} is not permitted; .volli holds Volli's own state, not the project's.`,
  "tool-config": (path) =>
    `Writing ${path} is not permitted in a Scoped Session; it configures what another tool runs the next time it starts, so the sandbox carves it out of every writable root.`,
};

/** Whether `path` may be written under `policy`. */
export function capabilityWrite(policy: CapabilityPolicy, path: string): CapabilityVerdict {
  if (isDeviceSink(path)) return ALLOW;
  const denial = writeDenial(policy, path);
  if (denial !== undefined) return tierVerdict(path, denial);
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
 * The denied path a multiply-linked file is also known as, or the path itself.
 * `identity` is `"<device>:<inode>"`, which only the runtime can read.
 */
export function linkedAlias(policy: CapabilityPolicy, path: string, identity: string): string {
  return policy.linkedFiles[identity] ?? path;
}
