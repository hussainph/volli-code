/**
 * Prompt templates — the `/command` grammar, as pure data.
 *
 * A prompt template is a `.md` file whose body IS the prompt: typing
 * `/review src/app.ts` in the composer expands to that body with the arguments
 * substituted, and what the Session sends is ordinary text. Nothing about a
 * `/` reaches main or the runtime; expansion happens in the renderer, before
 * the message enters the existing submit path.
 *
 * ## Why this file is a port and not an import
 *
 * The substitution grammar is Pi's. `@earendil-works/pi-agent-core` exports
 * `parseCommandArgs` / `substituteArgs` / `formatPromptTemplateInvocation` as
 * pure functions, and importing them would have been the obvious move — but the
 * renderer cannot reach them:
 *
 *  - the package's `exports` map publishes only `.`, `./node` and
 *    `./session/testing`, so the deep path
 *    `…/dist/harness/prompt-templates.js` resolves to
 *    `ERR_PACKAGE_PATH_NOT_EXPORTED`;
 *  - the root barrel re-exports the whole harness, which reaches
 *    `@earendil-works/pi-ai`'s `dist/auth/context.js` and its `node:` builtins.
 *    That import does not merely bloat the renderer bundle — it fails to load
 *    in a browser, which is where the UI lab runs.
 *
 * So the four functions below are a verbatim port of
 * `pi-agent-core@0.84.1/dist/harness/prompt-templates.js`, and the drift guard
 * is a real one: `packages/agent-runtime/src/prompt-template-parity.test.ts`
 * imports Pi's own implementations — which it CAN, being a main-side package
 * that already depends on them — and asserts this module agrees with them over
 * a corpus. If Pi changes the grammar, that test fails; it is the reason this
 * duplication is safe rather than the usual kind.
 *
 * Pure string ops only, so the renderer, main and the CLI share one grammar —
 * the same rule `file-ref.ts` follows for `@path`.
 */

/**
 * One loaded template. Structurally Pi's `PromptTemplate`, and deliberately so:
 * main produces this shape from disk and the parity test pins the fields.
 * `description` is always a string — empty when neither the frontmatter nor the
 * body could supply one — because a nullable field here buys nothing a `""`
 * check does not.
 */
export interface PromptTemplate {
  /** The file's basename without `.md` — what the user types after `/`. */
  readonly name: string;
  /** The frontmatter `description`, or the body's first line. May be `""`. */
  readonly description: string;
  /** The prompt itself: the file body, frontmatter stripped. */
  readonly content: string;
}

/** Longest description a body's first line may supply before it is elided. */
const DERIVED_DESCRIPTION_LIMIT = 60;

/** The `/name` character class — what a command name may contain. */
const COMMAND_NAME_CHAR = /[A-Za-z0-9_:-]/;

/**
 * Parse an argument string using simple shell-style single and double quotes.
 *
 * Port of Pi's `parseCommandArgs` — see this module's header.
 */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote !== null) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Substitute prompt-template placeholders (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`,
 * `${@:N:L}`) with command arguments.
 *
 * Port of Pi's `substituteArgs` — see this module's header. A placeholder with
 * no matching argument becomes the empty string rather than staying literal,
 * which is what makes an optional trailing argument work at all.
 */
export function substituteArgs(content: string, args: readonly string[]): string {
  let result = content;
  result = result.replace(/\$(\d+)/g, (_, num: string) => args[Number.parseInt(num, 10) - 1] ?? "");
  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_, startStr: string, lengthStr: string | undefined) => {
      const parsed = Number.parseInt(startStr, 10) - 1;
      const start = parsed < 0 ? 0 : parsed;
      if (lengthStr) return args.slice(start, start + Number.parseInt(lengthStr, 10)).join(" ");
      return args.slice(start).join(" ");
    },
  );
  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);
  return result;
}

/**
 * Format a prompt-template invocation with positional arguments.
 *
 * Port of Pi's `formatPromptTemplateInvocation` — see this module's header.
 */
export function formatPromptTemplateInvocation(
  template: PromptTemplate,
  args: readonly string[] = [],
): string {
  return substituteArgs(template.content, args);
}

/**
 * Whether this template reads any argument.
 *
 * The picker branches on it: a template that takes arguments cannot be expanded
 * the moment it is picked — the arguments are not typed yet — so selecting it
 * stages `/name ` and leaves the caret after the space. One that takes none has
 * nothing to wait for and expands immediately.
 */
export function promptTemplateTakesArgs(template: PromptTemplate): boolean {
  return /\$(?:\d+|@|ARGUMENTS|\{@:\d+(?::\d+)?\})/.test(template.content);
}

/**
 * The description a template shows in the picker.
 *
 * Pi's rule, kept because the files are Pi's format: the frontmatter's
 * `description` when it is a string, else the body's first non-blank line
 * clipped to 60 characters with an ellipsis — a template file whose author
 * wrote no frontmatter still gets a legible second column.
 */
export function promptTemplateDescription(input: {
  body: string;
  frontmatterDescription: unknown;
}): string {
  const declared = input.frontmatterDescription;
  if (typeof declared === "string" && declared !== "") return declared;
  const firstLine = input.body.split("\n").find((line) => line.trim());
  if (firstLine === undefined) return "";
  return firstLine.length > DERIVED_DESCRIPTION_LIMIT
    ? `${firstLine.slice(0, DERIVED_DESCRIPTION_LIMIT)}...`
    : firstLine;
}

/**
 * The two tiers merged into the one list the picker shows: the project's
 * `.volli/commands/` wins a name the global `<userData>/commands/` also
 * defines.
 *
 * Precedence is by name, not by file: a project template named `review`
 * replaces the global `review` outright rather than joining it, because two
 * rows spelled `/review` are two rows the user cannot tell apart. Sorted by
 * name so the list does not reorder itself when a tier loads.
 */
export function mergePromptTemplates(input: {
  project: readonly PromptTemplate[];
  global: readonly PromptTemplate[];
}): readonly PromptTemplate[] {
  const byName = new Map<string, PromptTemplate>();
  for (const template of input.global) byName.set(template.name, template);
  for (const template of input.project) byName.set(template.name, template);
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

/** A `/name args` invocation split into the parts expansion needs. */
export interface CommandInvocation {
  /** The name typed after `/`, without the slash. */
  readonly name: string;
  /** Everything after the name, unparsed — `parseCommandArgs`' input. */
  readonly argsString: string;
}

/**
 * The `/name args` invocation this text opens with, or null.
 *
 * Only at offset 0, and only when a name actually follows the slash: a message
 * that merely mentions `and/or` is not an invocation, and neither is a bare
 * `/`. Whether the name resolves to a template is a separate question — see
 * {@link expandCommandInvocation} — because "unknown command" and "not a
 * command at all" must not send the same text.
 */
export function parseCommandInvocation(text: string): CommandInvocation | null {
  if (!text.startsWith("/")) return null;
  let end = 1;
  while (end < text.length && COMMAND_NAME_CHAR.test(text.charAt(end))) end += 1;
  if (end === 1) return null;
  const rest = text.slice(end);
  // A name must END at a boundary. `/reviewer` is not `/review` with the
  // argument "er", so anything that is neither whitespace nor end-of-text
  // means this was never the command it looked like.
  if (rest !== "" && !/^\s/.test(rest)) return null;
  return { name: text.slice(1, end), argsString: rest.trim() };
}

/**
 * The text a `/command` message actually sends.
 *
 * Client-side expansion, and the last thing that happens before the existing
 * submit path takes over: a known `/name` becomes its template's body with the
 * arguments substituted, and everything else — plain prose, an unknown
 * `/name` — passes through untouched. An unknown command is deliberately NOT
 * an error: the harness is perfectly able to read a sentence that starts with a
 * slash, and swallowing it would lose the message.
 */
export function expandCommandInvocation(
  text: string,
  templates: readonly PromptTemplate[],
): string {
  const invocation = parseCommandInvocation(text);
  if (invocation === null) return text;
  const template = templates.find((candidate) => candidate.name === invocation.name);
  if (template === undefined) return text;
  return formatPromptTemplateInvocation(template, parseCommandArgs(invocation.argsString));
}
