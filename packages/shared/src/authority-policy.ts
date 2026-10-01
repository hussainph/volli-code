/**
 * The built-in rule pack: ten total predicates over one normalized call.
 *
 * Ordered evaluation is load-bearing rather than incidental. The rules overlap —
 * `git config http.sslVerify false` writes repository plumbing *and* weakens TLS
 * — and first-match-wins is what turns that overlap into one nameable refusal
 * instead of a set.
 *
 * No rule judges the tool's *name*, and the absence is deliberate. The Agent
 * Tool Surface makes availability the enforcement: a Session is offered exactly
 * the tools it was handed, Pi resolves a call's name against that array and
 * answers `Tool X not found` before the gate is consulted, and `sessionToolIds`
 * leaves the array and the Snapshot no way to disagree. A rule here could
 * therefore only refuse a name the model was never able to send. That is why an
 * interaction tool — `ask_user`, `web_fetch`, `web_search` — passes every rule
 * below: it carries no path, no command and no environment, so each predicate
 * reads an empty list and objects to nothing. Being judged by no rule *is* how
 * such a tool is judged, and the port that wires it is where the decision was
 * already made.
 *
 * Which fields a rule reads is where this layer's scope is really decided. The
 * capability rules read the call against the attachment's
 * {@link CapabilityPolicy} (VC-45), the same data a Scoped Session's walls are
 * compiled from:
 *
 * - `path.credentials` and `path.private` judge reads, writes, redirects AND
 *   command operands against the two tiers of the denylist. Operands are judged
 *   here, where the old read rule deliberately did not judge them, because the
 *   list is narrow: `cat ~/.ssh/id_rsa` is refused like `read ~/.ssh/id_rsa`,
 *   while `ls /usr/bin` names nothing on it. The operand check is BEST-EFFORT,
 *   and the docs say so: it is glob-aware (`~/.ss?/id*`), follows `cd` and
 *   `-C` as far as the lexer sees them, and refuses a recursive reader handed a
 *   directory above a denied entry — but a path in a variable, `$(…)` or an
 *   inline interpreter never reaches it. For the file tools the answer is the
 *   walls' answer; for the shell, only a Scoped Session's kernel guarantees it.
 * - `path.outside-workspace` judges writes — file-tool writes and a command's
 *   redirects — against the writable roots. Reads are machine-wide now, so the
 *   sibling repository, the pnpm store and `/usr/include` are ordinary reads.
 *
 * The residual is real and accepted: `cp <workspace>/secret /tmp/leak` is not
 * refused here, because `cp`'s destination is an operand and only the
 * denylist judges operands. A known-writer list (`cp`, `mv`, `tee`, `dd`) would
 * need per-program positional parsing to tell a destination from a source —
 * exactly the cleverness that puts bugs in a security rule. In a Scoped Session
 * the kernel refuses that write; outside one, this pack was never a boundary.
 *
 * `command.destructive-removal` and `command.git-escapes-workspace` do read
 * operands, and should: `rm -rf /usr/local/lib` and a `-C` aimed at another tree
 * are intent-level cases the kernel would happily permit. The removal rule asks
 * for a *strict* descendant of the workspace, so `rm -rf .` at the root of a
 * Main checkout is refused too — destroying the tree is never a coding action.
 *
 * `path.git-internals` reads operands too, for two names only, and the reason is
 * a seam between two layers rather than anything about policy. The sandbox
 * denied writes to `.git/hooks` and `.git/config` by subpath literal, and those
 * literals were found case-sensitive while APFS is not — so
 * `cp evil.sh .GIT/hooks/pre-commit` wrote the real hook the kernel meant to
 * protect. (VC-45 measured Seatbelt folding case on macOS 26 for both reads and
 * writes; the folded comparison here stays, because it costs nothing and does
 * not depend on which kernel a person runs.) Folded comparison up here
 * collapses every spelling at once, and it reaches submodule plumbing at
 * `.git/modules/<name>/hooks`, which executes exactly like the superproject's.
 * It applies inside every writable root, not only the workspace, since a Ticket
 * worktree's common git directory is one. It stays at those two names
 * deliberately: `git` takes other `.git`-relative operands in ordinary use, and
 * the cost of this clause is that `cat .git/config` is refused — which costs
 * nothing, because `git config --list` reads the same thing and is allowed.
 *
 * The same rule owns `-c`, which is not a path at all. It is the one global flag
 * whose value git always interprets, and the only one the subcommand scan skips
 * whole — so `git -c alias.zz='!rm -rf ~' zz` executes a shell command that
 * never becomes a segment for any rule to see. Refusing git's `!` escape and
 * `core.hooksPath` keeps the lexer's view of a command honest, which every rule
 * below depends on.
 *
 * A shell-profile rule and a launch-directory path check used to live here and
 * were deleted, for a reason that generalizes to any rule proposed for this
 * pack. Both read only a command's redirects, and `path.outside-workspace` has
 * already refused every redirect outside the tree — so they could fire only on a
 * `<workspace>/.bashrc` or `<workspace>/Library/LaunchAgents/…`, which is not
 * the user's real profile or a real launch agent but an ordinary file in a
 * dotfiles or container-image repo. A rule that cannot reach the thing it names,
 * and can refuse the thing it doesn't, is worse than no rule: it spends the
 * fallback budget to protect nothing. `command.persistence` keeps its program
 * clause, which reaches `launchctl` and `crontab` for real.
 *
 * Reasons are written for the model, not for a log. A denial becomes the text of
 * an error tool result, so it names the offending path or flag and says what to
 * do instead; a refusal the model cannot act on just becomes a retry. That cuts
 * both ways: `git rebase --continue`, `2>/dev/null` and a read of `.git/HEAD`
 * stay allowed, because a nuisance denial spends the Session's fallback budget
 * exactly as a real one does.
 *
 * Nothing here resolves a path or lexes a shell — `@volli/agent-runtime` does
 * both before calling in. Containment is therefore a segment comparison rather
 * than `node:path`: `/ws-evil` must not read as inside `/ws`, and this package
 * may not import the module that would say so.
 */

import {
  AUTHORITY_RULE_IDS,
  type AuthorityRuleId,
  type AuthoritySnapshot,
  type PolicyCommandSegment,
  type PolicyContext,
  type PolicyDecision,
  type PolicyToolCall,
} from "./authority";
import {
  containsPath,
  denialReason,
  foldSegment,
  guardsPath,
  hostDataReach,
  isDeviceSink,
  isGitPlumbingPath,
  operandDenial,
  pathSegments,
  readDenial,
  writeDenial,
  type CapabilityPolicy,
  type Denial,
  type DenyTier,
} from "./capability-policy";

/**
 * Case folding, and the one class of comparison that must not fold.
 *
 * macOS is case-insensitive by default and `realpathSync` does not canonicalize
 * case, so a resolved `<workspace>/.GIT/hooks/pre-commit` names the real hook
 * directory while comparing unequal to `.git`; `RM` and `SUDO` resolve the same
 * way through `PATH`. Probing the volume would be the precise answer and the
 * wrong one — it makes a security decision depend on a filesystem attribute this
 * layer is forbidden to read.
 *
 * So the rule is directional, and the direction is what matters. A comparison
 * whose *true* answer is "denied" folds: a guarded location, a program name, a
 * git subcommand. Folding can only widen a deny-list, and on a case-sensitive
 * volume the cost is refusing a genuinely distinct `.GIT` — over-denial, the
 * safe direction, and deliberate.
 *
 * A comparison whose *true* answer is "allowed" must not fold, and workspace
 * containment is exactly that one. Folding it would let a genuinely distinct
 * `/Users/x/WS/secret` read as inside `/Users/x/ws` on a case-sensitive volume,
 * which is under-denial — the unsafe direction — and it would do so in the rule
 * that is the whole reason the others can assume they are looking at this
 * Session's tree. Hence {@link containsPath} compares literally and
 * {@link guardsPath} folds. They are not interchangeable; do not collapse them.
 */
function fold(value: string): string {
  return value.toLowerCase();
}

/** The same components, case-folded, for the deny-list side of the split above. */
function foldedSegments(path: string): string[] {
  return pathSegments(path).map(foldSegment);
}

/** Literal containment excluding the root itself. */
function strictlyContainsPath(root: string, candidate: string): boolean {
  return (
    containsPath(root, candidate) && pathSegments(candidate).length > pathSegments(root).length
  );
}

/** The last path component, folded: `/usr/bin/SUDO` is `sudo`. A deny-list comparison. */
function baseName(path: string): string {
  return foldedSegments(path).slice(-1).join("");
}

/** The argument after `index`, or `""` past the end — a missing flag value denotes nothing. */
function argAfter(args: readonly string[], index: number): string {
  return args.slice(index + 1, index + 2).join("");
}

/** True when a short-flag cluster carries `letter`: `-rf`, `-fr` and `-r` all carry `r`. */
function hasShortFlag(args: readonly string[], letter: string): boolean {
  return args.some((arg) => arg.startsWith("-") && !arg.startsWith("--") && arg.includes(letter));
}

function segmentsOf(call: PolicyToolCall): readonly PolicyCommandSegment[] {
  return call.command === null ? [] : call.command.segments;
}

/**
 * The capability policy the path rules judge against: the attachment's own,
 * or — for a caller that resolved none — the workspace as the only writable
 * root and no secret known.
 */
function capabilityOf(context: PolicyContext): CapabilityPolicy {
  return (
    context.capability ?? {
      credentialDeny: [],
      privateDeny: [],
      hostDataDeny: [],
      readAllow: [],
      writableRoots: [context.workspacePath],
      protectedPaths: [],
      sandboxCarveOuts: false,
      hostDataAliases: [],
      linkedFiles: {},
    }
  );
}

/**
 * Whether a written path is repository plumbing.
 *
 * Guarded whole rather than by named member: git's own writes go through the
 * `git` program, so a file tool or a redirect reaching anywhere inside a `.git`
 * has no legitimate form worth carving out. Any `.git` component counts — the
 * workspace's, a nested repository's, and the common git directory a Ticket
 * worktree commits into, which is a writable root of its own (VC-45). So does a
 * `.gitmodules`, the plan's fourth carve-out: it decides what `git submodule
 * update` clones and runs.
 */
function isGitWrite(path: string): boolean {
  const segments = foldedSegments(path);
  return segments.includes(".git") || segments.at(-1) === ".gitmodules";
}

/** Volli's own state at the top of any writable root, guarded on the same terms as `.git`. */
function volliDirs(context: PolicyContext): string[] {
  return capabilityOf(context).writableRoots.map((root) => `${root}/.volli`);
}

/** Whether `path` lies inside one of the Session's writable roots. */
function insideWritableRoot(context: PolicyContext, path: string): boolean {
  return capabilityOf(context).writableRoots.some((root) => containsPath(root, path));
}

/**
 * The directories `rm` may never name: every root's `.git` and `.volli`, and
 * the git directory a root is a slice of — a Ticket worktree's common git
 * directory, which holds every branch's objects.
 */
function removalInternals(context: PolicyContext): string[] {
  return capabilityOf(context).writableRoots.flatMap((root) => {
    const segments = root.split("/");
    const gitIndex = segments.map(foldSegment).lastIndexOf(".git");
    return gitIndex === -1
      ? [`${root}/.git`, `${root}/.volli`]
      : [segments.slice(0, gitIndex + 1).join("/")];
  });
}

/** Every path the call would create, modify, or delete. */
function writtenPaths(call: PolicyToolCall): string[] {
  return [...call.writes, ...segmentsOf(call).flatMap((segment) => segment.writes)];
}

/** Every path that must land inside a writable root: file-tool writes and redirects. */
function rootedWrites(call: PolicyToolCall): string[] {
  return writtenPaths(call).filter((path) => !isDeviceSink(path));
}

/** Programs that read — or, for `ln`, link — everything under a directory they are handed. */
const ALWAYS_RECURSIVE = new Set([
  "rg",
  "ag",
  "ack",
  "tar",
  "bsdtar",
  "gtar",
  "rsync",
  "ditto",
  "ln",
]);

const GREP_PROGRAMS = new Set(["grep", "egrep", "fgrep", "ggrep"]);

/**
 * Whether a segment reads a directory operand's whole subtree, so an operand
 * ABOVE a denied entry reaches it: `grep -r token ~` reads `~/.ssh`.
 *
 * The cheap, named cases only — `grep -r`, `rg`, `tar`, `cp -r`, `rsync`,
 * `zip -r`, and `ln`, which can link a whole tree into the workspace for a
 * later command to read through. A recursive reader this table does not name
 * is one the gate does not see; the kernel is what refuses it, in a Session
 * that has one.
 */
function readsRecursively(segment: PolicyCommandSegment): boolean {
  const program = baseName(segment.program);
  const { args } = segment;
  if (ALWAYS_RECURSIVE.has(program)) return true;
  if (GREP_PROGRAMS.has(program)) {
    return (
      hasShortFlag(args, "r") ||
      hasShortFlag(args, "R") ||
      args.some(
        (arg) => arg.startsWith("--recursive") || arg.startsWith("--dereference-recursive"),
      ) ||
      args.includes("--directories=recurse")
    );
  }
  if (program === "zip") return hasShortFlag(args, "r") || args.includes("--recurse-paths");
  if (program === "cp") {
    return (
      hasShortFlag(args, "r") ||
      hasShortFlag(args, "R") ||
      hasShortFlag(args, "a") ||
      args.includes("--recursive") ||
      args.includes("--archive")
    );
  }
  return false;
}

/**
 * The only `security` commands a Session may run. Certificates and trust
 * settings are public verification material; these commands inspect them and
 * cannot return a password, private key, identity, or authorization right.
 * Everything else is denied rather than trying to keep a complete blacklist
 * of a tool whose interactive mode accepts commands on stdin.
 */
const SAFE_SECURITY_SUBCOMMANDS = new Set([
  "find-certificate",
  "verify-cert",
  "dump-trust-settings",
]);

/**
 * A safely recognizable `security` subcommand. Only verbosity flags may come
 * first. `-i` and `-p` are intentionally not parsed: both enter interactive
 * mode, so even a safe-looking later word could be a prompt or stdin command.
 */
function securitySubcommand(args: readonly string[]): string | null {
  let index = 0;
  while (/^-[qv]+$/u.test(args[index] ?? "")) index += 1;
  const subcommand = args[index];
  return subcommand === undefined || subcommand.startsWith("-") ? null : fold(subcommand);
}

function keychainAccess(segment: PolicyCommandSegment): string | null {
  if (baseName(segment.program) !== "security") return null;
  const subcommand = securitySubcommand(segment.args);
  if (subcommand !== null && SAFE_SECURITY_SUBCOMMANDS.has(subcommand)) return null;
  return subcommand === null ? "security interactive mode" : `security ${subcommand}`;
}

/**
 * Programs that only read what they are handed, so naming the host's data is a
 * read of it (`path.private`, approvable) rather than a possible change to it
 * (`path.host-data`, never). Every program NOT here is assumed able to change
 * an operand — `cp`, `mv`, `rm`, `sqlite3`, `sed`, an interpreter — because a
 * shell operand carries no read/write mark and the cost of guessing wrong is a
 * Session editing its own approvals.
 */
const READ_ONLY_PROGRAMS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "grep",
  "egrep",
  "fgrep",
  "ggrep",
  "rg",
  "ag",
  "ack",
  "ls",
  "stat",
  "file",
  "wc",
  "du",
  "od",
  "hexdump",
  "xxd",
  "strings",
  "md5",
  "md5sum",
  "shasum",
  "sha1sum",
  "sha256sum",
  "diff",
  "cmp",
  "jq",
  "cd",
  "pushd",
  "realpath",
  "readlink",
  "test",
  "[",
]);

/** Programs whose change reaches everything under a directory they are handed. */
function changesWholeTree(segment: PolicyCommandSegment): boolean {
  const program = baseName(segment.program);
  const { args } = segment;
  if (program === "mv") return true;
  if (program === "rm") {
    return hasShortFlag(args, "r") || hasShortFlag(args, "R") || args.includes("--recursive");
  }
  if (["chmod", "chown", "chgrp", "chflags"].includes(program)) return hasShortFlag(args, "R");
  return false;
}

/** One denylisted reach a call makes, and the sentence that refuses it. */
interface NamedDenial {
  tier: DenyTier;
  reason: string;
}

/**
 * Every denylisted path a call reaches, in the order a rule should cite them.
 *
 * What the call reads (file tools) is judged as a read, grants included; what
 * it writes as a write, where grants do not count; every operand a command
 * names through {@link operandDenial} — glob-aware, and recursive for the
 * readers above — and, for a program that can change what it names, through
 * {@link hostDataReach}. A keychain subcommand is a credential read with no
 * path.
 *
 * Best-effort for a shell command, and said so in the docs: an operand hidden
 * in a variable or `$(…)` never reaches here, nor does a path an inline
 * interpreter (`python3 -c`, `osascript -e`) opens. The kernel refuses those in
 * a Scoped Session; nothing does outside one.
 */
function namedDenials(call: PolicyToolCall, capability: CapabilityPolicy): NamedDenial[] {
  const denials: NamedDenial[] = [];
  for (const path of call.reads) pushNamed(denials, path, readDenial(capability, path));
  for (const path of writtenPaths(call)) pushNamed(denials, path, writeDenial(capability, path));
  for (const segment of segmentsOf(call)) {
    const keychain = keychainAccess(segment);
    if (keychain !== null) {
      denials.push({
        tier: "credential",
        reason: `${keychain} can access the macOS keychain, which holds credentials, so it is not available to a Session. Only certificate and trust inspection commands are allowed. If the task needs a secret, ask the user to provide it.`,
      });
    }
    const recursive = readsRecursively(segment);
    const changes = !READ_ONLY_PROGRAMS.has(baseName(segment.program));
    const wholeTree = changesWholeTree(segment);
    for (const path of segment.paths) {
      if (changes) pushNamed(denials, path, hostDataReach(capability, path, wholeTree));
      pushNamed(denials, path, operandDenial(capability, path, recursive));
    }
  }
  return denials;
}

/** One path's denial, named for the model, when there is one. */
function pushNamed(denials: NamedDenial[], path: string, denial: Denial | undefined): void {
  if (denial !== undefined) denials.push({ tier: denial.tier, reason: denialReason(path, denial) });
}

/** Everything git and npm read as "off"; matching only `false` would leave `0` a bypass. */
const FALSY_CONFIG_VALUES = new Set(["false", "0", "no", "off", ""]);

const GIT_SSL_VERIFY_KEY = "http.sslverify=";

function isSslVerifyOff(arg: string): boolean {
  const lowered = arg.toLowerCase();
  return (
    lowered.startsWith(GIT_SSL_VERIFY_KEY) &&
    FALSY_CONFIG_VALUES.has(lowered.slice(GIT_SSL_VERIFY_KEY.length))
  );
}

function isStrictSslOff(args: readonly string[]): boolean {
  return (
    args[0] === "config" &&
    args[1] === "set" &&
    args[2] === "strict-ssl" &&
    FALSY_CONFIG_VALUES.has(args[3])
  );
}

const TLS_WEAKENING_ENV = new Set(["NODE_TLS_REJECT_UNAUTHORIZED=0", "PYTHONHTTPSVERIFY=0"]);

function isTlsWeakeningEnv(entry: string): boolean {
  return TLS_WEAKENING_ENV.has(entry) || entry.startsWith("GIT_SSL_NO_VERIFY=");
}

/** The fragment of `segment` that turns certificate verification off, or null. */
function tlsWeakening(segment: PolicyCommandSegment): string | null {
  const program = baseName(segment.program);
  if (
    program === "curl" &&
    (segment.args.includes("--insecure") || hasShortFlag(segment.args, "k"))
  ) {
    return "curl --insecure";
  }
  if (program === "wget" && segment.args.includes("--no-check-certificate")) {
    return "wget --no-check-certificate";
  }
  if (program === "git" && segment.args.some(isSslVerifyOff)) {
    return "git -c http.sslVerify=false";
  }
  if (program === "npm" && isStrictSslOff(segment.args)) {
    return "npm config set strict-ssl false";
  }
  return segment.env.find(isTlsWeakeningEnv) ?? null;
}

const PERSISTENCE_PROGRAMS = new Set(["launchctl", "crontab", "systemctl", "at"]);

const PLATFORM_PROGRAMS = new Set(["csrutil", "spctl", "nvram", "dscl", "sudo", "doas"]);

function isRecursiveRemoval(args: readonly string[]): boolean {
  return args.includes("--recursive") || hasShortFlag(args, "r") || hasShortFlag(args, "R");
}

/** git's global flags that swallow the argument after them, so the subcommand scan can skip both. */
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

interface GitInvocation {
  subcommand: string;
  rest: readonly string[];
}

/** git's subcommand and its arguments, past the global flags that precede it. */
function gitInvocation(args: readonly string[]): GitInvocation | null {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (GIT_GLOBAL_VALUE_FLAGS.has(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    return { subcommand: fold(arg), rest: args.slice(index + 1) };
  }
  return null;
}

const GIT_CONFIG_WRITE_FLAGS = new Set([
  "--add",
  "--unset",
  "--unset-all",
  "--replace-all",
  "--edit",
  "--rename-section",
  "--remove-section",
]);

const GIT_CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--list"]);

const GIT_CONFIG_WRITE_SUBCOMMANDS = new Set([
  "set",
  "unset",
  "edit",
  "remove-section",
  "rename-section",
]);

const GIT_CONFIG_READ_SUBCOMMANDS = new Set(["get", "list"]);

/**
 * Whether a `git config` invocation writes rather than reads.
 *
 * Three spellings coexist and are checked in that order. Git 2.46's
 * `config get|set|…` subcommand form is unambiguous, so it is read first —
 * without it, `git config get user.name` looks like the old two-operand *set*
 * form and a plain read gets refused. Then the classic flags. Only if neither
 * appears does operand count decide, since `git config <name>` prints a value
 * and `git config <name> <value>` assigns one. Everything else — `--local`,
 * `--global` — is a scope, and a scope alone still reads.
 */
function gitConfigWrites(rest: readonly string[]): boolean {
  const leading = fold(rest.find((arg) => !arg.startsWith("-")) ?? "");
  if (GIT_CONFIG_WRITE_SUBCOMMANDS.has(leading)) return true;
  if (GIT_CONFIG_READ_SUBCOMMANDS.has(leading)) return false;
  if (rest.some((arg) => GIT_CONFIG_WRITE_FLAGS.has(arg))) return true;
  if (rest.some((arg) => GIT_CONFIG_READ_FLAGS.has(arg))) return false;
  return rest.filter((arg) => !arg.startsWith("-")).length >= 2;
}

/**
 * Whether a git path argument denotes something outside the workspace.
 *
 * Absolute values are compared directly. A relative one resolves against a
 * working directory policy cannot see, so the honest test is whether it can
 * climb out at all — `sub` stays here by construction, `../other` does not.
 */
function pointsOutside(value: string, workspacePath: string): boolean {
  if (value.startsWith("/")) return !containsPath(workspacePath, value);
  return pathSegments(value).includes("..");
}

/**
 * Config keys that decide what git *runs*, rather than how it runs it.
 *
 * Deliberately just the one. `core.pager`, `core.editor`, `core.sshCommand` and
 * `core.fsmonitor` also name programs, but a `-c` assignment lasts for a single
 * invocation, so setting them runs a local program the model could equally have
 * run directly — no new capability, and refusing them would break
 * `git -c core.pager=cat log`, which agents type constantly. `core.hooksPath` is
 * different in kind: it is the thing `path.git-internals` exists to protect,
 * stated as a flag instead of a file.
 */
const GIT_EXEC_CONFIG_KEYS = new Set(["core.hookspath"]);

/**
 * The inline-config argument that makes git run something unlexed, or null.
 *
 * `-c` is the one global flag whose value is always semantically live — rule 6
 * already reads it for `http.sslVerify` — and the subcommand scan skips it
 * wholesale, which is how `git -c alias.zz='!rm -rf ~' zz` runs a shell command
 * that never appears as a segment. Git's `!` prefix is that escape, honoured for
 * `alias.*` and `credential.helper` alike, so it is matched on any key rather
 * than a list of them. `--config-env` is refused outright: it sources the value
 * from the environment, where policy cannot see it, and nothing an agent
 * legitimately does needs it.
 */
function gitInlineConfigHazard(args: readonly string[]): string | null {
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith("--config-env")) return arg;
    if (arg !== "-c") continue;
    const assignment = argAfter(args, index);
    const separator = assignment.indexOf("=");
    if (separator === -1) continue;
    if (assignment.slice(separator + 1).startsWith("!")) return `-c ${assignment}`;
    if (GIT_EXEC_CONFIG_KEYS.has(fold(assignment.slice(0, separator)))) return `-c ${assignment}`;
  }
  return null;
}

/**
 * Global flags whose value is a path git will operate from.
 *
 * `--exec-path` belongs here with the two tree flags: it decides which directory
 * git runs its helper programs out of, so pointing it elsewhere is arbitrary
 * execution dressed as configuration.
 */
const GIT_PATH_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--exec-path"]);

/** The path a git global flag carries, in either the `--flag=value` or `--flag value` spelling. */
function gitPathFlagValue(args: readonly string[], index: number): string | null {
  const arg = args[index];
  const separator = arg.indexOf("=");
  if (separator === -1) return GIT_PATH_FLAGS.has(arg) ? argAfter(args, index) : null;
  return GIT_PATH_FLAGS.has(arg.slice(0, separator)) ? arg.slice(separator + 1) : null;
}

const GIT_TREE_SUBCOMMANDS = new Set(["worktree", "clone", "submodule", "init"]);

/** The fragment of a git invocation that aims it at another tree, or null. */
function gitTreeEscape(args: readonly string[], workspacePath: string): string | null {
  for (const [index, arg] of args.entries()) {
    const value = gitPathFlagValue(args, index);
    if (value !== null && pointsOutside(value, workspacePath)) {
      return arg.includes("=") ? arg : `${arg} ${value}`;
    }
  }
  const invocation = gitInvocation(args);
  if (invocation === null || !GIT_TREE_SUBCOMMANDS.has(invocation.subcommand)) return null;
  const operand = invocation.rest.find(
    (candidate) => !candidate.startsWith("-") && pointsOutside(candidate, workspacePath),
  );
  return operand === undefined ? null : `${invocation.subcommand} ${operand}`;
}

const GIT_REBASE_CONTINUATIONS = new Set(["--abort", "--continue", "--skip", "--quit"]);

/** `--keep` and `--merge` refuse *some* clobbering; neither refuses all of it. */
const GIT_RESET_DISCARDS = new Set(["--hard", "--keep", "--merge"]);

/**
 * Whether a `git checkout` would overwrite the working tree.
 *
 * A pathspec is the tell, and `--` is the only spelling of one this can trust:
 * without it, `git checkout feature/x` and `git checkout src/x` are the same
 * shape, and refusing every slash-bearing argument would refuse branch switching
 * — the most ordinary thing an agent does. So `--` with anything after it, an
 * explicit force, and the bare `.` everyone actually types.
 */
function checkoutDiscards(rest: readonly string[]): boolean {
  if (isForced(rest)) return true;
  const separator = rest.indexOf("--");
  if (separator !== -1) return rest.length > separator + 1;
  return rest.includes(".");
}

/** `git restore` writes the working tree unless it was told to touch only the index. */
function restoreDiscards(rest: readonly string[]): boolean {
  if (rest.includes("--worktree") || hasShortFlag(rest, "W")) return true;
  return !rest.includes("--staged") && !hasShortFlag(rest, "S");
}

/** The fragment of a git invocation that throws uncommitted work away, or null. */
function gitDiscard({ subcommand, rest }: GitInvocation): string | null {
  const reset = rest.find((arg) => GIT_RESET_DISCARDS.has(arg));
  if (subcommand === "reset" && reset !== undefined) return `reset ${reset}`;
  if (subcommand === "checkout" && checkoutDiscards(rest)) return "checkout";
  if (subcommand === "restore" && restoreDiscards(rest)) return "restore";
  if (subcommand === "switch" && (rest.includes("--discard-changes") || isForced(rest))) {
    return "switch --discard-changes";
  }
  if (subcommand === "clean" && isForced(rest)) return "clean -f";
  if (subcommand === "stash" && (rest[0] === "drop" || rest[0] === "clear")) {
    return `stash ${rest[0]}`;
  }
  // `--abort` and friends restore or advance a rebase already in flight; only
  // starting one rewrites what is already committed.
  if (subcommand === "rebase" && !rest.some((arg) => GIT_REBASE_CONTINUATIONS.has(arg))) {
    return "rebase";
  }
  if (subcommand === "commit" && rest.includes("--amend")) return "commit --amend";
  return null;
}

function isForced(args: readonly string[]): boolean {
  return args.includes("--force") || hasShortFlag(args, "f");
}

/** A rule's verdict: the sentence the model should read, or null to pass the call on. */
type RuleCheck = (
  call: PolicyToolCall,
  snapshot: AuthoritySnapshot,
  context: PolicyContext,
) => string | null;

/**
 * The pack, keyed by rule id.
 *
 * A record rather than a list, so the type forces every id in the pack to have
 * exactly one check and evaluation order comes from {@link AUTHORITY_RULE_IDS}
 * itself — the same list the recorded pack hash is computed over.
 */
const RULE_CHECKS: Record<AuthorityRuleId, RuleCheck> = {
  "path.credentials": (call, _snapshot, context) =>
    namedDenials(call, capabilityOf(context)).find((denial) => denial.tier === "credential")
      ?.reason ?? null,

  "path.host-data": (call, _snapshot, context) =>
    namedDenials(call, capabilityOf(context)).find((denial) => denial.tier === "host-data")
      ?.reason ?? null,

  "path.private": (call, _snapshot, context) =>
    namedDenials(call, capabilityOf(context)).find((denial) => denial.tier === "private")?.reason ??
    null,

  "path.outside-workspace": (call, _snapshot, context) => {
    const roots = capabilityOf(context).writableRoots;
    for (const path of rootedWrites(call)) {
      if (!insideWritableRoot(context, path)) {
        return `${path} is outside this Session's writable roots (${roots.join(", ")}); every write must land inside one of them. Reading anywhere else is fine.`;
      }
    }
    return null;
  },

  "path.git-internals": (call, _snapshot, context) => {
    for (const path of writtenPaths(call)) {
      if (isGitWrite(path)) {
        return `Writing ${path} is not permitted; hand-editing the repository's plumbing changes what later commands do. Reading it is fine.`;
      }
    }
    for (const segment of segmentsOf(call)) {
      for (const path of segment.paths) {
        if (insideWritableRoot(context, path) && isGitPlumbingPath(path)) {
          return `${path} cannot be a command operand; policy cannot tell a read there from a write, and a write would change what later commands do. Read configuration with \`git config --list\`.`;
        }
      }
      if (baseName(segment.program) !== "git") continue;
      const inlineConfig = gitInlineConfigHazard(segment.args);
      if (inlineConfig !== null) {
        return `git ${inlineConfig} makes git run something this policy never inspected; drop it and run the command directly.`;
      }
      const invocation = gitInvocation(segment.args);
      if (invocation === null) continue;
      if (invocation.subcommand === "config" && gitConfigWrites(invocation.rest)) {
        return `This git config would write repository configuration and change what later commands do; only the read forms (--get, --list) are available.`;
      }
    }
    return null;
  },

  "path.volli-internals": (call, _snapshot, context) => {
    for (const path of writtenPaths(call)) {
      if (volliDirs(context).some((dir) => guardsPath(dir, path))) {
        return `Writing ${path} is not permitted; .volli holds Volli's own state, not the project's.`;
      }
    }
    return null;
  },

  "command.tls-weakening": (call) => {
    for (const segment of segmentsOf(call)) {
      const weakening = tlsWeakening(segment);
      if (weakening !== null) {
        return `${weakening} disables certificate verification; make the request with verification left on.`;
      }
    }
    return null;
  },

  "command.persistence": (call) => {
    for (const segment of segmentsOf(call)) {
      const program = baseName(segment.program);
      if (PERSISTENCE_PROGRAMS.has(program)) {
        return `${program} schedules work that outlives this Session; do the work now instead of installing it.`;
      }
    }
    return null;
  },

  "command.platform-weakening": (call) => {
    for (const segment of segmentsOf(call)) {
      const program = baseName(segment.program);
      if (PLATFORM_PROGRAMS.has(program)) {
        return `${program} changes macOS platform protections and is never available to a Session; solve the problem inside the workspace instead.`;
      }
    }
    return null;
  },

  "command.destructive-removal": (call, _snapshot, context) => {
    const internals = removalInternals(context);
    for (const segment of segmentsOf(call)) {
      if (baseName(segment.program) !== "rm") continue;
      const recursive = isRecursiveRemoval(segment.args);
      for (const path of segment.paths) {
        // Not a recursive-only case, and the only place these two directories
        // are defended against deletion: a single `rm .git/index` corrupts the
        // repository, and `writtenPaths` never sees an rm operand, so the path
        // rules above cannot see this at all.
        if (internals.some((dir) => guardsPath(dir, path))) {
          return `Removing ${path} would destroy state this Session depends on; .git and .volli are not the Session's to delete.`;
        }
        if (recursive && !strictlyContainsPath(context.workspacePath, path)) {
          return `Recursive removal of ${path} would delete the Session workspace itself or something outside it; remove only paths inside ${context.workspacePath}.`;
        }
      }
    }
    return null;
  },

  "command.git-escapes-workspace": (call, _snapshot, context) => {
    for (const segment of segmentsOf(call)) {
      if (baseName(segment.program) !== "git") continue;
      const escape = gitTreeEscape(segment.args, context.workspacePath);
      if (escape !== null) {
        return `git ${escape} aims at a tree outside the Session workspace; run git against ${context.workspacePath}.`;
      }
    }
    return null;
  },

  "command.git-discards-work": (call, snapshot) => {
    if (snapshot.location !== "main-checkout") return null;
    for (const segment of segmentsOf(call)) {
      if (baseName(segment.program) !== "git") continue;
      const invocation = gitInvocation(segment.args);
      if (invocation === null) continue;
      const discard = gitDiscard(invocation);
      if (discard !== null) {
        return `git ${discard} discards uncommitted work, and this Session runs in the project's main checkout where that work may be the user's; commit or stash it first.`;
      }
    }
    return null;
  },
};

/**
 * The verdict on one normalized call: the first rule in pack order that refuses,
 * or `allow` when none does.
 */
export function evaluate(
  call: PolicyToolCall,
  snapshot: AuthoritySnapshot,
  context: PolicyContext,
): PolicyDecision {
  for (const rule of AUTHORITY_RULE_IDS) {
    const reason = RULE_CHECKS[rule](call, snapshot, context);
    if (reason !== null) return { outcome: "deny", rule, reason };
  }
  return { outcome: "allow" };
}
