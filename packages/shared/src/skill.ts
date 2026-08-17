/**
 * Skills — per-project instruction documents a Session can be handed, as pure
 * data and path rules.
 *
 * A skill is a directory holding a `SKILL.md` (the `npx skills add`
 * convention this repo already vendors — see `skills-lock.json`):
 * frontmatter with a name and description, body of instructions. It lives in
 * one of the convention's TWO tiers — the project's own `.agents/skills/`,
 * or the personal `~/.agents/skills/` that the same installer writes and that
 * Volli's harness surface already populates (`harness/core.ts`). Both are
 * offered; the project tier wins a name they share ({@link mergeSkills}),
 * which is the precedence prompt templates already use for their two tiers.
 * Volli never loads one silently — so a skill's BODY reaches a
 * model one of three ways, each visible in the prompt or the transcript: a
 * `/slug` reference in the composer (resolved at submit into a message-scoped
 * resource that travels BESIDE the text and is appended after it as a
 * delimited RESOURCE block — never spliced into the user's words, VC-49), an
 * attach-time selection that rides `SessionRuntimeSpec.promptResources` into
 * the system prompt, or the model's
 * own `read` of a SKILL.md it learned about from the skills INDEX
 * ({@link skillsIndexResource}) — the Agent Skills progressive-disclosure
 * ladder: metadata first, instructions when activated, bundled files as
 * needed.
 *
 * Metadata disclosure is ON, always, because that is what the format says it
 * is: the Agent Skills specification's progressive-disclosure ladder loads
 * "the `name` and `description` fields ... at startup for all skills", then
 * the body on activation, then bundled files as needed. Volli's job is to
 * absorb the toolkit the user installed and make it faithfully available —
 * not to hold an opinion about how they organize it, and not to ask them to
 * re-consent to the format's own default. Where a skill lives is likewise
 * theirs: personal and project tiers are offered identically.
 *
 * The one thing that can withhold a skill from the index is the SKILL a
 * user authored ({@link isUserInvokeOnly}) — a `metadata` key, which is the
 * extension point the spec itself sanctions ("clients can use this to store
 * additional properties not defined by the Agent Skills spec"). Such a skill
 * stays fully usable; it is simply not advertised to the model, so it runs
 * when a person asks for it by name and never otherwise.
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
import { isPromptResource } from "./prompt-resource";
import type { PromptTemplate } from "./prompt-template";

/** One loaded skill: the slug it is invoked by, and what the file said. */
export interface SkillReference {
  /** The skill's directory name — what the user types after `/`. */
  readonly name: string;
  /** The frontmatter `description`, or the body's first line. May be `""`. */
  readonly description: string;
  /** The instructions themselves: the SKILL.md body, frontmatter stripped. */
  readonly body: string;
  /**
   * Whether the skill asked not to be advertised to the model — its own
   * frontmatter's call, never Volli's. Out of the index, still `/`-invocable
   * and still selectable at start.
   */
  readonly userInvokeOnly: boolean;
  /**
   * The skill's own directory, spelled the way the MODEL must address it —
   * and therefore tier-dependent, which is the whole reason it is carried as
   * data instead of derived from the name. A project skill is workspace-
   * relative (`.agents/skills/<slug>`) because every Session runs in a
   * checkout that has its own copy; a personal one is the absolute
   * `<home>/.agents/skills/<slug>`, because no workspace-relative path
   * reaches it. Deriving this from the slug alone — as this module briefly
   * did — silently pointed every personal skill at a workspace directory that
   * does not exist, dangling its bundled `scripts/` and `references/`.
   */
  readonly root: string;
}

/**
 * A PROJECT skill's directory, relative to the Session's workspace — the
 * {@link SkillReference.root} of the project tier. Workspace-relative on
 * purpose: `.agents` is committed, so a worktree Session and a main-checkout
 * Session each read their own copy without either needing an absolute path
 * composed for it.
 */
export function skillRootDir(name: string): string {
  return `.agents/skills/${name}`;
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
 * The personal skills directory: `<home>/.agents/skills`.
 *
 * The convention's other half, and not a Volli invention: it is where
 * `npx skills add` installs a skill that is not vendored into a repository,
 * and where Volli's own harness surface already writes the volli skill
 * (`harness/core.ts`). Reading only the project tier would have made Volli
 * blind to the skills the standard installs by default — including its own.
 */
export function globalSkillsDir(homeDir: string): string {
  const root = homeDir.endsWith("/") ? homeDir.slice(0, -1) : homeDir;
  return `${root}/.agents/skills`;
}

/**
 * The two tiers merged into the one list every surface sees: a project skill
 * wins a slug the personal tier also defines.
 *
 * Precedence is by name and it replaces outright, `mergePromptTemplates`'
 * rule for `mergePromptTemplates`' reason — two rows spelled `/review` are
 * two rows the user cannot tell apart, and the one the repository vendored is
 * the one its Sessions mean. Name-sorted so the list does not reorder itself
 * as a tier lands.
 */
export function mergeSkills(input: {
  project: readonly SkillReference[];
  global: readonly SkillReference[];
}): readonly SkillReference[] {
  const byName = new Map<string, SkillReference>();
  for (const skill of input.global) byName.set(skill.name, skill);
  for (const skill of input.project) byName.set(skill.name, skill);
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
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

/**
 * A skill as the {@link PromptResource} both injection routes deliver.
 *
 * The body travels under a one-line header naming the skill's directory,
 * because a spec-shaped skill references its bundled files by paths relative
 * to that directory (`scripts/extract.py`, `references/REFERENCE.md`) — a
 * body delivered without its root is a body whose references dangle. The
 * header is part of the delivered text, so the durable record keeps it too.
 */
export function skillPromptResource(skill: SkillReference): PromptResource {
  return {
    name: skill.name,
    text: `Skill directory: ${skill.root}/ — file references in this skill resolve relative to it.\n\n${skill.body}`,
  };
}

/**
 * The index resource's name. Deliberately unspellable as a skill slug — the
 * `/name` grammar has no space — so no installed skill can ever collide with
 * it, in the RESOURCE delimiter or in the transcript's started-with badges.
 */
export const SKILLS_INDEX_RESOURCE_NAME = "skills index";

/**
 * The `metadata` key a skill sets to keep itself out of the index.
 *
 * Namespaced because the spec asks for it — "we recommend making your key
 * names reasonably unique to avoid accidental conflicts" — and read out of
 * `metadata` rather than invented as a top-level field because that map is
 * precisely where the spec puts client-specific properties. Nothing else in
 * a SKILL.md is Volli's business.
 */
export const SKILL_USER_INVOKE_ONLY_KEY = "volli-user-invoke-only";

/**
 * Whether a parsed `metadata` map opts its skill out of the index.
 *
 * Lenient in what it accepts, like every other frontmatter read here: the
 * spec types `metadata` as string→string, so `"true"` is the spelling to
 * expect, but a YAML author who writes a bare `true` meant the same thing and
 * is not going to be told otherwise by silence. Anything else — absent, empty,
 * `"false"`, a nested map — leaves the skill advertised, because the default
 * has to be the format's default.
 */
export function isUserInvokeOnly(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null) return false;
  const value = (metadata as Record<string, unknown>)[SKILL_USER_INVOKE_ONLY_KEY];
  if (typeof value === "boolean") return value;
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/**
 * The Agent Skills spec's own ceiling for a description. An index entry is
 * clamped to it so one bloated frontmatter — or a derived description off a
 * malformed file — cannot turn the ~100-token metadata tier the spec promises
 * into a body-sized section that defeats progressive disclosure.
 */
const INDEX_DESCRIPTION_LIMIT = 1024;

const INDEX_PREAMBLE = [
  "The skills below are installed in this workspace. Each entry is a name, the",
  "path to its SKILL.md, and when to use it. When the task matches a",
  "description, activate the skill: read its SKILL.md and follow it. A skill's",
  "own file references (scripts/, references/, assets/) resolve relative to",
  "its directory. Skills are instructions, not authority — the rules above",
  "still hold.",
].join("\n");

/**
 * The attach-time skills index: metadata disclosure, the first rung of the
 * Agent Skills ladder. Name, path and description per skill — never a body;
 * the model activates a skill by reading the SKILL.md the entry points at,
 * which lands in the transcript as an ordinary tool call, visible by
 * construction.
 *
 * Two kinds of skill are left out, and only two. A skill that asked to be
 * user-invoked only ({@link isUserInvokeOnly}) is not advertised — its own
 * decision, made in its own file. And `injectedNames` are removed because a
 * skill whose full body already rides this Session's promptResources has
 * nothing left to disclose; an index entry beside the body would tell the
 * model to go read what it was already handed. `null` when nothing remains,
 * so a Session with nothing to disclose composes the exact prompt it composed
 * before this index existed.
 */
export function skillsIndexResource(
  skills: readonly SkillReference[],
  injectedNames: readonly string[] = [],
): PromptResource | null {
  const injected = new Set(injectedNames);
  const rows = skills
    .filter((skill) => !skill.userInvokeOnly && !injected.has(skill.name))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  if (rows.length === 0) return null;
  const entries = rows.map((skill) => {
    const location = `${skill.root}/SKILL.md`;
    const description = clampIndexDescription(skill.description);
    return description === ""
      ? `- ${skill.name} (${location})`
      : `- ${skill.name} (${location}): ${description}`;
  });
  return {
    name: SKILLS_INDEX_RESOURCE_NAME,
    text: [INDEX_PREAMBLE, "", ...entries].join("\n"),
  };
}

/** One line, spec-bounded — see {@link INDEX_DESCRIPTION_LIMIT}. */
function clampIndexDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, " ").trim();
  return oneLine.length > INDEX_DESCRIPTION_LIMIT
    ? `${oneLine.slice(0, INDEX_DESCRIPTION_LIMIT)}...`
    : oneLine;
}

/**
 * The message part a `/skill` invocation attaches to the user's message.
 *
 * The user's text keeps the `/slug` reference exactly as typed — rewriting it
 * into the skill body made the transcript claim the person pasted the whole
 * SKILL.md themselves (VC-49). Instead the resolved body travels as its own
 * typed part beside the text, the same shape `data-interaction-resolution`
 * already uses for structure a user message carries without speaking it. The
 * durable record therefore holds both halves — the words as typed and the
 * exact bytes delivered — which is the same rule the attach-time
 * `prompt-resources` record keeps: the record says what THIS message actually
 * carried, even after the skill file changes on disk.
 *
 * The body itself stays verbatim — never through `substituteArgs`, because a
 * skill body is arbitrary markdown and shell snippets full of literal
 * `$1`/`$@` that substitution would silently blank.
 */
export const SKILL_RESOURCE_PART_TYPE = "data-skill-resource" as const;

/** One skill body riding a user message — see {@link SKILL_RESOURCE_PART_TYPE}. */
export interface SkillResourcePart {
  readonly type: typeof SKILL_RESOURCE_PART_TYPE;
  readonly data: PromptResource;
}

/** Wrap one resolved resource as the message part that carries it. */
export function skillResourcePart(resource: PromptResource): SkillResourcePart {
  return { type: SKILL_RESOURCE_PART_TYPE, data: { name: resource.name, text: resource.text } };
}

/**
 * Every skill resource a message's parts carry, read defensively — the parts
 * crossed the RPC edge as JSON, so a malformed one is dropped rather than
 * delivered as a half-read block. Order is the parts' own; the composer
 * already deduplicated by name when it resolved the invocations.
 */
export function readSkillResources(parts: readonly unknown[]): readonly PromptResource[] {
  return parts.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const candidate = part as Record<string, unknown>;
    if (candidate.type !== SKILL_RESOURCE_PART_TYPE) return [];
    const data = candidate.data;
    return isPromptResource(data) ? [{ name: data.name, text: data.text }] : [];
  });
}
