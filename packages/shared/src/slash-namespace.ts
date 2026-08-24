/**
 * One flat `/` namespace: every verb, command and skill, each under a name
 * that means exactly one thing.
 *
 * `/name` has always been one namespace at submit — `expandCommandInvocation`
 * resolves a name against both lists — but the two lists could each hold the
 * same name, so something had to give. What gave used to be the ROW: a
 * template spelled `compact` was filtered out of the picker, and a skill whose
 * slug a command already used was filtered out too. The bargain was stated as
 * "a row that resolves to something other than what it says is worse than no
 * row", and the first half of that is right. The second half is the part this
 * module replaces.
 *
 * **A name is lost; the thing that had it is not.** Dropping the row is a
 * silent, total loss of a file the user wrote: `.volli/commands/compact.md`
 * stops being invocable at all, and nothing on the surface says why. Renaming
 * it costs the same bare name and keeps everything else — the row is still
 * there, still says what it does, and still runs, under a name that says which
 * kind of thing it is. That is the same trade the picker already makes for
 * verbs, one step further: a visible cost beats an invisible one, and a
 * visible cost that keeps working beats a visible cost that does not.
 *
 * The rule is the one every harness with this problem converges on. A
 * built-in keeps its bare name unconditionally; everything else that wanted
 * that name is qualified by where it came from. Gemini CLI's
 * `SlashCommandResolver` states it as three lines — built-ins keep the name,
 * everything else is prefixed by its source, and if several non-built-ins
 * collide they are all renamed — and Claude Code namespaces plugin skills
 * `plugin:skill` for the same reason. The failure mode they are all avoiding
 * is documented in their own bug trackers: a plugin that ships `doctor`
 * shadowing the built-in `/doctor`, a skill named for a reserved word
 * swallowing `/mcp`. Volli's verbs are reserved precisely so that cannot
 * happen here; this module is what happens to the loser afterwards.
 *
 * **Why `:` and not `.`.** The separator has to be spellable by the same
 * grammar the name is, or the qualified name could be shown and never typed.
 * `COMMAND_NAME_CHAR` and the verb grammar are both `[A-Za-z0-9_:-]`: `:` is
 * already in the class and `.` is not, so `:` round-trips through
 * `commandTokenAt`, `findCommandInvocations` and `findComposerVerb` with
 * nothing to change. It is also already the picker's own separator for cmdk
 * row values, so the character means "qualified by kind" in both places.
 *
 * **Reservation does not depend on availability.** Every verb name is taken
 * here whether or not this moment would offer it — `refusal` is not consulted.
 * A `/copy` that is refused right now because no reply has arrived is still
 * `/copy`, and a template that won the name while the transcript was empty
 * would lose it again the moment a reply landed. A name that changes meaning
 * as a Session progresses is the one thing worse than a name that is taken.
 */
import { isComposerVerbName, COMPOSER_VERBS } from "./composer-verb";
import type { PromptTemplate } from "./prompt-template";
import type { SkillReference } from "./skill";

/** The qualifier a template wears when its bare name was already taken. */
export const COMMAND_QUALIFIER = "command";

/** The qualifier a skill wears when its bare name was already taken. */
export const SKILL_QUALIFIER = "skill";

/** What took a name, when something had to be qualified to keep it. */
export type SlashShadow = "verb" | "command";

/**
 * One entry in the namespace: the thing, and the name it actually answers to.
 *
 * The item is carried untouched rather than rewritten with its new name,
 * because a name here is a NAME IN THE COMPOSER and some of these items spell
 * their name somewhere else too. A skill's `name` is what
 * `skillPromptResource` sends the model and what the transcript's badge shows;
 * renaming the skill itself to `skill:review` would rename it in the model's
 * context, where nothing collided and nothing needed to change.
 */
export interface SlashName<T> {
  /** The thing, exactly as it was read from disk. */
  readonly item: T;
  /** What is typed after `/` to get it — qualified only if it had to be. */
  readonly name: string;
  /** What it is called where it lives, whether or not it kept that name. */
  readonly bareName: string;
  /** What took the bare name, or null when this entry kept it. */
  readonly shadowedBy: SlashShadow | null;
}

/** Every `/`-invocable name, resolved so that no two entries share one. */
export interface SlashNamespace {
  readonly templates: readonly SlashName<PromptTemplate>[];
  readonly skills: readonly SlashName<SkillReference>[];
}

/**
 * Claim `preferred`, or the first free `qualifier:preferred` variant.
 *
 * The numeric suffix is the case nobody will hit and every resolver needs
 * anyway: `:` is legal in a name, so a skill directory literally called
 * `command:deploy` can collide with the qualified form of a template called
 * `deploy`. Without the suffix one of the two would silently overwrite the
 * other in the map and the picker would offer a row that ran the wrong thing —
 * the exact failure this module exists to remove.
 */
function claim(
  taken: Set<string>,
  preferred: string,
  qualifier: string,
): { name: string; qualified: boolean } {
  if (!taken.has(preferred)) {
    taken.add(preferred);
    return { name: preferred, qualified: false };
  }
  const base = `${qualifier}:${preferred}`;
  let candidate = base;
  let suffix = 1;
  while (taken.has(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return { name: candidate, qualified: true };
}

/**
 * Resolve the whole `/` surface into names that each mean one thing.
 *
 * Order is precedence, and it is the precedence that already existed:
 *
 * 1. **Verbs**, unconditionally — see the header. A verb is never qualified,
 *    because the thing a reader arriving from another harness types `/compact`
 *    expecting is the operation, and there is no file on disk that should be
 *    able to take that expectation away.
 * 2. **Templates**, which is why a template still beats a skill for a shared
 *    name: `expandCommandInvocation` has always resolved template-first, and
 *    changing which of the two wins is a different decision than changing what
 *    happens to the one that loses.
 * 3. **Skills**, sorted by name so the assignment does not depend on the order
 *    a directory read happened to return.
 *
 * Both tiers arrive already merged (`mergePromptTemplates`, `mergeSkills`), so
 * a name is unique WITHIN each list before this runs and every collision it
 * sees is a collision between two different KINDS of thing. That is what makes
 * the qualifier a kind rather than a tier: `command:` and `skill:` name the
 * distinction that is actually in play, where `project:` and `personal:` would
 * name one that has already been resolved upstream.
 */
export function resolveSlashNamespace(input: {
  templates: readonly PromptTemplate[];
  skills: readonly SkillReference[];
}): SlashNamespace {
  const taken = new Set<string>(COMPOSER_VERBS.map((verb) => verb.name));

  const templates = input.templates.map((item) => {
    const { name, qualified } = claim(taken, item.name, COMMAND_QUALIFIER);
    return {
      item,
      name,
      bareName: item.name,
      // Only a verb can have taken a template's name: the tier merge already
      // made template names unique, and skills are claimed after this loop.
      shadowedBy: qualified ? ("verb" as const) : null,
    };
  });

  const skills = input.skills
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((item) => {
      const { name, qualified } = claim(taken, item.name, SKILL_QUALIFIER);
      return {
        item,
        name,
        bareName: item.name,
        shadowedBy: qualified ? (isComposerVerbName(item.name) ? "verb" : "command") : null,
      } satisfies SlashName<SkillReference>;
    });

  return { templates, skills };
}

/** What a resolved name resolves TO — the two kinds a `/name` can expand into. */
export type SlashTarget =
  | { readonly kind: "command"; readonly template: PromptTemplate }
  | { readonly kind: "skill"; readonly skill: SkillReference };

/**
 * The namespace as the lookup expansion needs: resolved name → what it runs.
 *
 * Verbs are deliberately absent. They resolve to no target because they expand
 * to nothing — the text passes through as typed so the press can run the
 * operation — and `expandCommandInvocation` checks `isComposerVerbName` for
 * that reason rather than finding a verb here and having to ignore it.
 */
export function slashTargets(namespace: SlashNamespace): ReadonlyMap<string, SlashTarget> {
  const targets = new Map<string, SlashTarget>();
  for (const entry of namespace.templates) {
    targets.set(entry.name, { kind: "command", template: entry.item });
  }
  for (const entry of namespace.skills) {
    targets.set(entry.name, { kind: "skill", skill: entry.item });
  }
  return targets;
}
