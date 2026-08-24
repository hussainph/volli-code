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
 * ## The row that is not text
 *
 * A third kind of `/` row exists and it breaks the family resemblance: a VERB
 * (`@volli/shared`'s `composer-verb.ts`) runs an operation and sends no
 * message at all. `/compact` is the one there is.
 *
 * It still WRITES text when picked — `/compact ` staged in the box, caret
 * after the space, exactly like a command still waiting for its arguments —
 * and that is the part worth being careful about, because writing the literal
 * `/compact` into the draft is also precisely how this could go wrong. What
 * makes it honest is that the same text never reaches the model: a reserved
 * name expands to nothing in `expandCommandInvocation`, and a draft that IS
 * the verb is claimed at submit by `composerPress`, which runs the operation
 * instead of sending. So the row offers an act and the press performs that
 * act.
 *
 * Picked rather than fired on selection for two reasons, and both are about
 * this surface rather than about compaction. Free text after the verb is how
 * instructions are supplied, so a pick cannot be the end of the sentence; and
 * ⏎ is the only key on this surface that ever DOES anything, which is a
 * property worth more than one saved keystroke.
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
  isSlashNameCharacter,
  promptTemplateTakesArgs,
  resolveSlashNamespace,
  type ComposerVerb,
  type IndexedFile,
  type PromptTemplate,
  type SkillReference,
  type SlashName,
} from "@volli/shared";

import { fileRefTokenAt, rankFileRefCompletions, refInsertion } from "@renderer/editor/file-refs";

export type ComposerPickerMode = "command" | "file";

/** One row, with everything both the list and the insertion need. */
export type ComposerPickerRow =
  | {
      readonly kind: "verb";
      readonly value: string;
      readonly label: string;
      readonly detail: string;
      readonly verb: ComposerVerb;
    }
  | {
      readonly kind: "command";
      /** cmdk's item value: unique per row, and what "active" names. */
      readonly value: string;
      /**
       * What a pick WRITES, which is not always `template.name`: a template
       * whose bare name a verb owns answers to `command:<name>`
       * (`resolveSlashNamespace`). Carried on the row because the row is what
       * insertion has, and writing the bare name would stage text that submit
       * resolves to the verb instead. It is also this row's `value` — see
       * {@link composerPickerRows}.
       */
      readonly name: string;
      readonly label: string;
      readonly detail: string;
      /** Source-owned group copy from the slash adapter registry. */
      readonly heading: string;
      readonly template: PromptTemplate;
    }
  | {
      readonly kind: "skill";
      readonly value: string;
      /** What a pick writes, and this row's `value` — `skill:<name>` when taken. */
      readonly name: string;
      readonly label: string;
      readonly detail: string;
      /** Source-owned group copy from the slash adapter registry. */
      readonly heading: string;
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
  /** End of the token name. A pick replaces the whole token, not only its left half. */
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
  // Walk left over name characters to where the name starts…
  let start = offset;
  while (start > 0 && isSlashNameCharacter(text.charAt(start - 1))) start -= 1;
  // …which must be a slash, itself at a word boundary. A caret past the name
  // walks back over whitespace or an argument first and lands on neither.
  if (start === 0 || text.charAt(start - 1) !== "/") return null;
  const slash = start - 1;
  if (slash > 0 && !/\s/.test(text.charAt(slash - 1))) return null;
  // Complete the token to the right too. Otherwise picking with the caret at
  // `/command|:compact` would preserve `:compact` and stage a duplicate tail.
  let end = offset;
  while (end < text.length && isSlashNameCharacter(text.charAt(end))) end += 1;
  return { from: slash, to: end, query: text.slice(start, offset) };
}

/**
 * 0 = name prefix, 1 = name contains, 2 = description contains, null = no match.
 *
 * One function over a name and a description, because all three row kinds rank
 * the same way — a verb, a command and a skill are all found by what they are
 * called and then by what they say they do. It reads the RESOLVED name, so a
 * template qualified to `command:compact` is still found by typing `compact`
 * (tier 1, "contains"), while the bare prefix match belongs to the verb that
 * owns the bare name. That is the ranking agreeing with the namespace instead
 * of arguing with it.
 */
function matchTier(query: string, name: string, description: string): number | null {
  const lower = name.toLowerCase();
  if (query === "" || lower.startsWith(query)) return 0;
  if (lower.includes(query)) return 1;
  if (description.toLowerCase().includes(query)) return 2;
  return null;
}

/**
 * Rank the built-in verbs for the same `/` query — the same three tiers, so a
 * row that is not text is still found the way every other row is.
 *
 * Verbs lead the combined list rather than sorting into it. They are the app's
 * own, there are very few of them, and a row whose meaning is "do this now"
 * should not move down the list as a project's template collection grows. The
 * card groups them under their own heading, and the flat order has to agree
 * with the visual one or the arrow keys walk a different list than the eye.
 */
export function rankVerbCompletions(input: {
  query: string;
  verbs: readonly ComposerVerb[];
}): readonly ComposerPickerRow[] {
  const query = input.query.toLowerCase();
  return input.verbs
    .map((verb) => ({ verb, tier: matchTier(query, verb.name, verb.description) }))
    .filter((entry): entry is { verb: ComposerVerb; tier: number } => entry.tier !== null)
    .toSorted((a, b) => a.tier - b.tier || a.verb.name.localeCompare(b.verb.name))
    .map(({ verb }) => ({
      kind: "verb" as const,
      // The name itself — see {@link composerPickerRows} for why that is
      // already unique across every row this card can draw.
      value: verb.name,
      label: `/${verb.name}`,
      detail: verb.description,
      verb,
    }));
}

/** One resolved namespace entry as the row its target needs. */
function slashPickerRow(entry: SlashName): ComposerPickerRow {
  if (entry.target.kind === "command") {
    return {
      kind: "command",
      value: entry.name,
      name: entry.name,
      label: `/${entry.name}`,
      detail: entry.description,
      heading: entry.heading,
      template: entry.target.template,
    };
  }
  return {
    kind: "skill",
    value: entry.name,
    name: entry.name,
    label: `/${entry.name}`,
    detail: entry.description,
    heading: entry.heading,
    skill: entry.target.skill,
  };
}

/**
 * Rank every open slash source in one pass.
 *
 * Source order leads the sort so keyboard order stays aligned with the card's
 * groups; match tier and name rank rows within each source. No result cap lives
 * here: every supplied row that matches remains discoverable, and the source
 * adapters are the single place a future kind joins this pass.
 */
export function rankSlashCompletions(input: {
  query: string;
  entries: readonly SlashName[];
}): readonly ComposerPickerRow[] {
  const query = input.query.toLowerCase();
  return input.entries
    .map((entry) => ({ entry, tier: matchTier(query, entry.name, entry.description) }))
    .filter((ranked): ranked is { entry: SlashName; tier: number } => ranked.tier !== null)
    .toSorted(
      (a, b) =>
        a.entry.sourceOrder - b.entry.sourceOrder ||
        a.tier - b.tier ||
        a.entry.name.localeCompare(b.entry.name),
    )
    .map(({ entry }) => slashPickerRow(entry));
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
 * not negotiable. WHERE it writes — the current token and the `from`/`to` span
 * {@link applyPickerRow} overwrites — has to come from the caret's current
 * text, because a span one keystroke behind writes over the wrong range and
 * leaves characters typed since dangling on the right. WHAT it offers
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
  /**
   * The built-in verbs this Session can run right now. Empty while a turn is
   * live: an explicit compaction is refused mid-turn (rewriting the context
   * under a running turn corrupts it), and a control naming something the
   * runtime will refuse is worse than no control — the rule the model pill and
   * the mode segment already follow.
   */
  verbs?: readonly ComposerVerb[];
  files: readonly IndexedFile[];
}): readonly ComposerPickerRow[] {
  if (input.mode === "command") {
    // One namespace, resolved once, for every registered open source — the
    // same resolution `expandCommandInvocation` performs at submit from the
    // same supplies, which keeps offer and press agreed about `/compact`.
    // A verb owns its bare name; a source row that wanted it is qualified rather
    // than dropped, and an unspellable basename is normalized into this grammar.
    //
    // It is also what lets every row's cmdk `value` be simply its name. Those
    // values used to carry hand-written `verb:` and `skill:` prefixes because
    // the old parallel lists could not promise uniqueness. The resolver now
    // hands out only unique, grammar-valid names, so cmdk's trimming cannot
    // collapse two values and a second prefix would only duplicate the answer.
    const namespace = resolveSlashNamespace({
      templates: input.templates,
      skills: input.skills ?? [],
    });
    return [
      ...rankVerbCompletions({ query: input.query, verbs: input.verbs ?? [] }),
      ...rankSlashCompletions({ query: input.query, entries: namespace.entries }),
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
 * A verb stages for the same reason and expands for no reason at all — see the
 * module header.
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

  const written = spaced(writtenFor(row, text, state));

  return {
    text: `${text.slice(0, state.from)}${written}${rest}`,
    caret: state.from + written.length,
  };
}

/** What one row writes, before {@link applyPickerRow}'s trailing space. */
function writtenFor(row: ComposerPickerRow, text: string, state: ComposerPickerState): string {
  switch (row.kind) {
    // Staged, never performed at pick, and never expanded into anything: the
    // text IS the invocation, and ⏎ is what runs it. See the module header —
    // this is the row whose written text and performed act must not disagree,
    // and they agree because nothing ever expands a reserved name.
    case "verb":
      return `/${row.verb.name}`;
    // `row.name`, not `row.template.name`: a template the verbs shadowed is
    // staged as `/command:deploy`, which is the name submit resolves back to
    // this template. Writing the bare name would stage text that expands to
    // the verb, or to nothing at all.
    case "command":
      return promptTemplateTakesArgs(row.template)
        ? `/${row.name}`
        : formatPromptTemplateInvocation(row.template);
    // Always staged, never expanded at pick — twice deliberate. A skill body is
    // a document, and pasting fifteen kilobytes into the box the reader is
    // typing in is not "showing the prompt you are about to send", it is losing
    // the draft under it. And the reference IS what gets sent: at submit the
    // text keeps `/name` and its arguments as typed, while the body rides
    // beside the message as its own resource part (`expandCommandInvocation`)
    // — so the caret parks after the space, exactly like a command that still
    // wants its arguments.
    case "skill":
      return `/${row.name}`;
    case "file":
      return refInsertion({
        // `fileRefTokenAt` only matches at a ref boundary, so this is already
        // whitespace, `(`, or start-of-text. Asking anyway is what keeps the
        // one grammar answering the question.
        precedingChar: state.from === 0 ? "" : text.charAt(state.from - 1),
        text: `@${row.relPath}`,
      });
  }
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
