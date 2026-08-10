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
 * Two failure modes are deliberately not silent. A tool this runtime does not
 * offer keeps its requested name and reaches the rules as an unknown tool,
 * rather than being mapped onto whichever bundled tool it resembles. And a tool
 * path that cannot be resolved throws, rather than being reported as absent:
 * "no such file" and "cannot say what file this is" are different answers, and
 * only the second is a reason to refuse.
 *
 * A command *operand* that cannot be resolved is the same question asked where
 * the answer costs something. Refusing every one of them would deny `echo $PATH`
 * and any script that mentions a variable, and a boundary that fires on ordinary
 * work is one people learn to route around. So the refusal is scoped to the
 * positions a rule actually reads — see {@link OPERAND_READING_PROGRAMS} — and
 * elsewhere the operand is dropped.
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

/** Pi's tool spellings, mapped to the product names the rules are written in. */
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
   * Short flags that take the next token as their value. Without them the value
   * reads as the program — `nice -n 5 rm -rf ~` reported `5` and missed `rm`.
   * Long options are absent because they carry their value with `=`.
   */
  valueFlags: string;
}

/**
 * Programs whose own job is to run another program.
 *
 * Every rule dispatches on the segment's program, so an unstripped `env rm -rf ~`
 * reports `env` and clears rules 6 through 11 in one word. `env`'s assignments
 * are lifted into the segment's environment on the way past, where the
 * TLS-weakening rule already looks for them.
 */
const TRANSPARENT_PREFIXES = new Map<string, Wrapper>([
  ["env", { operands: 0, valueFlags: "u" }],
  ["nohup", { operands: 0, valueFlags: "" }],
  ["time", { operands: 0, valueFlags: "" }],
  ["nice", { operands: 0, valueFlags: "n" }],
  ["ionice", { operands: 0, valueFlags: "cnpPu" }],
  ["stdbuf", { operands: 0, valueFlags: "ioe" }],
  ["command", { operands: 0, valueFlags: "" }],
  ["builtin", { operands: 0, valueFlags: "" }],
  ["exec", { operands: 0, valueFlags: "a" }],
  ["timeout", { operands: 1, valueFlags: "sk" }],
]);

/** `-n` swallows the next token; `-n5` carries its value and does not. */
function takesSeparateValue(arg: string, valueFlags: string): boolean {
  return /^-[A-Za-z]+$/.test(arg) && valueFlags.includes(arg.charAt(arg.length - 1));
}

const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * How far `sh -c '…'` nesting and prefix chaining are followed before the answer
 * is "cannot say". Bounded rather than trusted: the depth is attacker-chosen,
 * and passing the outer shape through at the bound would be the fail-open the
 * unwrapping exists to close.
 */
const MAX_COMMAND_DEPTH = 4;

/** The last path component of a program token, so `/usr/bin/env` reads as `env`. */
function programName(program: string): string {
  return program.slice(program.lastIndexOf("/") + 1);
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
  const wrapper = TRANSPARENT_PREFIXES.get(programName(invocation.program));
  if (wrapper === undefined) return invocation;
  if (depth === MAX_COMMAND_DEPTH) {
    throw new Error(`"${invocation.program}" wraps commands deeper than policy will follow.`);
  }
  const env = [...invocation.env];
  let index = 0;
  let operands = wrapper.operands;
  while (index < invocation.args.length) {
    const arg = invocation.args[index];
    if (isAssignment(arg)) env.push(arg);
    else if (takesSeparateValue(arg, wrapper.valueFlags)) index += 1;
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

/** The script a shell was asked to run, for `sh -c` and its combined-flag spellings. */
function shellScript(invocation: Invocation): string | undefined {
  if (!SHELL_PROGRAMS.has(programName(invocation.program))) return undefined;
  const index = invocation.args.findIndex(
    (arg) => arg.startsWith("-") && !arg.startsWith("--") && arg.includes("c"),
  );
  if (index === -1) return undefined;
  if (index + 1 === invocation.args.length) {
    throw new Error(`"${invocation.program} ${invocation.args[index]}" names no script to run.`);
  }
  return invocation.args[index + 1];
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
    const script = shellScript(invocation);
    if (script !== undefined) segments.push(...policySegments(script, workspacePath, depth + 1));
  }
  return segments;
}

/**
 * Programs whose resolved operands a rule actually reads, folded to agree with
 * the rule table's own case folding.
 *
 * This list is a coupling to `authority-policy.ts` and has to grow with it: if
 * a rule starts resolving operands for another program, that program belongs
 * here or its unresolvable operands will be dropped instead of refused.
 */
const OPERAND_READING_PROGRAMS = new Set(["rm", "git"]);

function policySegment(
  invocation: Invocation,
  lexed: LexedSegment,
  workspacePath: string,
): PolicyCommandSegment {
  const { env, program, args } = invocation;
  const read = OPERAND_READING_PROGRAMS.has(programName(program).toLowerCase());
  return {
    program,
    args,
    paths: operandPaths([program, ...args, ...lexed.readTargets], workspacePath, read),
    // A redirect target is always judged — it is the one operand position every
    // path rule reads, whatever the program.
    writes: operandPaths(lexed.writeTargets, workspacePath, true),
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
 * `judged` says whether a rule will read what comes back. When it will, an
 * operand this process cannot expand — `$TMPDIR`, `~someone` — has to refuse:
 * dropping it would hand the rule a shorter list and a false clean bill. When
 * no rule will read it, dropping is not a concession but the honest answer, and
 * refusing instead would deny `echo $PATH` and every script that mentions a
 * variable, spending the Session's whole fallback budget on nothing.
 */
function operandPaths(tokens: readonly string[], workspacePath: string, judged: boolean): string[] {
  const paths = new Set<string>();
  for (const token of tokens) {
    if (token.startsWith("-") || isAssignment(token)) continue;
    const operand = shellPathTokenToPath(token, workspacePath);
    if (operand.kind === "no-location") continue;
    if (operand.kind === "unresolvable") {
      if (judged) throw new Error(operand.reason);
      continue;
    }
    paths.add(realPath(operand.path, token));
  }
  return [...paths];
}
