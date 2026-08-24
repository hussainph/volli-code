/**
 * Composer verbs: a `/name` that RUNS something instead of sending text.
 *
 * Everything else the composer's `/` offers is text. A prompt template is a
 * file whose body IS the prompt and expands into the message; a skill is a
 * document whose body rides beside the message. Both end the same way — a
 * message goes to the model. A verb ends the other way: an operation runs, and
 * no message is sent at all. `/compact` is the first, and it exists because a
 * Session that has filled its window needs an act, not a paragraph asking for
 * one. The rest of the registry answers the question a `/`-typing reader
 * arriving from another harness asks next — "and the commands that DO
 * things?" — with Volli's own expression of the jobs Pi's built-in commands
 * do (see `docs/research/pi-slash-command-survey.md` for the full mapping and
 * the deliberate omissions): `/copy` puts the last reply on the clipboard,
 * `/model` opens the model picker the footer already carries, `/reload`
 * re-reads the commands and skills directories, `/settings` and `/login` open
 * the app surfaces that own those words. A verb is offered where its surface
 * can actually take the press — see {@link ComposerVerb.refusal} — so the list
 * never names something the app is about to refuse.
 *
 * That difference is why this module exists rather than another entry in the
 * template list, and it drives all three rules below.
 *
 * **One name, one meaning, and the verb wins it.** A verb's name is reserved:
 * a prompt template or skill spelled `compact` cannot be what `/compact` does,
 * and `expandCommandInvocation` refuses to expand the name. This is the
 * opposite of the template-over-skill rule beside it, deliberately: those two
 * are both text, so shadowing one with the other substitutes text for text,
 * and the user-authored file is the better answer. A verb and a template are
 * not the same kind of thing, so shadowing would substitute a *message* for an
 * *operation* — and it would do it silently, at the one moment the operation
 * matters most, since a Session whose window is full is exactly when
 * `/compact` must not turn into a prompt. The same reservation covers `model`,
 * `settings` and the rest — common words, and a `settings.md` a project
 * happened to have must not silently win a verb's name.
 *
 * The file that loses the name is not lost with it: `slash-namespace.ts`
 * qualifies it to `/command:compact` and it keeps working there. Reservation
 * decides who owns a bare name, not who gets to exist.
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
 * template body, and there is no body here to substitute into. For `/compact`
 * the words go to a summarizer, which reads paragraphs; for every other verb
 * there is nothing the words could mean, which is what `takesInstructions`
 * records — the press hands the words back rather than dropping them
 * silently, the same bargain the whole-draft rule makes.
 */

/**
 * The Session facts an offer rule may read — everything a verb is allowed to
 * know about the moment it is being offered in.
 *
 * Deliberately the caller's facts and not a store lookup: this module stays
 * pure, and the surface that draws the picker is the one that knows them.
 * A fact earns its place here only when some verb's availability turns on it,
 * which is why the set is small and why growing it is the honest signal that
 * a new verb has a new precondition.
 */
export interface ComposerVerbMoment {
  /** A turn is live. */
  readonly working: boolean;
  /** The transcript holds a settled reply to act on. */
  readonly hasReply: boolean;
  /** The model catalog has answered with something offerable. */
  readonly hasModels: boolean;
  /** A project is selected, so the on-disk command and skill tiers have a root. */
  readonly hasProject: boolean;
}

/**
 * Everything a verb declares EXCEPT its name — the name is the key it is
 * declared under, so the two cannot drift.
 *
 * This is the whole reason the registry below is a keyed table rather than an
 * array of self-naming records: a `name` field beside a key is a second place
 * to spell the same thing, and the compiler cannot object to `copy: { name:
 * "kopy" }`. Deriving the name from the key removes that bug class instead of
 * catching it.
 */
export interface ComposerVerbSpec {
  /** The picker's second column. A phrase, because the row is a control. */
  readonly description: string;
  /**
   * Why this moment cannot take the press, or null when it can.
   *
   * A predicate rather than a category, because a category cannot say WHY.
   * The picker hides every verb whose refusal is non-null and the press toasts
   * that exact sentence, so the offer rule and the refusal are one function
   * with one answer: the list can never invite something the app is about to
   * refuse, and a refusal can never be reported as the wrong cause.
   *
   * The string is user-facing copy. Each verb owns its own because "not now"
   * has a different reason per verb, and one shared sentence would be wrong
   * for most of them.
   */
  refusal(moment: ComposerVerbMoment): string | null;
  /** Whether free text after the name means anything to the operation. */
  readonly takesInstructions: boolean;
}

/**
 * EVERY VERB THERE IS. The one declaration — add a row here and nowhere else.
 *
 * This table used to be three declarations: a `ComposerVerbName` union, a
 * `const` per verb, and an array collecting them. Two of the three were
 * enforced (the satellite `Record`s below fail to compile when the union
 * grows), but the array was not: a verb could sit in the union with a glyph
 * and an act and still be missing from the supply, which made it invisible in
 * the picker AND unreserved — `isComposerVerbName` would answer false, so a
 * user's `compact.md` would quietly win the name the verb was supposed to own.
 * Deriving the union and the array FROM this table closes that hole by
 * construction: there is no longer a second list to forget.
 *
 * Declaration order is the order a picker offers them in — `Object.entries`
 * preserves it for string keys, and {@link COMPOSER_VERBS} does nothing to
 * reorder it.
 *
 * The key is the name, and the closure is load-bearing: a verb has no generic
 * behaviour to fall back on — the whole point is that each runs a different
 * operation — so a new name must not be able to arrive anywhere silently. The
 * sites that answer per verb therefore key a `Record<ComposerVerbName, …>`
 * rather than switching: the act the press performs (`chat-plane.tsx`) and the
 * glyph the picker draws (`composer-picker-ui.tsx`). A `Record` on a closed key
 * type fails to compile with the MISSING NAME in the message, where a `switch`
 * in a void-returning function compiles happily with an arm missing and the
 * press quietly does nothing. Adding a row here breaks both sites, and each
 * error names the verb and the site.
 *
 * NOT a `ReadonlyMap` like `harness/core.ts`'s adapter registry, deliberately.
 * That registry is a Map because `HarnessId` is OPEN — a registered harness
 * joins it at runtime — and a `Record` cannot express an open key. This set is
 * closed and known at compile time, and a Map would throw away the exhaustive
 * checking that is the entire point here. The open half of the `/` surface
 * (a user's commands and skills) is not modelled here at all; it is data read
 * from disk, and `slash-namespace.ts` is where the two meet.
 */
export const COMPOSER_VERB_TABLE = {
  /**
   * Summarize the Session's history so the conversation can continue past the
   * model's window — Context Compaction, asked for rather than triggered.
   */
  compact: {
    description: "Summarize the history so far to free up context",
    // Rewriting context under a running turn corrupts it. The runtime refuses
    // this too — and still owns the refusals only it can see, like a history
    // with nothing left to summarize — but a turn being live is a fact the
    // client holds already, so it is answered here, immediately and in the same
    // words the picker's silence means.
    refusal: (moment) => (moment.working ? "Compaction can't run while a turn is live" : null),
    takesInstructions: true,
  },

  /** Put the Session's most recent reply on the clipboard, as plain text. */
  copy: {
    description: "Copy the last reply to the clipboard",
    // Idle as well as answered: mid-turn the newest reply is still arriving, and
    // a clipboard holding half a sentence under a toast that says "Copied last
    // reply" is a copy that looked right and pasted wrong.
    refusal: (moment) =>
      moment.working
        ? "Wait for the reply to finish"
        : moment.hasReply
          ? null
          : "No reply to copy yet",
    takesInstructions: false,
  },

  /** Open the model picker — the footer pill's own list, arriving by typing. */
  model: {
    description: "Switch the Session's model",
    // Both halves of the pill's own disabled rule, which is what this verb
    // opens: model policy is immutable mid-turn, and an empty catalog has no
    // list to show. The second is the reachable one — a Session with no model
    // access is exactly the Session someone types `/model` in — and it must not
    // be reported as the first.
    refusal: (moment) =>
      moment.working
        ? "The model can't change mid-turn"
        : moment.hasModels
          ? null
          : "No models to choose from — try /login",
    takesInstructions: false,
  },

  /** Re-read the commands and skills directories, without leaving the Session. */
  reload: {
    description: "Refresh commands and skills from disk",
    // The tiers this re-reads are project-scoped, so with no project there is
    // no directory to read and the press could only report a refresh of nothing.
    refusal: (moment) => (moment.hasProject ? null : "No project to read commands from"),
    takesInstructions: false,
  },

  /** Open the app's Settings. */
  settings: {
    description: "Open Settings",
    // App chrome: nothing about a Session can refuse it.
    refusal: () => null,
    takesInstructions: false,
  },

  /** Open Settings on Model Access — where Volli keeps every credential. */
  login: {
    description: "Manage model access and sign-ins",
    // Always available on purpose: the Session with nothing configured is the
    // one that needs this door most.
    refusal: () => null,
    takesInstructions: false,
  },
} satisfies Record<string, ComposerVerbSpec>;

/**
 * Every verb there is, as a closed union — the table's own keys.
 *
 * Derived rather than declared, so "the names there are" and "the verbs there
 * are" cannot disagree. See {@link COMPOSER_VERB_TABLE} for why the closure
 * matters and which sites it enforces.
 */
export type ComposerVerbName = keyof typeof COMPOSER_VERB_TABLE;

/** One built-in verb: what it is called, and what the picker says it does. */
export interface ComposerVerb extends ComposerVerbSpec {
  /** What is typed after `/`. Spellable by the same grammar a template name is. */
  readonly name: ComposerVerbName;
}

/**
 * Every built-in verb, in the order a picker offers them — the table, read out.
 *
 * Derived, so it cannot omit one. This is the list that used to be maintained
 * by hand beside the union; {@link COMPOSER_VERB_TABLE} says what that cost.
 */
export const COMPOSER_VERBS: readonly ComposerVerb[] = Object.entries(COMPOSER_VERB_TABLE).map(
  // `Object.assign` onto a fresh literal rather than a spread: it copies every
  // field the spec has without naming them, so a field added to
  // `ComposerVerbSpec` arrives here on its own rather than being silently
  // dropped by a hand-written field list.
  ([name, spec]) => Object.assign({ name: name as ComposerVerbName }, spec),
);

/** The verb this name belongs to. Total on {@link ComposerVerbName}, so no null. */
const VERB_BY_NAME = Object.fromEntries(COMPOSER_VERBS.map((verb) => [verb.name, verb])) as Record<
  ComposerVerbName,
  ComposerVerb
>;

/** {@link COMPOSER_VERB_TABLE}'s rows, addressable one at a time. */
export const COMPACT_VERB: ComposerVerb = VERB_BY_NAME.compact;
export const COPY_VERB: ComposerVerb = VERB_BY_NAME.copy;
export const MODEL_VERB: ComposerVerb = VERB_BY_NAME.model;
export const RELOAD_VERB: ComposerVerb = VERB_BY_NAME.reload;
export const SETTINGS_VERB: ComposerVerb = VERB_BY_NAME.settings;
export const LOGIN_VERB: ComposerVerb = VERB_BY_NAME.login;

/**
 * The verbs this moment offers — the one supply both the picker and the press
 * read, so what the list offers and what a press performs cannot disagree.
 *
 * There is no rule here beyond "ask each verb": {@link ComposerVerb.refusal}
 * is the single source, and this function exists so the picker and the press
 * cannot each grow their own copy of it. A verb added with a precondition the
 * picker does not know about is impossible by construction — the precondition
 * IS the thing the picker reads.
 */
export function offeredComposerVerbs(moment: ComposerVerbMoment): readonly ComposerVerb[] {
  return COMPOSER_VERBS.filter((verb) => verb.refusal(moment) === null);
}

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
