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

import {
  isSlashInvocationName,
  isSlashNameCharacter,
  type CheckedSlashInvocationName,
} from "./slash-name";

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

type ExactComposerVerbSpec<Spec extends ComposerVerbSpec> = Spec &
  Record<Exclude<keyof Spec, keyof ComposerVerbSpec>, never>;

type ComposerVerbDeclarationName<Name extends string> = Name extends "__proto__"
  ? never
  : CheckedSlashInvocationName<Name>;

/**
 * One declaration row, checked more strictly than structural assignment.
 *
 * `ComposerVerbSpec` deliberately has no `name`, and the `Exact…` intersection
 * makes that true even when a row spreads another object — the excess-property
 * loophole that can otherwise smuggle `name` back in. The key is checked
 * against the parser grammar at compile time and again at runtime for callers
 * that erased their literals. `__proto__` is excluded because the exhaustive
 * renderer records are object literals; allowing that one magic property would
 * turn their declaration into a prototype mutation rather than an own row.
 */
function composerVerbEntry<const Name extends string, const Spec extends ComposerVerbSpec>(
  name: Name & ComposerVerbDeclarationName<Name>,
  spec: ExactComposerVerbSpec<Spec>,
): readonly [Name, Readonly<Spec>] {
  /* v8 ignore next 3 -- this private builder only receives compile-time checked literals. */
  if (!isSlashInvocationName(name) || name === "__proto__") {
    throw new Error(`Invalid composer verb name: ${name}`);
  }
  return Object.freeze([name, Object.freeze(spec)] as const);
}

/** One closed registry, rejecting duplicate declarations before any consumer runs. */
function composerVerbRegistry<
  const Entries extends readonly (readonly [string, ComposerVerbSpec])[],
>(...entries: Entries): Entries {
  const names = new Set<string>();
  for (const [name] of entries) {
    /* v8 ignore next -- firing this declaration guard prevents the module from loading. */
    if (names.has(name)) throw new Error(`Duplicate composer verb name: ${name}`);
    names.add(name);
  }
  return Object.freeze(entries) as Entries;
}

/**
 * EVERY VERB THERE IS. Add one entry here; the key is spelled exactly once.
 *
 * The tuple registry keeps the closed-key exhaustiveness of the old object and
 * adopts the repo's `ReadonlyMap` registry idiom without relying on JavaScript
 * object enumeration. That matters for integer-looking keys, prototype names,
 * and spec objects with extra fields: declaration order stays declaration
 * order, every row is an own Map entry, and the derived object writes `name`
 * last so no spec can overwrite it at runtime.
 *
 * `ComposerVerbName` and {@link COMPOSER_VERBS} are derived from these entries.
 * The renderer's glyph and act records remain exhaustive over that union, so a
 * normal new entry fails both sites with the missing name in the error.
 */
const COMPOSER_VERB_ENTRIES = composerVerbRegistry(
  composerVerbEntry("compact", {
    description: "Summarize the history so far to free up context",
    // Rewriting context under a running turn corrupts it. The runtime refuses
    // this too — and still owns the refusals only it can see, like a history
    // with nothing left to summarize — but a turn being live is a fact the
    // client holds already, so it is answered here, immediately and in the same
    // words the picker's silence means.
    refusal: (moment) => (moment.working ? "Compaction can't run while a turn is live" : null),
    takesInstructions: true,
  }),

  composerVerbEntry("copy", {
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
  }),

  composerVerbEntry("model", {
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
  }),

  composerVerbEntry("reload", {
    description: "Refresh commands and skills from disk",
    // The tiers this re-reads are project-scoped, so with no project there is
    // no directory to read and the press could only report a refresh of nothing.
    refusal: (moment) => (moment.hasProject ? null : "No project to read commands from"),
    takesInstructions: false,
  }),

  composerVerbEntry("settings", {
    description: "Open Settings",
    // App chrome: nothing about a Session can refuse it.
    refusal: () => null,
    takesInstructions: false,
  }),

  composerVerbEntry("login", {
    description: "Manage model access and sign-ins",
    // Always available on purpose: the Session with nothing configured is the
    // one that needs this door most.
    refusal: () => null,
    takesInstructions: false,
  }),
);

/** Every verb there is, as the registry entries' closed key union. */
export type ComposerVerbName = (typeof COMPOSER_VERB_ENTRIES)[number][0];

/** The immutable keyed registry, for consumers that need one row by name. */
export const COMPOSER_VERB_TABLE: ReadonlyMap<ComposerVerbName, ComposerVerbSpec> = new Map<
  ComposerVerbName,
  ComposerVerbSpec
>(COMPOSER_VERB_ENTRIES);

/** One built-in verb: what it is called, and what the picker says it does. */
export interface ComposerVerb extends ComposerVerbSpec {
  /** What is typed after `/`. Spellable by the shared slash-name grammar. */
  readonly name: ComposerVerbName;
}

/** Every built-in verb, derived without a second list or an overridable name. */
export const COMPOSER_VERBS: readonly ComposerVerb[] = Object.freeze(
  COMPOSER_VERB_ENTRIES.map(([name, spec]) => Object.freeze({ ...spec, name })),
);

/** The same closed registry with each row's derived name attached. */
const VERB_BY_NAME: ReadonlyMap<ComposerVerbName, ComposerVerb> = new Map<
  ComposerVerbName,
  ComposerVerb
>(COMPOSER_VERBS.map((verb) => [verb.name, verb]));
const VERB_NAMES: ReadonlySet<string> = new Set(VERB_BY_NAME.keys());

/** Total lookup on a compile-time verb name, defended at the runtime boundary. */
function composerVerbNamed(name: ComposerVerbName): ComposerVerb {
  const verb = VERB_BY_NAME.get(name);
  /* v8 ignore next -- every accepted name and this Map derive from the same frozen entries. */
  if (verb === undefined) throw new Error(`Missing composer verb: ${name}`);
  return verb;
}

/** Stable row exports retained for call sites that name one existing verb. */
export const COMPACT_VERB = composerVerbNamed("compact");
export const COPY_VERB = composerVerbNamed("copy");
export const MODEL_VERB = composerVerbNamed("model");
export const RELOAD_VERB = composerVerbNamed("reload");
export const SETTINGS_VERB = composerVerbNamed("settings");
export const LOGIN_VERB = composerVerbNamed("login");

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
  return VERB_NAMES.has(name);
}

/** A draft that is a verb: which one, and the free text handed to it. */
export interface ComposerVerbInvocation {
  readonly verb: ComposerVerb;
  /** Everything after the name, unparsed. Null when nothing followed it. */
  readonly instructions: string | null;
}

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
  while (nameEnd < trimmed.length && isSlashNameCharacter(trimmed.charAt(nameEnd))) nameEnd += 1;
  const name = trimmed.slice(1, nameEnd);
  if (!isComposerVerbName(name)) return null;
  const verb = composerVerbNamed(name);
  const rest = trimmed.slice(nameEnd);
  if (rest !== "" && !/^\s/.test(rest)) return null;
  const instructions = rest.trim();
  return { verb, instructions: instructions === "" ? null : instructions };
}
