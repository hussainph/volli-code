/**
 * Skills — per-project instruction documents a Session can be handed, as pure
 * data and path rules.
 *
 * A skill is a directory under the project's `.agents/skills/` holding a
 * `SKILL.md` (the `npx skills add` convention this repo already vendors —
 * see `skills-lock.json`): frontmatter with a name and description, body of
 * instructions. Volli never loads one ambiently — the Operating layer of the
 * system prompt promises "no ambient configuration, extension, or skill to
 * fall back on" — so a skill only reaches a model when someone names it: as a
 * `/slug` reference in the composer (expanded at submit into a delimited
 * RESOURCE block, `prompt-resource.ts`), or as an attach-time selection that
 * rides `SessionRuntimeSpec.promptResources` into the system prompt.
 *
 * The name a skill goes by is its directory slug, NOT its frontmatter `name`:
 * the frontmatter says "SVG Logo Designer", which no one can type after a `/`
 * — the `/name` grammar is `[A-Za-z0-9_:-]+` (`prompt-template.ts`). The slug
 * is what the picker offers, what expansion looks up, and what the RESOURCE
 * delimiter carries, so the reference and the injection can never disagree
 * about what the thing is called.
 *
 * Pure string ops only, like `volli-dir.ts` and for the same reason: main
 * walks the directory, the renderer ranks and expands, and neither may drag a
 * Node import into the other's world.
 */
import type { PromptResource } from "./agent-runtime";
import { promptResourceBlock } from "./prompt-resource";
import type { PromptTemplate } from "./prompt-template";

/** One loaded skill: the slug it is invoked by, and what the file said. */
export interface SkillReference {
  /** The skill's directory name — what the user types after `/`. */
  readonly name: string;
  /** The frontmatter `description`, or the body's first line. May be `""`. */
  readonly description: string;
  /** The instructions themselves: the SKILL.md body, frontmatter stripped. */
  readonly body: string;
}

/**
 * The per-project skills directory: `<projectPath>/.agents/skills`.
 *
 * MAIN-repo-keyed like `projectCommandsDir`, though for a weaker reason:
 * `.agents` is committed (a worktree has its own copy), but the picker's
 * supply is project-scoped, not session-scoped, and two checkouts answering
 * one project-keyed question with different lists is exactly the drift the
 * commands dir rule exists to prevent.
 */
export function projectSkillsDir(projectPath: string): string {
  const root = projectPath.endsWith("/") ? projectPath.slice(0, -1) : projectPath;
  return `${root}/.agents/skills`;
}

/**
 * Whether a directory slug can be a skill name at all — the `/name` character
 * class, anchored. A slug the grammar cannot spell ("My Skill") is not
 * offered rather than offered and unreachable.
 */
export function isSkillName(value: string): boolean {
  return /^[A-Za-z0-9_:-]+$/.test(value);
}

/**
 * The skills a picker may offer beside `templates` — shadowed names removed.
 *
 * `/name` is one flat namespace at submit, and expansion resolves a name
 * template-first (see `expandCommandInvocation`), so a skill whose slug a
 * command also uses can never be invoked. Offering its row anyway would be
 * offering a control that does something other than what it says; dropping it
 * here keeps the list honest. Name-sorted, like every list the picker holds.
 */
export function visibleSkills(
  skills: readonly SkillReference[],
  templates: readonly PromptTemplate[],
): readonly SkillReference[] {
  const taken = new Set(templates.map((template) => template.name));
  return skills
    .filter((skill) => !taken.has(skill.name))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** A skill as the {@link PromptResource} both injection routes deliver. */
export function skillPromptResource(skill: SkillReference): PromptResource {
  return { name: skill.name, text: skill.body };
}

/**
 * What a `/skill` invocation becomes in the sent message.
 *
 * The body arrives verbatim inside the delimited RESOURCE block — never
 * through `substituteArgs`, because a skill body is arbitrary markdown and
 * shell snippets full of literal `$1`/`$@` that substitution would silently
 * blank. The rest of the invocation's line is the user's own words ("/svg
 * make me a wordmark"), so unlike a placeholder-less template — which drops
 * its arguments by Pi's grammar — a skill keeps them, on their own line after
 * the block. Swallowing them would lose the message, which is this module
 * family's oldest rule.
 */
export function skillInvocationText(skill: SkillReference, argsString: string): string {
  const block = promptResourceBlock(skillPromptResource(skill));
  return argsString === "" ? block : `${block}\n\n${argsString}`;
}
