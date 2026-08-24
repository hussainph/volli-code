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
import type { PromptResource } from "./agent-runtime";
import { isComposerVerbName } from "./composer-verb";
import { resolveSlashNamespace, slashTargets } from "./slash-namespace";
import { skillPromptResource, type SkillReference } from "./skill";

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
  /**
   * The tier that supplied this command after a merge. Optional so Pi's
   * grammar can still receive its native three-field structural shape.
   */
  readonly source?: "project" | "personal";
}

/** Longest description a body's first line may supply before it is elided. */
const DERIVED_DESCRIPTION_LIMIT = 60;

/** The `/name` character class — what a command name may contain. */
const COMMAND_NAME_CHAR = /[A-Za-z0-9_:-]/;

/**
 * The names Volli will CREATE a template file for — a strict subset of the
 * names it can read and invoke.
 *
 * Two rules meet here, and the narrower one wins:
 *
 *  - **It has to be invokable whole.** {@link findCommandInvocations} reads a
 *    name up to the first character outside {@link COMMAND_NAME_CHAR}, so a
 *    file called `ship it.md` is reachable only as `/ship` — a command whose
 *    own name cannot summon it.
 *  - **It has to be a safe flat filename**, because the basename IS the
 *    invocation. That excludes `:`, which the `/` grammar happily allows and
 *    macOS does not: HFS+ and APFS store it but Finder renders it as `/`, so
 *    the file a user sees is not the file they made. It also excludes `.` and
 *    `..`, and anything with a separator in it.
 *
 * Reading stays deliberately more permissive than writing. A template someone
 * hand-authored with a `:` in it still loads and still runs — this rule governs
 * only what the app is willing to author on their behalf.
 */
export function isWritablePromptTemplateName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

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
  for (const template of input.global)
    byName.set(template.name, { ...template, source: "personal" });
  for (const template of input.project)
    byName.set(template.name, { ...template, source: "project" });
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

/** A `/name args` invocation split into the parts expansion needs. */
export interface CommandInvocation {
  /** The name typed after `/`, without the slash. */
  readonly name: string;
  /** Everything after the name to the end of its line, unparsed — `parseCommandArgs`' input. */
  readonly argsString: string;
  /** Offset of the `/` — where an expansion's replacement begins. */
  readonly start: number;
  /** End of the invocation's line — where an expansion's replacement stops. */
  readonly end: number;
}

/**
 * Every place this text could be invoking a command.
 *
 * A candidate is a `/` at a word boundary — the start of the text, or right
 * after whitespace — whose name ends at a boundary of its own. That is what
 * keeps prose safe on both sides of the slash: `and/or` and `src/app.ts` glue
 * the slash to a word, so neither is a candidate, and `/review.md` runs the
 * name into a character it cannot contain, so it never was one. `/reviewer`
 * is not `/review` with the argument "er" for the same reason.
 *
 * An invocation's arguments run to the end of its LINE. The line is the unit
 * of invocation: `/review a.ts` on one line and a sentence on the next are a
 * command and a sentence, not a command with the sentence smuggled in as
 * arguments — which is also what lets a staged command sit mid-draft at all.
 *
 * Whether a name resolves to a template is a separate question — see
 * {@link expandCommandInvocation} — because "unknown command" and "not a
 * command at all" must not send the same text.
 */
export function findCommandInvocations(text: string): readonly CommandInvocation[] {
  const invocations: CommandInvocation[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charAt(i) !== "/") continue;
    // The slash must sit at a word boundary: a slash inside a word is prose.
    if (i > 0 && !/\s/.test(text.charAt(i - 1))) continue;
    let nameEnd = i + 1;
    while (nameEnd < text.length && COMMAND_NAME_CHAR.test(text.charAt(nameEnd))) nameEnd += 1;
    // A bare slash names nothing, and a name must END at a boundary too.
    if (nameEnd === i + 1) continue;
    if (nameEnd < text.length && !/\s/.test(text.charAt(nameEnd))) continue;
    const newline = text.indexOf("\n", nameEnd);
    const end = newline === -1 ? text.length : newline;
    invocations.push({
      name: text.slice(i + 1, nameEnd),
      argsString: text.slice(nameEnd, end).trim(),
      start: i,
      end,
    });
  }
  return invocations;
}

/** What a message with `/command`s in it actually submits — see {@link expandCommandInvocation}. */
export interface ExpandedInvocation {
  /** The message text: templates expanded in place, skill references intact. */
  readonly text: string;
  /**
   * The skill bodies the message's `/slug` references resolved to, in
   * invocation order, one per skill however often it was named. They travel
   * beside the text — attached to the message as their own typed parts
   * (`skillResourcePart`) and appended after it as delimited RESOURCE blocks
   * where the delivered prompt is composed (`appendPromptResources`) — never
   * spliced into the user's words.
   */
  readonly resources: readonly PromptResource[];
}

/**
 * The text a message with `/command`s in it actually sends, and the skill
 * resources that ride beside it.
 *
 * Client-side expansion, and the last thing that happens before the existing
 * submit path takes over: each known template `/name` at a word boundary
 * becomes its template's body with the rest of its line substituted in as
 * arguments, in place — text before it, and every other line, pass through
 * untouched. A known command consumes its whole line, so a second `/name` on
 * the same line is an argument, not a second command; an UNKNOWN one consumes
 * nothing, so it neither blocks a later command on its line nor vanishes
 * itself.
 *
 * A `/name` may also be a SKILL (`skill.ts`): the same grammar, the same
 * line-scoped consumption, a different delivery. A template's body replaces
 * its invocation because the invocation IS shorthand for that text; a skill
 * reference is not shorthand — it is the user naming a document — so the
 * reference stays in the text exactly as typed (mid-sentence included) and
 * the body joins {@link ExpandedInvocation.resources} instead (VC-49).
 * Rewriting the sentence around it produced a message that read as if the
 * person had pasted the whole SKILL.md themselves. The skill still consumes
 * its line — the words after it are its arguments, left in place where the
 * model reads them beside the reference — so a template `/name` later on that
 * line stays an argument, exactly as before. Templates win a shared bare name
 * outright; the skill that lost it is not gone, but answers to `skill:<name>`
 * (`resolveSlashNamespace`), and that qualified name resolves here too.
 *
 * An unknown command is deliberately NOT an error: the harness is perfectly
 * able to read a sentence that mentions a slash, and swallowing it would lose
 * the message.
 *
 * A built-in VERB's name resolves to neither, whatever the two lists hold —
 * see `composer-verb.ts`. Nothing is expanded and nothing is dropped: the text
 * passes through exactly as typed, which is what leaves the press free to run
 * the operation instead of sending a message.
 */
export function expandCommandInvocation(
  text: string,
  templates: readonly PromptTemplate[],
  skills: readonly SkillReference[] = [],
): ExpandedInvocation {
  let result = "";
  let cursor = 0;
  const resources = new Map<string, PromptResource>();
  // The same resolution the picker offers, computed from the same two lists
  // rather than trusted from the caller. This function is the submit-time
  // authority: a caller that passed pre-filtered arrays would be a caller that
  // could disagree with the picker about which `/compact` is which, and the
  // whole point of one namespace is that the offer and the press cannot.
  const targets = slashTargets(resolveSlashNamespace({ templates, skills }));
  for (const invocation of findCommandInvocations(text)) {
    // Consumed already: this candidate sits inside a known command's arguments.
    if (invocation.start < cursor) continue;
    // A reserved name expands to nothing, so a `commands/compact.md` a user
    // happens to have cannot quietly turn the verb into a message. That file is
    // no longer lost, though — it answers to `/command:compact`, which IS in
    // the map below.
    if (isComposerVerbName(invocation.name)) continue;
    const target = targets.get(invocation.name);
    if (target === undefined) continue;
    result += text.slice(cursor, invocation.start);
    if (target.kind === "command") {
      result += formatPromptTemplateInvocation(
        target.template,
        parseCommandArgs(invocation.argsString),
      );
    } else {
      // The reference and its line stay verbatim; only the resource is new.
      result += text.slice(invocation.start, invocation.end);
      if (!resources.has(target.skill.name)) {
        resources.set(target.skill.name, skillPromptResource(target.skill));
      }
    }
    cursor = invocation.end;
  }
  // Nothing expanded — the exact string in is the exact string out.
  if (cursor === 0) return { text, resources: [...resources.values()] };
  return { text: result + text.slice(cursor), resources: [...resources.values()] };
}
