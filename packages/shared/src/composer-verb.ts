/**
 * Composer verbs: a `/name` that RUNS something instead of sending text.
 *
 * Everything else the composer's `/` offers is text. A prompt template is a
 * file whose body IS the prompt and expands into the message; a skill is a
 * document whose body rides beside the message. Both end the same way — a
 * message goes to the model. A verb ends the other way: an operation runs, and
 * no message is sent at all. `/compact` is the first, and it exists because a
 * Session that has filled its window needs an act, not a paragraph asking for
 * one.
 *
 * That difference is why this module exists rather than another entry in the
 * template list, and it drives all three rules below.
 *
 * **One name, one meaning, and the verb wins it.** A verb's name is reserved:
 * a prompt template or skill spelled `compact` is dropped from every picker
 * ({@link visiblePromptTemplates}, `visibleSkills`) and refused by
 * `expandCommandInvocation`, so it can never be what `/compact` does. This is
 * the opposite of the template-over-skill rule beside it, deliberately: those
 * two are both text, so shadowing one with the other substitutes text for
 * text, and the user-authored file is the better answer. A verb and a template
 * are not the same kind of thing, so shadowing would substitute a *message*
 * for an *operation* — and it would do it silently, at the one moment the
 * operation matters most, since a Session whose window is full is exactly when
 * `/compact` must not turn into a prompt. Losing the name is visible instead:
 * the picker shows `/compact` doing what this file says it does, where the
 * user's own row used to be. A visible cost beats an invisible one.
 *
 * **A verb owns the whole draft or it is not a verb.** A template invocation
 * may sit mid-sentence, because expanding it leaves a message behind either
 * way; there is no such thing as a verb that leaves a message behind. So
 * `please /compact and carry on` is prose — sent, not run — and only a draft
 * that IS the verb runs it. The alternative is a press that silently drops
 * every word around the one it recognised.
 *
 * **Instructions are prose, not arguments.** What follows the verb runs to the
 * end of the text rather than the end of its line, and is never parsed:
 * `parseCommandArgs`' quoting is Pi's grammar for substituting `$1` into a
 * template body, and there is no body here to substitute into. The words go
 * to a summarizer, which reads paragraphs.
 */
import type { PromptTemplate } from "./prompt-template";

/**
 * Every verb there is, as a closed union.
 *
 * Closed on purpose: a caller that performs a verb switches on this and stops
 * compiling when a second one appears, rather than quietly performing the
 * first one for it. A verb has no generic behaviour to fall back on — the
 * whole point is that each runs a different operation.
 */
export type ComposerVerbName = "compact";

/** One built-in verb: what it is called, and what the picker says it does. */
export interface ComposerVerb {
  /** What is typed after `/`. Spellable by the same grammar a template name is. */
  readonly name: ComposerVerbName;
  /** The picker's second column. A phrase, because the row is a control. */
  readonly description: string;
}

/**
 * Summarize the Session's history so the conversation can continue past the
 * model's window — Context Compaction, asked for rather than triggered.
 */
export const COMPACT_VERB: ComposerVerb = {
  name: "compact",
  description: "Summarize the history so far to free up context",
};

/** Every built-in verb, in the order a picker offers them. */
export const COMPOSER_VERBS: readonly ComposerVerb[] = [COMPACT_VERB];

/** Whether this `/name` is a verb's, and therefore nothing else's. */
export function isComposerVerbName(name: string): name is ComposerVerbName {
  return COMPOSER_VERBS.some((verb) => verb.name === name);
}

/** A draft that is a verb: which one, and the free text handed to it. */
export interface ComposerVerbInvocation {
  readonly verb: ComposerVerb;
  /** Everything after the name, unparsed. Null when nothing followed it. */
  readonly instructions: string | null;
}

/** The `/name` character class — the template grammar's, so both read alike. */
const VERB_NAME_CHAR = /[A-Za-z0-9_:-]/;

/**
 * The verb this whole draft is, or null.
 *
 * Anchored at the start of the trimmed text and nowhere else — see this
 * module's header. The name must end at a boundary for the reason
 * `findCommandInvocations` gives: `/compacted` is a word, not this verb with
 * the argument `ed`.
 */
export function findComposerVerb(text: string): ComposerVerbInvocation | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  let nameEnd = 1;
  while (nameEnd < trimmed.length && VERB_NAME_CHAR.test(trimmed.charAt(nameEnd))) nameEnd += 1;
  const name = trimmed.slice(1, nameEnd);
  const verb = COMPOSER_VERBS.find((candidate) => candidate.name === name);
  if (verb === undefined) return null;
  const rest = trimmed.slice(nameEnd);
  if (rest !== "" && !/^\s/.test(rest)) return null;
  const instructions = rest.trim();
  return { verb, instructions: instructions === "" ? null : instructions };
}

/**
 * The templates a picker may offer — reserved verb names removed.
 *
 * `visibleSkills`' rule one tier up, and the same bargain: a row that resolves
 * to something other than what it says is worse than no row. The removal is
 * not cosmetic — `expandCommandInvocation` refuses the same names, so what the
 * picker offers and what a press performs cannot disagree about which of the
 * two a `/compact` is.
 */
export function visiblePromptTemplates(
  templates: readonly PromptTemplate[],
): readonly PromptTemplate[] {
  return templates.filter((template) => !isComposerVerbName(template.name));
}
