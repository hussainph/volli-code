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
 * is Pi's own grammar under a parity test.
 *
 * ## Why the two triggers are not symmetric
 *
 * `@` fires at any ref boundary, because a file reference is a word inside a
 * sentence. `/` fires only at offset 0, because a command is not a word in a
 * sentence — it IS the message, and its expansion replaces the whole thing.
 * That asymmetry is the feature: a message that mentions `src/a.ts and/or b`
 * must not open a command picker halfway through.
 */
import {
  formatPromptTemplateInvocation,
  promptTemplateTakesArgs,
  type IndexedFile,
  type PromptTemplate,
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

/** The `/name` token the caret sits in, or null. Offset 0 only — see the header. */
export function commandTokenAt(input: {
  text: string;
  offset: number;
}): { from: number; to: number; query: string } | null {
  const { text } = input;
  if (input.offset < 1 || !text.startsWith("/")) return null;
  const offset = Math.min(input.offset, text.length);
  let end = 1;
  while (end < text.length && COMMAND_NAME_CHAR.test(text.charAt(end))) end += 1;
  // Past the name is past the picker: `/review src/a.ts` with the caret in the
  // path is a command with an argument being typed, not a command being chosen.
  if (offset > end) return null;
  return { from: 0, to: offset, query: text.slice(1, offset) };
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

/** The token Escape closed. Held until the caret is in a different one. */
export interface ComposerPickerDismissal {
  readonly mode: ComposerPickerMode;
  readonly from: number;
}

/**
 * The whole open/closed decision, in one place.
 *
 * Three things can keep a picker shut that the caret alone would open, and each
 * is a different kind of no:
 *
 *  - **not ready** — the box is inert; there is nothing to complete *into*.
 *  - **an interaction card is up** — one thing parks above the composer at a
 *    time, and a pending question outranks a list you can reopen by typing.
 *  - **dismissed** — Escape must mean something durable. Without this, Escape
 *    would close the list and the next keystroke would reopen it on the same
 *    token, which reads as the picker refusing to go away. It is keyed on where
 *    the token *starts*, so a later `@` in the same message opens normally
 *    while the one you dismissed stays shut however much more you type into it.
 */
export function composerPicker(input: {
  text: string;
  caret: number;
  templates: readonly PromptTemplate[];
  files: readonly IndexedFile[];
  /** The composer can take a message at all. */
  ready?: boolean;
  /** An interaction card holds the slot above the composer. */
  interactionOpen?: boolean;
  dismissed?: ComposerPickerDismissal | null;
}): ComposerPickerState | null {
  if (input.ready === false || input.interactionOpen === true) return null;
  const open = pickerForCaret(input);
  if (open === null) return null;
  const dismissed = input.dismissed ?? null;
  if (dismissed !== null && dismissed.mode === open.mode && dismissed.from === open.from)
    return null;
  return open;
}

/**
 * The picker this caret opens, before any of the gates above.
 *
 * `/` is checked first and wins outright: at offset 0 there is no `@` token to
 * be in, so the two can never both be live, and checking in a fixed order
 * removes the question of what would happen if they were.
 */
function pickerForCaret(input: {
  text: string;
  caret: number;
  templates: readonly PromptTemplate[];
  files: readonly IndexedFile[];
}): ComposerPickerState | null {
  const command = commandTokenAt({ text: input.text, offset: input.caret });
  if (command !== null) {
    return {
      mode: "command",
      ...command,
      rows: rankCommandCompletions({ query: command.query, templates: input.templates }),
    };
  }

  const file = fileRefTokenAt({ text: input.text, offset: input.caret });
  if (file === null) return null;
  return {
    mode: "file",
    from: file.from,
    to: file.to,
    query: file.query,
    // "Create artifact" is deliberately dropped: it is an intent that writes a
    // file, and the composer has nowhere to open the result. The `@` picker in
    // the editor — which does — keeps it.
    rows: rankFileRefCompletions({ query: file.query, index: input.files })
      .filter((completion) => completion.kind === "file")
      .map((completion) => ({
        kind: "file" as const,
        value: completion.relPath,
        label: completion.label,
        detail: completion.detail,
        relPath: completion.relPath,
        artifact: completion.artifact,
      })),
  };
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
