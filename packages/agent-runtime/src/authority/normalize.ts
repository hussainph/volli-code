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
 * rather than being mapped onto whichever bundled tool it resembles. And a path
 * that cannot be resolved throws, rather than being reported as absent: "no
 * such file" and "cannot say what file this is" are different answers, and only
 * the second one is a reason to refuse.
 */

import type {
  CodingToolId,
  PolicyCommand,
  PolicyCommandSegment,
  PolicyToolCall,
} from "@volli/shared";
import { resolveInputPath, resolvePathForPolicy, shellPathTokenToPath } from "./vendor/paths";
import { lexCommandLine, splitProgram, type LexedSegment } from "./vendor/shell";

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

/** A tool's `path` argument, resolved the way the tool itself will resolve it. */
function resolveToolPath(raw: string, workspacePath: string): string {
  const absolute = resolveInputPath(workspacePath, raw);
  if (absolute === undefined) throw new Error("A tool path argument named no path.");
  return realPath(absolute, raw);
}

/** `named` is what the caller wrote, so a refusal names the operand and not its expansion. */
function realPath(candidate: string, named: string): string {
  const resolved = resolvePathForPolicy(candidate);
  if (resolved === undefined) throw new Error(`"${named}" has no resolvable real path.`);
  return resolved;
}

function lexCommand(raw: string, workspacePath: string): PolicyCommand {
  return {
    raw,
    segments: lexCommandLine(raw).map((segment) => policySegment(segment, workspacePath)),
  };
}

function policySegment(segment: LexedSegment, workspacePath: string): PolicyCommandSegment {
  const { env, program, args } = splitProgram(segment.words);
  return {
    program,
    args,
    paths: operandPaths([program, ...args, ...segment.readTargets], workspacePath),
    writes: operandPaths(segment.writeTargets, workspacePath),
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
 */
function operandPaths(tokens: readonly string[], workspacePath: string): string[] {
  const paths = new Set<string>();
  for (const token of tokens) {
    if (token.startsWith("-")) continue;
    const candidate = shellPathTokenToPath(token, workspacePath);
    if (candidate === undefined) continue;
    paths.add(realPath(candidate, token));
  }
  return [...paths];
}
