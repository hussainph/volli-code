/**
 * The built-in rule pack: nine total predicates over one normalized call.
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
 * Which fields a rule reads is where this layer's scope is really decided, and
 * it is narrower than it first looks. `path.outside-workspace` judges reads and
 * writes — `call.reads`, `call.writes`, and a command's redirects — and
 * deliberately does *not* judge command operands. The runtime resolves every
 * non-flag operand into `segment.paths`, the program included, so checking them
 * would refuse `ls /usr/bin`, `cat /etc/hosts` and `/opt/homebrew/bin/node
 * script.js`. The Seatbelt policy this pack was designed under denied the home
 * directory and left `/usr`, `/etc` and `/opt/homebrew` readable precisely so
 * that ordinary build and test commands work, and a rule stricter than the
 * boundary it sits under is not defence in depth but a second, worse boundary
 * re-litigating a decision the kernel already enforces. That boundary is no
 * longer installed — see the header of `./authority.ts` — which widens the
 * residual below rather than changing what this rule should judge.
 *
 * The residual is real and accepted: `cp <workspace>/secret /tmp/leak` is not
 * refused here. That was accepted while the network was denied outright, which
 * made a file written elsewhere on the user's own machine something other than
 * exfiltration; with the network reachable the argument no longer holds and the
 * residual is simply larger. What has not changed is why no rule closes it: a
 * known-writer list (`cp`, `mv`, `tee`, `dd`) would need per-program positional
 * parsing to tell a destination from a source — exactly the cleverness that puts
 * bugs in a security rule.
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
 * literals are case-sensitive while APFS is not — so
 * `cp evil.sh .GIT/hooks/pre-commit` wrote the real hook the kernel meant to
 * protect, and enumerating case variants downstairs is 2^n hopeless. Folded
 * comparison up here collapses every spelling at once, and it reaches submodule
 * plumbing at `.git/modules/<name>/hooks`, which executes exactly like the
 * superproject's. It stays at those two names deliberately: `git` takes other
 * `.git`-relative operands in ordinary use, and the cost of this clause is that
 * `cat .git/config` is refused — which costs nothing, because `git config
 * --list` reads the same thing and is allowed.
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

/** The non-empty path components, compared as written. */
function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** The same components, case-folded, for the deny-list side of the split above. */
function foldedSegments(path: string): string[] {
  return pathSegments(path).map(fold);
}

function containsSegments(root: readonly string[], candidate: readonly string[]): boolean {
  return candidate.length >= root.length && root.every((part, index) => candidate[index] === part);
}

/**
 * Literal containment, for every test whose *true* answer is "allowed".
 *
 * `/ws-evil` is not inside `/ws`, and on a case-sensitive volume neither is
 * `/WS/secret`.
 */
function containsPath(root: string, candidate: string): boolean {
  return containsSegments(pathSegments(root), pathSegments(candidate));
}

/** Literal containment excluding the root itself. */
function strictlyContainsPath(root: string, candidate: string): boolean {
  return (
    containsPath(root, candidate) && pathSegments(candidate).length > pathSegments(root).length
  );
}

/**
 * Folded containment, for every test whose *true* answer is "denied".
 *
 * `<workspace>/.GIT/hooks` names the real hook directory on APFS, so a guarded
 * location has to cover every spelling of itself.
 */
function guardsPath(guarded: string, candidate: string): boolean {
  return containsSegments(foldedSegments(guarded), foldedSegments(candidate));
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
 * The repository plumbing directory.
 *
 * Guarded whole rather than by named member: git's own writes go through the
 * `git` program, so a file tool or a redirect reaching anywhere inside `.git`
 * has no legitimate form worth carving out.
 */
function gitDirOf(context: PolicyContext): string {
  return `${context.workspacePath}/.git`;
}

/** Volli's own state inside the tree, guarded on the same terms as `.git`. */
function volliDirOf(context: PolicyContext): string {
  return `${context.workspacePath}/.volli`;
}

/**
 * True when `path` is the repository's `config` or anything under its `hooks`,
 * for the superproject or for any submodule.
 *
 * A submodule's plumbing lives at `.git/modules/<name>/` and its hooks execute
 * exactly like the superproject's, so the `modules/<name>` prefixes are stripped
 * — repeatedly, since submodules nest — and the same two names checked
 * underneath. Only those two: `git` names other `.git`-relative paths in
 * ordinary use, and this is the arm that reads command operands.
 */
function isGitExecutablePath(gitDir: string, path: string): boolean {
  if (!guardsPath(gitDir, path)) return false;
  let below = foldedSegments(path).slice(foldedSegments(gitDir).length);
  while (below[0] === "modules" && below.length >= 2) below = below.slice(2);
  return below[0] === "config" || below[0] === "hooks";
}

/** Every path the call would create, modify, or delete. */
function writtenPaths(call: PolicyToolCall): string[] {
  return [...call.writes, ...segmentsOf(call).flatMap((segment) => segment.writes)];
}

/**
 * Sinks a redirect may name that are not files at all.
 *
 * `2>/dev/null` turns up in ordinary build and test commands, so refusing it
 * would spend the Session's fallback budget on nothing.
 */
const DEVICE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"]);

function isDeviceSink(path: string): boolean {
  return DEVICE_SINKS.has(path) || containsPath("/dev/fd", path);
}

/** Every path `path.outside-workspace` judges. Command operands are not among them. */
function containedPaths(call: PolicyToolCall): string[] {
  return [
    ...call.reads,
    ...call.writes,
    ...segmentsOf(call).flatMap((segment) => segment.writes.filter((path) => !isDeviceSink(path))),
  ];
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
  "path.outside-workspace": (call, _snapshot, context) => {
    for (const path of containedPaths(call)) {
      if (!containsPath(context.workspacePath, path)) {
        return `${path} is outside the Session workspace ${context.workspacePath}; every read and write must stay inside it.`;
      }
    }
    return null;
  },

  "path.git-internals": (call, _snapshot, context) => {
    const gitDir = gitDirOf(context);
    for (const path of writtenPaths(call)) {
      if (guardsPath(gitDir, path)) {
        return `Writing ${path} is not permitted; hand-editing the repository's plumbing changes what later commands do. Reading it is fine.`;
      }
    }
    for (const segment of segmentsOf(call)) {
      for (const path of segment.paths) {
        if (isGitExecutablePath(gitDir, path)) {
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
      if (guardsPath(volliDirOf(context), path)) {
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
    const internals = [gitDirOf(context), volliDirOf(context)];
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
