/**
 * A Code Mode program, parsed and checked whole before anything runs (VC-471).
 *
 * The sandbox compiles a script before running it too, so a syntax error there
 * also runs nothing. This check exists for the three things the sandbox's own
 * compile does not decide, and it runs on the host, before a worker or a VM
 * exists:
 *
 * 1. **The program is one async function body and nothing else.** The sandbox
 *    builds `(async (tools, console) => {<code>\n})` by string concatenation,
 *    so a program that closes that brace early would run its own top-level
 *    code while the wrapper is evaluated. It could not reach a tool from there
 *    — `tools` is a parameter, not a global — but "the whole program is parsed
 *    before any call runs" should not rest on that. Parsed here as a body,
 *    such a program is a syntax error.
 * 2. **Every tool it names is one it may call.** `tools.<name>` and
 *    `tools["<name>"]` are resolved against the Session's code-callable tools
 *    now, so a misspelt or withheld tool is reported with nothing run, rather
 *    than discovered as a `TypeError` after the first five calls have
 *    happened. `codemode` itself is refused by name.
 * 3. **The options line can only lower the limits.** A program may ask for a
 *    shorter deadline or less output; it cannot ask for more than the
 *    Session's frozen limits.
 *
 * A computed `tools[expression]` is let through: it cannot name anything the
 * sandbox was not handed, and an unknown name fails inside the script before
 * any host code runs.
 */

import { parse, type Node } from "acorn";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { CODE_MODE_TOOL_ID, type CodeModeLimits } from "@volli/shared";

/** The longest program the host will parse. A program is glue, not a payload. */
export const MAX_SCRIPT_BYTES = 64 * 1_024;

export type ScriptCheck =
  | {
      ok: true;
      /** The code to run, with the options line blanked so line numbers stay. */
      code: string;
      /** The limits this run is held to: the frozen ones, lowered by the options line. */
      timeoutMs: number;
      maxOutputBytes: number;
      /** Tool names the program names statically, in first-mention order. */
      references: readonly string[];
    }
  | { ok: false; message: string };

interface Reference {
  name: string;
  line: number;
}

/**
 * Parse and check one program against the names it may call.
 *
 * `callable` maps every name a script may use for a tool — the tool's own name
 * and its identifier spelling — to the tool's name.
 */
export function checkScript(
  source: string,
  callable: ReadonlyMap<string, string>,
  limits: Pick<CodeModeLimits, "timeoutMs" | "maxOutputBytes">,
): ScriptCheck {
  if (Buffer.byteLength(source, "utf8") > MAX_SCRIPT_BYTES) {
    return {
      ok: false,
      message: `The program is longer than ${MAX_SCRIPT_BYTES / 1_024} KiB. Keep it to the calls and the filtering; read data with tools rather than pasting it in.`,
    };
  }
  let parsed;
  try {
    parsed = parseCodemodeSource(source);
  } catch (error) {
    // `CodemodeSourceError` is the only thing it throws: an empty program or
    // an options line that is not one.
    return { ok: false, message: (error as Error).message };
  }
  let program: Node;
  try {
    program = parse(parsed.code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      locations: true,
    });
  } catch (error) {
    return { ok: false, message: `SyntaxError: ${(error as Error).message}` };
  }
  const references = toolReferences(program);
  const unknown: Reference[] = [];
  const names: string[] = [];
  for (const reference of references) {
    if (reference.name === CODE_MODE_TOOL_ID) {
      return {
        ok: false,
        message: `Line ${reference.line}: a program cannot call ${CODE_MODE_TOOL_ID} itself.`,
      };
    }
    const name = callable.get(reference.name);
    if (name === undefined) unknown.push(reference);
    else if (!names.includes(name)) names.push(name);
  }
  if (unknown.length > 0) {
    const listed = unknown.map((reference) => `${reference.name} (line ${reference.line})`);
    return {
      ok: false,
      message: `This Session has no code-callable tool named ${listed.join(", ")}. Nothing was run. Find tools with \`await searchTools("query")\`, or call the tool directly if it is declared to you.`,
    };
  }
  const requestedOutput =
    parsed.options.maxOutputTokens === undefined
      ? limits.maxOutputBytes
      : parsed.options.maxOutputTokens * 4;
  return {
    ok: true,
    code: parsed.code,
    timeoutMs: Math.min(limits.timeoutMs, parsed.options.timeoutMs ?? limits.timeoutMs),
    maxOutputBytes: Math.max(1, Math.min(limits.maxOutputBytes, requestedOutput)),
    references: names,
  };
}

/**
 * Every `tools.<name>` and `tools["<name>"]` in the program.
 *
 * A plain walk over every child node rather than a visitor keyed by node type:
 * the question is the same wherever a member expression sits, and a walk that
 * enumerated parents would miss the one this build of acorn adds next.
 */
function toolReferences(program: Node): Reference[] {
  const found: Reference[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const candidate = node as Partial<Node> & Record<string, unknown>;
    if (typeof candidate.type !== "string") return;
    if (candidate.type === "MemberExpression") {
      const named = memberName(candidate);
      if (named !== undefined) {
        // Parsed with `locations: true`, so every node carries one.
        found.push({ name: named, line: candidate.loc!.start.line });
      }
    }
    for (const [key, value] of Object.entries(candidate)) {
      if (key === "loc") continue;
      visit(value);
    }
  };
  visit(program);
  return found;
}

function memberName(node: Record<string, unknown>): string | undefined {
  const object = node.object as { type?: string; name?: string } | undefined;
  if (object?.type !== "Identifier" || object.name !== "tools") return undefined;
  const property = node.property as { type?: string; name?: string; value?: unknown };
  if (node.computed !== true) return property.name;
  return property.type === "Literal" && typeof property.value === "string"
    ? property.value
    : undefined;
}
