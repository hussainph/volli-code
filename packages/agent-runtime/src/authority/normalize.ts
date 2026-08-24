/**
 * One Pi tool call, turned into the data a policy rule can decide on.
 *
 * This is the half of the Authority layer that cannot be pure. `@volli/shared`
 * owns the rules and may not import `node:*`, so everything that needs a
 * filesystem or a shell lexer happens here first: operands become absolute,
 * symlink-free paths, and a command line becomes lexed segments. What crosses
 * back is a {@link PolicyToolCall} — plain data, no Pi types, no live paths
 * left to interpret.
 *
 * A name with no mapping keeps its own spelling and reaches the rules carrying
 * nothing — no path, no command, no environment — rather than being mapped onto
 * whichever bundled tool it resembles. That is how an interaction tool is
 * judged, and the answer is always "allow", because every rule reads an empty
 * list. Guessing instead would be the harmful direction: `ask_user`'s `question`
 * or `web_fetch`'s `url` read as a path would have policy refuse a call over an
 * operand the tool never opens. The map holds coding tools because those are
 * the tools whose arguments this layer can actually interpret.
 *
 * A tool path that cannot be resolved throws, rather than being reported as
 * absent: "no such file" and "cannot say what file this is" are different
 * answers, and only the second is a reason to refuse.
 *
 * A command *operand* that cannot be resolved is the same question asked where
 * the answer costs something. Refusing every one of them would deny `echo $PATH`
 * and any script that mentions a variable, and a boundary that fires on ordinary
 * work is one people learn to route around. So the refusal is scoped to the
 * positions a rule actually reads — see {@link judgedOperands} — and elsewhere
 * the operand is dropped.
 */

import type {
  CodingToolId,
  PolicyCommand,
  PolicyCommandSegment,
  PolicyToolCall,
} from "@volli/shared";
import { normalizeToolPath } from "./pi-tool-path";
import { resolveInputPath, resolvePathForPolicy, shellPathTokenToPath } from "./vendor/paths";
import { isAssignment, lexCommandLine, splitProgram, type LexedSegment } from "./vendor/shell";

/**
 * Pi's tool spellings, mapped to the product names the rules are written in.
 *
 * Coding tools only, and complete for them: `bash` is the sole entry whose two
 * names differ, which is the whole reason this map exists. An interaction tool
 * (`ask_user`, `web_fetch`, `web_search`) is absent by design rather than by
 * omission — its Pi name and its product name are the same string, and nothing
 * below would know what to do with its arguments anyway.
 *
 * A VERB tool is the third case, and the one this map does NOT reconcile
 * (VC-162). Its two names differ the way `bash`/`execute` do — the registry
 * key `session.start` reaches the provider as `session_start`, because no
 * provider accepts a dot — but unlike a coding tool there is nothing here that
 * could interpret its arguments, so mapping it would buy nothing. It therefore
 * falls through to the pass-through below and is judged under its WIRE name,
 * while `AuthoritySnapshot.tools` records the dot-key.
 *
 * That split is safe only while no rule keys on a verb tool's name: every rule
 * reads the empty operand lists a pass-through carries, so the answer is allow
 * either way. It stops being safe the moment one does. A rule written against
 * `session.start` would never match `session_start` and would fail OPEN, which
 * is the one direction this layer refuses to fail — so the rule vocabulary and
 * this map have to be settled together (VC-3), not one before the other.
 */
const CODING_TOOL_BY_PI_NAME = new Map<string, CodingToolId>([
  ["read", "read"],
  ["edit", "edit"],
  ["write", "write"],
  ["bash", "execute"],
]);

/**
 * The Session workspace as the rules must compare against it.
 *
 * A workspace under `/var/folders/…` or any other symlinked root resolves to a
 * different absolute path than its operands do. Comparing an unresolved root
 * against resolved operands makes every path rule conclude "outside the
 * workspace" or "inside" by accident, so the root goes through the same
 * resolution as everything it is compared with.
 */
export function resolveWorkspaceRoot(workspacePath: string): string {
  const resolved = resolvePathForPolicy(workspacePath);
  if (resolved === undefined) {
    throw new Error(`The Session workspace ${workspacePath} has no resolvable real path.`);
  }
  return resolved;
}

export function normalizeToolCall(input: {
  tool: string;
  args: unknown;
  workspacePath: string;
}): PolicyToolCall {
  const workspacePath = resolveWorkspaceRoot(input.workspacePath);
  const tool = CODING_TOOL_BY_PI_NAME.get(input.tool);
  if (tool === undefined) return { tool: input.tool, reads: [], writes: [], command: null };
  if (tool === "execute") {
    const raw = stringArgument(input.args, "command", input.tool);
    return { tool, reads: [], writes: [], command: lexCommand(raw, workspacePath) };
  }
  const path = resolveToolPath(stringArgument(input.args, "path", input.tool), workspacePath);
  return tool === "read"
    ? { tool, reads: [path], writes: [], command: null }
    : { tool, reads: [], writes: [path], command: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pi validates arguments against the tool schema before this runs, so a missing
 * or mistyped field means the call is not the call it claims to be. Refusing to
 * describe it is the honest outcome; the caller blocks on the throw.
 */
function stringArgument(args: unknown, field: string, tool: string): string {
  if (!isRecord(args)) throw new Error(`Pi tool ${tool} was called without arguments.`);
  const value = args[field];
  if (typeof value !== "string") {
    throw new Error(`Pi tool ${tool} was called without a ${field} argument.`);
  }
  return value;
}

/**
 * A tool's `path` argument, resolved the way the tool itself will resolve it.
 *
 * Pi's own normalization runs first, and must: it strips a leading `@` and
 * collapses Unicode spaces, so `@.git/hooks/pre-commit` opens `.git/hooks/…`.
 * Inspecting the raw argument would have policy judge a file that is never
 * touched while the tool writes one that was never judged.
 */
function resolveToolPath(raw: string, workspacePath: string): string {
  const absolute = resolveInputPath(workspacePath, normalizeToolPath(raw));
  if (absolute === undefined) throw new Error("A tool path argument named no path.");
  return realPath(absolute, raw);
}

/** `named` is what the caller wrote, so a refusal names the operand and not its expansion. */
function realPath(candidate: string, named: string): string {
  const resolved = resolvePathForPolicy(candidate);
  if (resolved === undefined) throw new Error(`"${named}" has no resolvable real path.`);
  return resolved;
}

/** How much of a wrapper's own command line comes before the program it runs. */
interface Wrapper {
  /** Bare operands of the wrapper's own that come before the command: `timeout 5 cmd`. */
  operands: number;
  /**
   * Flags that take the *next token* as their value. Without them the value
   * reads as the program — `nice -n 5 rm -rf ~` reported `5` and missed `rm`.
   * Matched whole, so `-n 5` is a value and `-n5` carries its own.
   */
  valueFlags: Set<string>;
}

const wrapper = (operands: number, ...valueFlags: string[]): Wrapper => ({
  operands,
  valueFlags: new Set(valueFlags),
});

/**
 * Programs whose own job is to run another program.
 *
 * Every rule dispatches on the segment's program, so an unstripped `env rm -rf ~`
 * reports `env` and clears rules 6 through 11 in one word. `env`'s assignments
 * are lifted into the segment's environment on the way past, where the
 * TLS-weakening rule already looks for them. The table is macOS-first: entries
 * were checked against what actually ships on the target platform, not against
 * a general-Unix memory.
 */
const TRANSPARENT_PREFIXES = new Map<string, Wrapper>([
  // BSD env's `-S` is `sh -c` without the shell; `nestedScript` re-lexes it.
  ["env", wrapper(0, "-u", "-P", "-S")],
  ["nohup", wrapper(0)],
  ["time", wrapper(0)],
  ["nice", wrapper(0, "-n")],
  ["stdbuf", wrapper(0, "-i", "-o", "-e")],
  ["command", wrapper(0)],
  ["builtin", wrapper(0)],
  ["exec", wrapper(0, "-a")],
  // Stock macOS, all verified to run their argument.
  ["arch", wrapper(0, "-arch")],
  ["caffeinate", wrapper(0, "-t", "-w")],
  ["script", wrapper(1, "-F", "-t")],
  ["xcrun", wrapper(0, "--sdk", "--toolchain", "-sdk", "-toolchain")],
  ["sandbox-exec", wrapper(0, "-p", "-f", "-D")],
  // Not stock macOS. Retained because `/opt/homebrew` and `/usr/local` are on
  // the PATH a command inherits, so either can be present; an entry for an
  // absent program costs nothing, while a missing entry for a present one is a
  // bypass.
  ["timeout", wrapper(1, "-s", "-k", "--signal", "--kill-after")],
  ["ionice", wrapper(0, "-c", "-n", "-p", "-P", "-u")],
]);

function takesSeparateValue(arg: string, wrapping: Wrapper): boolean {
  return wrapping.valueFlags.has(arg);
}

const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * How far `sh -c '…'` nesting and prefix chaining are followed before the answer
 * is "cannot say". Bounded rather than trusted: the depth is attacker-chosen,
 * and passing the outer shape through at the bound would be the fail-open the
 * unwrapping exists to close.
 */
const MAX_COMMAND_DEPTH = 4;

/**
 * The last path component of a program token, folded — `/usr/bin/ENV` is `env`.
 *
 * Folded because the rule table folds, and because macOS resolves `ENV` and
 * `RM` on a case-insensitive volume. A comparison here that did not fold would
 * let an uppercase spelling through a table the rules then read case-blind.
 */
function programName(program: string): string {
  return program.slice(program.lastIndexOf("/") + 1).toLowerCase();
}

interface Invocation {
  program: string;
  args: string[];
  env: string[];
}

/**
 * Peel transparent prefixes until the segment names the program that will run.
 *
 * The wrapper's own flags, flag values, and operands are stepped over; anything
 * left is the real command. The residual limit is a value-taking short flag not
 * in {@link Wrapper.valueFlags} — a wrapper option added upstream after this
 * table was written would hide its value's successor once more.
 */
function unwrapPrefixes(invocation: Invocation, depth: number): Invocation {
  const wrapping = TRANSPARENT_PREFIXES.get(programName(invocation.program));
  if (wrapping === undefined) return invocation;
  if (depth === MAX_COMMAND_DEPTH) {
    throw new Error(`"${invocation.program}" wraps commands deeper than policy will follow.`);
  }
  const env = [...invocation.env];
  let index = 0;
  let operands = wrapping.operands;
  while (index < invocation.args.length) {
    const arg = invocation.args[index];
    if (isAssignment(arg)) env.push(arg);
    else if (takesSeparateValue(arg, wrapping)) index += 1;
    else if (!arg.startsWith("-")) {
      if (operands === 0) break;
      operands -= 1;
    }
    index += 1;
  }
  if (index >= invocation.args.length) return { ...invocation, env };
  return unwrapPrefixes(
    { program: invocation.args[index], args: invocation.args.slice(index + 1), env },
    depth + 1,
  );
}

/**
 * The command line a program was handed to run as text, rather than exec.
 *
 * Two spellings: a shell's `-c`, and BSD `env -S`, which is `sh -c` without the
 * shell. Both throw when the script is missing, and that matters more than it
 * looks — the outer segment is retained and reports `sh`, a program no rule
 * refuses, so falling back to it would file the payload where nothing reads it.
 */
function nestedScript(invocation: Invocation): string | undefined {
  const { program, args } = invocation;
  if (programName(program) === "env") return valueAfter(invocation, args.indexOf("-S"));
  if (!SHELL_PROGRAMS.has(programName(program))) return undefined;
  return valueAfter(
    invocation,
    args.findIndex((arg) => arg.startsWith("-") && !arg.startsWith("--") && arg.includes("c")),
  );
}

/**
 * The flag's value, skipping the `--` end-of-options marker.
 *
 * `bash -c -- 'rm -rf ~'` used to hand `--` back as the whole script, so the
 * real command was never lexed at all.
 */
function valueAfter(invocation: Invocation, index: number): string | undefined {
  if (index === -1) return undefined;
  const rest = invocation.args.slice(index + 1);
  const script = rest[0] === "--" ? rest[1] : rest[0];
  if (script === undefined) {
    throw new Error(`"${invocation.program} ${invocation.args[index]}" names no script to run.`);
  }
  return script;
}

function lexCommand(raw: string, workspacePath: string): PolicyCommand {
  return { raw, segments: policySegments(raw, workspacePath, 0) };
}

/**
 * One command line as the rules see it: its own segments, plus the segments of
 * any script it hands to a shell, spliced in after the shell's own segment. The
 * shell really does run, so its redirects stay its own.
 */
function policySegments(
  commandLine: string,
  workspacePath: string,
  depth: number,
): PolicyCommandSegment[] {
  if (depth === MAX_COMMAND_DEPTH) {
    throw new Error("This command nests shells deeper than policy will follow.");
  }
  const segments: PolicyCommandSegment[] = [];
  for (const lexed of lexCommandLine(commandLine)) {
    const invocation = unwrapPrefixes(splitProgram(lexed.words), 0);
    segments.push(policySegment(invocation, lexed, workspacePath));
    const script = nestedScript(invocation);
    if (script !== undefined) segments.push(...policySegments(script, workspacePath, depth + 1));
  }
  return segments;
}

/** git's flags whose value is a tree, and the only git operands a rule resolves. */
const GIT_PATH_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--exec-path"]);

/**
 * Which of a segment's operands must resolve or refuse.
 *
 * A coupling to `authority-policy.ts`, and it has to move with it. `rm` is
 * strict everywhere, because every operand is a deletion target. `git` is strict
 * only where a path is actually expected: `git commit -m "$MSG"` is close to
 * universal in agent scripts, and refusing it three times would exhaust the
 * Session's fallback budget over a commit message. Everything else is strict
 * nowhere — no rule resolves its operands, so an unexpandable one is dropped.
 */
function judgedOperands(invocation: Invocation): (token: string) => boolean {
  const name = programName(invocation.program);
  if (name === "rm") return () => true;
  if (name !== "git") return () => false;
  const trees = new Set(
    invocation.args.filter((_arg, index) => GIT_PATH_FLAGS.has(invocation.args[index - 1] ?? "")),
  );
  return (token) => trees.has(token);
}

function policySegment(
  invocation: Invocation,
  lexed: LexedSegment,
  workspacePath: string,
): PolicyCommandSegment {
  const { env, program, args } = invocation;
  return {
    program,
    args,
    paths: operandPaths(
      [program, ...args, ...lexed.readTargets],
      workspacePath,
      judgedOperands(invocation),
    ),
    // A redirect target is always judged — it is the one operand position every
    // path rule reads, whatever the program.
    writes: operandPaths(lexed.writeTargets, workspacePath, () => true),
    env,
  };
}

/**
 * Every operand that is not a flag is resolved as a path, the program included.
 *
 * Deliberately over-inclusive. Under-inclusion is the dangerous direction: `rm
 * -rf .git` and `rm -rf ~` carry no path separator, and a rule that never sees
 * them cannot refuse them. Over-inclusion costs nothing, because a bare word
 * like `status` resolves inside the workspace, where no path rule fires.
 *
 * `judged` says whether a rule will read a given operand. Where one will, an
 * operand this process cannot expand — `$TMPDIR`, `~someone` — has to refuse:
 * dropping it would hand the rule a shorter list and a false clean bill. Where
 * none will, dropping is not a concession but the honest answer, and refusing
 * instead would deny `echo $PATH` and every script that mentions a variable,
 * spending the Session's whole fallback budget on nothing.
 */
function operandPaths(
  tokens: readonly string[],
  workspacePath: string,
  judged: (token: string) => boolean,
): string[] {
  const paths = new Set<string>();
  for (const token of tokens) {
    if (token.startsWith("-") || isAssignment(token)) continue;
    const operand = shellPathTokenToPath(token, workspacePath);
    if (operand.kind === "no-location") continue;
    if (operand.kind === "unresolvable") {
      if (judged(token)) throw new Error(operand.reason);
      continue;
    }
    paths.add(realPath(operand.path, token));
  }
  return [...paths];
}
