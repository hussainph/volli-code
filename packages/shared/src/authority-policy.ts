/**
 * The built-in rule pack: eleven total predicates over one normalized call.
 *
 * Ordered evaluation is load-bearing rather than incidental. The rules overlap —
 * `git config http.sslVerify false` writes repository plumbing *and* weakens TLS
 * — and first-match-wins is what turns that overlap into one nameable refusal
 * instead of a set.
 *
 * Which fields a rule reads is where this layer's scope is really decided, and
 * it is narrower than it first looks. `path.outside-workspace` judges reads and
 * writes — `call.reads`, `call.writes`, and a command's redirects — and
 * deliberately does *not* judge command operands. The runtime resolves every
 * non-flag operand into `segment.paths`, the program included, so checking them
 * would refuse `ls /usr/bin`, `cat /etc/hosts` and `/opt/homebrew/bin/node
 * script.js`. The Seatbelt policy beneath us denies the home directory and
 * leaves `/usr`, `/etc` and `/opt/homebrew` readable precisely so that ordinary
 * build and test commands work. A rule stricter than the boundary it sits under
 * is not defence in depth; it is a second, worse boundary re-litigating a
 * decision the kernel already enforces.
 *
 * The residual is real and accepted: `cp <workspace>/secret /tmp/leak` is not
 * refused here. The network is denied outright, so a file written elsewhere on
 * the user's own machine is not exfiltration, and the sandbox's own `denyWrite`
 * covers the scratch paths the agent can reach. A known-writer list (`cp`, `mv`,
 * `tee`, `dd`) would need per-program positional parsing to tell a destination
 * from a source — exactly the cleverness that puts bugs in a security rule.
 *
 * `command.destructive-removal` and `command.git-escapes-workspace` do read
 * operands, and should: `rm -rf /usr/local/lib` and a `-C` aimed at another tree
 * are intent-level cases the kernel would happily permit. The removal rule asks
 * for a *strict* descendant of the workspace, so `rm -rf .` at the root of a
 * Main checkout is refused too — destroying the tree is never a coding action.
 *
 * The same "does this rule guard anything" test is why
 * `command.shell-profile-write` and `command.persistence` read only a command's
 * own writes and never `call.writes`. A `.zshrc` or a `Library/LaunchAgents/`
 * path *inside* the workspace is not the user's real profile or a real launch
 * agent; the real ones live in the home directory, which the sandbox denies
 * outright.
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

/** The non-empty path components, so containment compares directories, never string prefixes. */
function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** True when `candidate` is `root` or lies under it. `/ws-evil` is not under `/ws`. */
function isAtOrUnder(root: string, candidate: string): boolean {
  const rootParts = pathSegments(root);
  const candidateParts = pathSegments(candidate);
  return (
    candidateParts.length >= rootParts.length &&
    rootParts.every((part, index) => candidateParts[index] === part)
  );
}

/** True when `candidate` lies strictly below `root`; the root itself does not count. */
function isUnder(root: string, candidate: string): boolean {
  return isAtOrUnder(root, candidate) && pathSegments(candidate).length > pathSegments(root).length;
}

/** True when `path` contains `run` as consecutive segments, at any depth. */
function hasSegmentRun(path: string, run: readonly string[]): boolean {
  const parts = pathSegments(path);
  return parts.some((_part, index) =>
    run.every((segment, offset) => parts[index + offset] === segment),
  );
}

/** The last path component: `/usr/bin/sudo` is `sudo`, `<workspace>/.zshrc` is `.zshrc`. */
function baseName(path: string): string {
  return pathSegments(path).slice(-1).join("");
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
  return DEVICE_SINKS.has(path) || isAtOrUnder("/dev/fd", path);
}

/** Every path `path.outside-workspace` judges. Command operands are not among them. */
function containedPaths(call: PolicyToolCall): string[] {
  return [
    ...call.reads,
    ...call.writes,
    ...segmentsOf(call).flatMap((segment) => segment.writes.filter((path) => !isDeviceSink(path))),
  ];
}

const SHELL_PROFILE_FILES = new Set([
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".bashrc",
  ".bash_profile",
  ".profile",
]);

const FISH_PROFILE = [".config", "fish", "config.fish"];

function isShellProfile(path: string): boolean {
  return SHELL_PROFILE_FILES.has(baseName(path)) || hasSegmentRun(path, FISH_PROFILE);
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

const LAUNCH_DIRECTORIES = [
  ["Library", "LaunchAgents"],
  ["Library", "LaunchDaemons"],
];

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
    return { subcommand: arg, rest: args.slice(index + 1) };
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

/**
 * Whether a `git config` invocation writes rather than reads.
 *
 * The bare forms are told apart by operand count, since `git config <name>`
 * prints a value and `git config <name> <value>` sets one. Everything not in
 * either flag set — `--local`, `--global` — is a scope, and a scope alone still
 * reads.
 */
function gitConfigWrites(rest: readonly string[]): boolean {
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
  if (value.startsWith("/")) return !isAtOrUnder(workspacePath, value);
  return pathSegments(value).includes("..");
}

const GIT_TREE_FLAGS = ["--git-dir=", "--work-tree="];

const GIT_TREE_SUBCOMMANDS = new Set(["worktree", "clone", "submodule"]);

/** The fragment of a git invocation that aims it at another tree, or null. */
function gitTreeEscape(args: readonly string[], workspacePath: string): string | null {
  for (const [index, arg] of args.entries()) {
    if (arg === "-C" && pointsOutside(argAfter(args, index), workspacePath)) {
      return `-C ${argAfter(args, index)}`;
    }
    const flag = GIT_TREE_FLAGS.find((candidate) => arg.startsWith(candidate));
    if (flag !== undefined && pointsOutside(arg.slice(flag.length), workspacePath)) return arg;
  }
  const invocation = gitInvocation(args);
  if (invocation === null || !GIT_TREE_SUBCOMMANDS.has(invocation.subcommand)) return null;
  const operand = invocation.rest.find(
    (candidate) => !candidate.startsWith("-") && pointsOutside(candidate, workspacePath),
  );
  return operand === undefined ? null : `${invocation.subcommand} ${operand}`;
}

const GIT_REBASE_CONTINUATIONS = new Set(["--abort", "--continue", "--skip", "--quit"]);

/** The fragment of a git invocation that throws uncommitted work away, or null. */
function gitDiscard({ subcommand, rest }: GitInvocation): string | null {
  if (subcommand === "reset" && rest.includes("--hard")) return "reset --hard";
  if (subcommand === "checkout" && rest.filter((arg) => arg !== "--").join(" ") === ".") {
    return "checkout .";
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
  "tool.not-bundled": (call, snapshot) =>
    snapshot.tools.some((tool) => tool === call.tool)
      ? null
      : `"${call.tool}" is not one of this Session's tools (${snapshot.tools.join(", ") || "none"}); use one of those instead.`,

  "path.outside-workspace": (call, _snapshot, context) => {
    for (const path of containedPaths(call)) {
      if (!isAtOrUnder(context.workspacePath, path)) {
        return `${path} is outside the Session workspace ${context.workspacePath}; every read and write must stay inside it.`;
      }
    }
    return null;
  },

  "path.git-internals": (call, _snapshot, context) => {
    const gitDir = gitDirOf(context);
    for (const path of writtenPaths(call)) {
      if (isAtOrUnder(gitDir, path)) {
        return `Writing ${path} is not permitted; hand-editing the repository's plumbing changes what later commands do. Reading it is fine.`;
      }
    }
    for (const segment of segmentsOf(call)) {
      if (baseName(segment.program) !== "git") continue;
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
      if (isAtOrUnder(`${context.workspacePath}/.volli`, path)) {
        return `Writing ${path} is not permitted; .volli holds Volli's own state, not the project's.`;
      }
    }
    return null;
  },

  "command.shell-profile-write": (call) => {
    for (const segment of segmentsOf(call)) {
      for (const path of segment.writes) {
        if (isShellProfile(path)) {
          return `Writing ${path} is not permitted; a shell profile outlives this Session and changes every command run after it.`;
        }
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
      for (const path of segment.writes) {
        if (LAUNCH_DIRECTORIES.some((run) => hasSegmentRun(path, run))) {
          return `Writing ${path} installs a launch item that outlives this Session; do the work now instead.`;
        }
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
    const gitDir = gitDirOf(context);
    for (const segment of segmentsOf(call)) {
      if (baseName(segment.program) !== "rm") continue;
      const recursive = isRecursiveRemoval(segment.args);
      for (const path of segment.paths) {
        // Not a recursive-only case: a single `rm .git/index` is enough to
        // corrupt the repository, and `writtenPaths` never sees an rm operand.
        if (isAtOrUnder(gitDir, path)) {
          return `Removing ${path} would damage the repository; .git is not the Session's to delete.`;
        }
        if (recursive && !isUnder(context.workspacePath, path)) {
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
