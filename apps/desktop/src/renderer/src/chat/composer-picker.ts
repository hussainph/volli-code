/**
 * What the composer's `/` and `@` pickers show, and what picking a row writes.
 *
 * Pure: the caret and the text go in, a list of rows and a replacement come
 * out. The component above it owns only presentation and the two pieces of
 * ephemeral view state a fully-controlled textarea cannot derive — which row is
 * active, and whether Escape has dismissed this token.
 *
 * Neither grammar is invented here. `@` delegates to `editor/file-refs.ts`
 * (which delegates in turn to `@volli/shared`), so the composer's picker, the
 * Monaco editor's autocomplete and the CLI's view of a ref cannot drift apart.
 * `/` delegates to `@volli/shared`'s prompt-template module, whose substitution
 * is Pi's own grammar under a parity test — and offers the project's skills
 * beside the commands, same grammar, different expansion (`skill.ts`).
 *
 * ## Where each trigger fires
 *
 * `@` fires at any ref boundary. `/` fires at a word boundary — the start of
 * the text, or right after whitespace — because a command may sit mid-draft
 * (`please /review a.ts`), but a slash glued inside a word never opens
 * anything: a message that mentions `src/a.ts and/or b` is prose on both
 * sides of both slashes. The same boundary rule decides what expands at
 * submit (`@volli/shared`'s `findCommandInvocations`), so what the picker
 * offers and what the send performs cannot disagree.
 */
import {
  formatPromptTemplateInvocation,
  promptTemplateTakesArgs,
  visibleSkills,
  type IndexedFile,
  type PromptTemplate,
  type SkillReference,
} from "@volli/shared";

import { fileRefTokenAt, rankFileRefCompletions, refInsertion } from "@renderer/editor/file-refs";

/** The `/name` character class — what a template's basename may contain. */
const COMMAND_NAME_CHAR = /[A-Za-z0-9_:-]/;

/** How many command rows one open shows. The file side has its own cap. */
const MAX_COMMAND_RESULTS = 50;

export type ComposerPickerMode = "command" | "file";

/** One row, with everything both the list and the insertion need. */
export type ComposerPickerRow =
  | {
      readonly kind: "command";
      /** cmdk's item value: unique per row, and what "active" names. */
      readonly value: string;
      readonly label: string;
      readonly detail: string;
      readonly template: PromptTemplate;
    }
  | {
      readonly kind: "skill";
      readonly value: string;
      readonly label: string;
      readonly detail: string;
      readonly skill: SkillReference;
    }
  | {
      readonly kind: "file";
      readonly value: string;
      readonly label: string;
      readonly detail: string;
      readonly relPath: string;
      /** A `.volli/artifacts/` file — the tier the ranking already favours. */
      readonly artifact: boolean;
    };

/** An open picker: which token it is replacing, and what it is offering. */
export interface ComposerPickerState {
  readonly mode: ComposerPickerMode;
  /** Offset of the sigil — the start of the range a pick overwrites. */
  readonly from: number;
  /** The caret. A pick never consumes text to its right. */
  readonly to: number;
  /** What has been typed after the sigil. */
  readonly query: string;
  readonly rows: readonly ComposerPickerRow[];
}

/**
 * The `/name` token the caret sits in, or null.
 *
 * The slash must sit at a word boundary — see the header — and the caret must
 * still be inside the name: `/review src/a.ts` with the caret in the path is a
 * command with an argument being typed, not a command being chosen, so the
 * first space after the name is what closes the picker.
 */
export function commandTokenAt(input: {
  text: string;
  offset: number;
}): { from: number; to: number; query: string } | null {
  const { text } = input;
  if (input.offset < 1) return null;
  const offset = Math.min(input.offset, text.length);
  // Walk left over name characters to where the name would start…
  let start = offset;
  while (start > 0 && COMMAND_NAME_CHAR.test(text.charAt(start - 1))) start -= 1;
  // …which must be a slash, itself at a word boundary. A caret past the name
  // walks back over whitespace or an argument first and lands on neither.
  if (start === 0 || text.charAt(start - 1) !== "/") return null;
  const slash = start - 1;
  if (slash > 0 && !/\s/.test(text.charAt(slash - 1))) return null;
  return { from: slash, to: offset, query: text.slice(start, offset) };
}

/**
 * Rank templates for one `/` query.
 *
 * Prefix matches lead, then anything else the name contains, then a match that
 * only the description explains — the order you would guess, and the reason a
 * short query does not bury the command it obviously means. Ties break by name
 * so the list is stable while more characters arrive.
 */
export function rankCommandCompletions(input: {
  query: string;
  templates: readonly PromptTemplate[];
}): readonly ComposerPickerRow[] {
  const query = input.query.toLowerCase();
  return input.templates
    .map((template) => ({ template, tier: commandMatchTier(query, template) }))
    .filter((entry): entry is { template: PromptTemplate; tier: number } => entry.tier !== null)
    .toSorted((a, b) => a.tier - b.tier || a.template.name.localeCompare(b.template.name))
    .slice(0, MAX_COMMAND_RESULTS)
    .map(({ template }) => ({
      kind: "command" as const,
      value: template.name,
      label: `/${template.name}`,
      detail: template.description,
      template,
    }));
}

/** 0 = name prefix, 1 = name contains, 2 = description contains, null = no match. */
function commandMatchTier(query: string, template: PromptTemplate): number | null {
  const name = template.name.toLowerCase();
  if (query === "" || name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (template.description.toLowerCase().includes(query)) return 2;
  return null;
}

/**
 * Rank skills for the same `/` query — the same three tiers over the same two
 * fields, because a skill is invoked by the same grammar. Shadowed names are
 * gone before ranking (`visibleSkills`): a row the submit-time lookup would
 * resolve to a command must not be offered as a skill.
 *
 * Skill rows trail the command rows in the combined list rather than
 * interleaving with them. The two are different kinds of thing — a command is
 * a prompt you wrote, a skill is a document you installed — and the card
 * groups them under separate headings, so the flat row order has to agree
 * with the visual one or the arrow keys walk a different list than the eye.
 */
export function rankSkillCompletions(input: {
  query: string;
  skills: readonly SkillReference[];
  templates: readonly PromptTemplate[];
}): readonly ComposerPickerRow[] {
  const query = input.query.toLowerCase();
  return visibleSkills(input.skills, input.templates)
    .map((skill) => ({ skill, tier: skillMatchTier(query, skill) }))
    .filter((entry): entry is { skill: SkillReference; tier: number } => entry.tier !== null)
    .toSorted((a, b) => a.tier - b.tier || a.skill.name.localeCompare(b.skill.name))
    .slice(0, MAX_COMMAND_RESULTS)
    .map(({ skill }) => ({
      kind: "skill" as const,
      // Prefixed so a value can never collide with a command row's — cmdk's
      // "active" is a value lookup, and two rows answering to one value would
      // highlight together.
      value: `skill:${skill.name}`,
      label: `/${skill.name}`,
      detail: skill.description,
      skill,
    }));
}

/** The command tiers, over a skill's slug and description. */
function skillMatchTier(query: string, skill: SkillReference): number | null {
  const name = skill.name.toLowerCase();
  if (query === "" || name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (skill.description.toLowerCase().includes(query)) return 2;
  return null;
}

/** A trigger token under the caret, before anything is ranked against it. */
export interface ComposerPickerToken {
  readonly mode: ComposerPickerMode;
  readonly from: number;
  readonly to: number;
  readonly query: string;
}

/** The token Escape closed. Held only while the caret stays inside it. */
export interface ComposerPickerDismissal {
  readonly mode: ComposerPickerMode;
  readonly from: number;
}

/**
 * The trigger token under this caret, or null — the grammar alone, with none of
 * {@link composerPickerTarget}'s gates applied and nothing ranked.
 *
 * `/` is checked first and wins outright: a command's slash sits at a word
 * boundary while the slash inside an `@` ref is glued to path characters, so
 * the two can never both be live, and checking in a fixed order removes the
 * question of what would happen if they were.
 *
 * Exported because a dismissal is scoped to a token, and the only honest way to
 * know a dismissal has expired is to notice the caret is no longer in one.
 * Keying that on the token's *position* alone would be wrong in a way that is
 * easy to miss: clear the box, type a new sentence whose `@` happens to land at
 * the same offset, and the old dismissal would silently swallow the new picker.
 */
export function composerPickerToken(input: {
  text: string;
  caret: number;
}): ComposerPickerToken | null {
  const command = commandTokenAt({ text: input.text, offset: input.caret });
  if (command !== null) return { mode: "command", ...command };
  const file = fileRefTokenAt({ text: input.text, offset: input.caret });
  if (file === null) return null;
  return { mode: "file", from: file.from, to: file.to, query: file.query };
}

/**
 * The whole open/closed decision, in one place — and the cheap half of the
 * picker.
 *
 * Three things can keep a picker shut that the caret alone would open, and each
 * is a different kind of no:
 *
 *  - **not ready** — the box is inert; there is nothing to complete *into*.
 *  - **an interaction card is up** — one thing parks above the composer at a
 *    time, and a pending question outranks a list you can reopen by typing.
 *  - **dismissed** — Escape must mean something durable. Without this, Escape
 *    would close the list and the next keystroke would reopen it on the same
 *    token, which reads as the picker refusing to go away. A dismissal is
 *    scoped to the token it was taken on and expires when the caret leaves it;
 *    the caller drops it the moment {@link composerPickerToken} answers null,
 *    which is why this only has to compare the token it was given.
 *
 * ## Why this is separate from {@link composerPickerRows}
 *
 * The two halves of an open picker have different urgencies, and one of them is
 * not negotiable. WHERE it writes — the mode and the `from`/`to` span
 * {@link applyPickerRow} overwrites — has to be exactly the caret's, because a
 * span one keystroke behind the text writes the completion over the wrong range
 * and leaves the characters typed since dangling on the right. WHAT it offers
 * may trail: a list that catches up a frame later is a list, not a corruption.
 *
 * So this half is a few character-class tests and answers on the keystroke's own
 * commit, while the ranking beside it — an O(n log n) pass over the whole
 * project file index — is free to be deferred by the caller.
 */
export function composerPickerTarget(input: {
  text: string;
  caret: number;
  /** The composer can take a message at all. */
  ready?: boolean;
  /** An interaction card holds the slot above the composer. */
  interactionOpen?: boolean;
  dismissed?: ComposerPickerDismissal | null;
}): ComposerPickerToken | null {
  if (input.ready === false || input.interactionOpen === true) return null;
  const token = composerPickerToken(input);
  if (token === null) return null;
  const dismissed = input.dismissed ?? null;
  if (dismissed !== null && dismissed.mode === token.mode && dismissed.from === token.from)
    return null;
  return token;
}

/**
 * What an open token offers — the expensive half, and the reason the two are
 * apart. See {@link composerPickerTarget}.
 *
 * The file branch ranks the entire project index on every call, which is why
 * the caller memoizes it and may hand it a query one or two keystrokes behind
 * the caret.
 */
export function composerPickerRows(input: {
  mode: ComposerPickerMode;
  query: string;
  templates: readonly PromptTemplate[];
  skills?: readonly SkillReference[];
  files: readonly IndexedFile[];
}): readonly ComposerPickerRow[] {
  if (input.mode === "command") {
    return [
      ...rankCommandCompletions({ query: input.query, templates: input.templates }),
      ...rankSkillCompletions({
        query: input.query,
        skills: input.skills ?? [],
        templates: input.templates,
      }),
    ];
  }
  // "Create artifact" is deliberately dropped: it is an intent that writes a
  // file, and the composer has nowhere to open the result. The `@` picker in
  // the editor — which does — keeps it.
  return rankFileRefCompletions({ query: input.query, index: input.files })
    .filter((completion) => completion.kind === "file")
    .map((completion) => ({
      kind: "file" as const,
      value: completion.relPath,
      label: completion.label,
      detail: completion.detail,
      relPath: completion.relPath,
      artifact: completion.artifact,
    }));
}

/** The text and caret a pick produces. */
export interface ComposerPickerInsertion {
  readonly text: string;
  readonly caret: number;
}

/**
 * Write a picked row over the token that opened the picker.
 *
 * A command that reads no argument expands the moment it is picked — there is
 * nothing left to wait for, and showing the prompt you are about to send beats
 * showing a name for it. One that DOES read arguments cannot: they have not
 * been typed. It stages `/name ` and leaves the caret after the space, and the
 * expansion happens at submit, via `@volli/shared`'s `expandCommandInvocation`.
 *
 * Either way a trailing space follows the insertion, which is what closes the
 * picker: the caret ends up outside the token it just replaced. The space is
 * skipped when the text to the right already begins with whitespace, so
 * completing mid-sentence does not leave a double gap.
 */
export function applyPickerRow(input: {
  text: string;
  state: ComposerPickerState;
  row: ComposerPickerRow;
}): ComposerPickerInsertion {
  const { text, state, row } = input;
  const rest = text.slice(state.to);
  const spaced = (body: string): string => (/^\s/.test(rest) ? body : `${body} `);

  const written =
    row.kind === "command"
      ? promptTemplateTakesArgs(row.template)
        ? spaced(`/${row.template.name}`)
        : spaced(formatPromptTemplateInvocation(row.template))
      : row.kind === "skill"
        ? // Always staged, never expanded at pick — twice deliberate. A skill
          // body is a document, and pasting fifteen kilobytes into the box the
          // reader is typing in is not "showing the prompt you are about to
          // send", it is losing the draft under it. And the reference IS what
          // gets sent: at submit the text keeps `/name` and its arguments as
          // typed, while the body rides beside the message as its own resource
          // part (`expandCommandInvocation`) — so the caret parks after the
          // space, exactly like a command that still wants its arguments.
          spaced(`/${row.skill.name}`)
        : spaced(
            refInsertion({
              // `fileRefTokenAt` only matches at a ref boundary, so this is
              // already whitespace, `(`, or start-of-text. Asking anyway is what
              // keeps the one grammar answering the question.
              precedingChar: state.from === 0 ? "" : text.charAt(state.from - 1),
              text: `@${row.relPath}`,
            }),
          );

  return {
    text: `${text.slice(0, state.from)}${written}${rest}`,
    caret: state.from + written.length,
  };
}

/**
 * Move the active row by `delta`, wrapping.
 *
 * Wrapping rather than clamping because the list is short and bottom-anchored:
 * ArrowUp from the first row is how you reach the last one without travelling
 * the whole way down. An unknown active value starts from the top, which is
 * what a freshly re-ranked list wants.
 */
export function movePickerActive(
  rows: readonly ComposerPickerRow[],
  active: string,
  delta: number,
): string {
  if (rows.length === 0) return active;
  const current = rows.findIndex((row) => row.value === active);
  const next = (((current === -1 ? 0 : current + delta) % rows.length) + rows.length) % rows.length;
  // Bounded by the double modulo above, and the list is non-empty by the guard.
  return rows[next]!.value;
}

/** The row `active` names, or the first one — what Enter commits. */
export function activePickerRow(
  rows: readonly ComposerPickerRow[],
  active: string,
): ComposerPickerRow | null {
  return rows.find((row) => row.value === active) ?? rows[0] ?? null;
}
