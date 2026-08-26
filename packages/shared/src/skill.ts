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
 * Metadata disclosure is ON by default, because that is what the format says
 * it is: the Agent Skills specification's progressive-disclosure ladder loads
 * "the `name` and `description` fields ... at startup for all skills", then
 * the body on activation, then bundled files as needed. Volli's job is to
 * absorb the toolkit the user installed and make it faithfully available —
 * not to hold an opinion about how they organize it, and not to ask them to
 * re-consent to the format's own default. Where a skill lives is likewise
 * theirs: personal and project tiers are offered identically.
 *
 * ## Two axes, one policy (VC-181)
 *
 * What can narrow that default is an INVOCATION POLICY, and it has two
 * independent axes rather than one flag, because the harnesses that ship this
 * feature all treat them independently ({@link SkillInvocationPolicy}):
 * whether the MODEL may find the skill unprompted, and whether a PERSON may
 * name it. Every consumer — the index, the `/` picker, submit-time expansion,
 * attach-time selection and the Settings readout — reads the one policy
 * {@link resolveSkillPolicy} computes, so no surface can hold its own opinion
 * about what a skill is currently allowed to do.
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

/**
 * The two independent things a skill may be allowed to do.
 *
 * NOT one flag with two names. Claude Code, Copilot/VS Code, Cursor and Pi all
 * ship these as separate frontmatter fields, and the four combinations are
 * each a real configuration a skill author picks on purpose:
 *
 * | modelDiscoverable | userInvokable | what it is                          |
 * | ----------------- | ------------- | ----------------------------------- |
 * | yes               | yes           | the format's default                |
 * | no                | yes           | "run it only when I ask" (Manual)   |
 * | yes               | no            | background knowledge, no `/` row    |
 * | no                | no            | unavailable                         |
 *
 * Volli held the middle two as one boolean until VC-181, which made the third
 * row unreachable and made "not in the index" and "not in the picker" the same
 * fact. They are not: the index is a PROMPT COST question and the picker is a
 * DISCOVERABILITY question for a person, and a skill can sensibly answer them
 * differently.
 */
export interface SkillInvocationPolicy {
  /** Metadata rides the skills index; the model may activate it unprompted. */
  readonly modelDiscoverable: boolean;
  /** The skill appears in `/` completion and an explicit reference resolves. */
  readonly userInvokable: boolean;
}

/**
 * The format's own default: both axes open.
 *
 * This is what a SKILL.md that declares no invocation fields means, and it is
 * the bottom rung of {@link resolveSkillPolicy}'s precedence. Named rather
 * than spelled inline so "the default" is one object every caller points at.
 */
export const SKILL_POLICY_DEFAULT: SkillInvocationPolicy = {
  modelDiscoverable: true,
  userInvokable: true,
};

/** Whether two policies say the same thing — the identity-preserving check. */
export function sameSkillPolicy(a: SkillInvocationPolicy, b: SkillInvocationPolicy): boolean {
  return a.modelDiscoverable === b.modelDiscoverable && a.userInvokable === b.userInvokable;
}

/** Neither route resolves it — the ticket's "Unavailable". */
export function isSkillUnavailable(policy: SkillInvocationPolicy): boolean {
  return !policy.modelDiscoverable && !policy.userInvokable;
}

/** One loaded skill: the slug it is invoked by, and what the file said. */
export interface SkillReference {
  /** The skill's directory name — what the user types after `/`. */
  readonly name: string;
  /** The frontmatter `description`, or the body's first line. May be `""`. */
  readonly description: string;
  /** The instructions themselves: the SKILL.md body, frontmatter stripped. */
  readonly body: string;
  /**
   * What the skill's own file asked for, before this project has its say —
   * the AUTHOR default that {@link resolveSkillPolicy} resolves a Project
   * override against, and the value {@link applySkillModes} rewrites when a
   * rule departs from it. Never Volli's opinion; see
   * {@link readAuthorInvocationPolicy} for how a SKILL.md spells it.
   */
  readonly invocation: SkillInvocationPolicy;
  /**
   * One line about a policy declaration that could not be taken at face
   * value — conflicting spellings, or a flag whose value is not a boolean.
   * `null` is the normal case. Carried on the reference rather than logged so
   * the Settings pane can show it against the row it is about: a skill whose
   * declared policy was silently discarded is exactly the fault a person
   * cannot diagnose from the behaviour alone.
   */
  readonly policyDiagnostic: string | null;
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
 * How much of itself a skill offers this project (VC-111, migration 023).
 *
 * THREE states rather than a switch, because the interesting one is in the
 * middle. A fresh Project Session's Volli-composed context measures ~10,400
 * tokens and ~9,800 of them — 94% — are the metadata-only skills index, one
 * name/path/description row per disclosed skill, re-sent as the stable prefix
 * of every turn. So "do I want this skill at all" and "do I want to pay for
 * this skill's discoverability on every turn" are different questions, and a
 * two-state switch can only ask the first.
 *
 *  - `auto` — advertised in the index. The model can find it unprompted, and
 *    it costs its index row on every turn.
 *  - `manual` — withheld from the index, still fully invokable by name. Costs
 *    nothing until someone types `/slug`. This is the budget lever.
 *  - `off` — gone: unindexed, unlistable, unresolvable.
 *
 * `manual` is not a new mechanism. It is the frontmatter opt-out
 * ({@link readAuthorInvocationPolicy}) with a per-project override in front of
 * it, so the author's default still holds wherever a project has said nothing.
 *
 * ## The mode column governs the MODEL axis (VC-181)
 *
 * A mode is a budget lever: it answers "is this skill worth its index row on
 * every turn in this project". It therefore sets `modelDiscoverable` outright
 * and leaves `userInvokable` to the author — see {@link skillModePolicy}. The
 * one exception is `off`, which is not a budget answer but a removal, and
 * closes both axes.
 */
export type SkillMode = "auto" | "manual" | "off";

/** Every mode, for a picker that must offer all of them. */
export const SKILL_MODES: readonly SkillMode[] = ["auto", "manual", "off"];

/**
 * One project's skill rules: slug → mode, holding ONLY departures from the
 * default. An absent slug means "whatever the skill itself asked for".
 */
export type SkillModes = Readonly<Record<string, SkillMode>>;

/**
 * A stored `skill_modes` payload as rules — slugs the grammar can spell, modes
 * the vocabulary defines, and nothing else.
 *
 * ALL THREE MODES ARE READ BACK, `auto` INCLUDED (VC-181). This parser used to
 * drop `auto` on the theory that it restates the absent-rule default, which is
 * true for an ordinary skill and false for exactly the skill the override
 * matters most for: one whose author wrote `disable-model-invocation: true`.
 * For that skill an explicit `auto` is the only way a project can say "I want
 * this one in my index after all", and dropping it on read made the Settings
 * Select snap straight back to Manual — an override the UI had to stop
 * offering because storage refused to keep it.
 *
 * Minimality moved to the WRITER instead, which is the layer that has the
 * skill list and can therefore tell a departure from a restatement: see
 * `skills-pane.tsx`'s `ruled`. A rule equal to the author's own default is
 * simply not written; one that arrives anyway is harmless and resolves to the
 * same policy.
 *
 * Degrades rather than throws, like `parseCanvas` beside it: a project row is
 * read at boot in a loop over every project, and a hand-edited value must cost
 * that project its rules, not the whole rail.
 */
export function parseSkillModes(value: unknown): SkillModes {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const rules: Record<string, SkillMode> = {};
  for (const [slug, mode] of Object.entries(value as Record<string, unknown>)) {
    if (!isSkillName(slug)) continue;
    if (mode !== "auto" && mode !== "manual" && mode !== "off") continue;
    rules[slug] = mode;
  }
  return rules;
}

/**
 * One Project mode applied over one author default — the whole of what a mode
 * MEANS, in one pure function.
 *
 * ## Why `userInvokable` passes through
 *
 * `auto` does not force a skill into the `/` menu and `manual` does not force
 * it out. A mode answers the index-cost question; the picker question belongs
 * to the author, who is the only party with an opinion about whether their
 * skill is something a person names or background knowledge a model reaches
 * for. This is the ticket's fourth combination decided AUTHOR-ONLY rather than
 * left as an accidental parser outcome: `user-invocable: false` survives Auto
 * and Manual alike, and the Project's escape hatch from it is `off`, which
 * removes the skill rather than pretending to promote it.
 *
 * `off` closes both axes because it is the one mode that is not a budget
 * answer: a person who set it wants the skill gone from this project, and a
 * row that stayed typable would make Off a lie.
 */
export function skillModePolicy(
  mode: SkillMode,
  author: SkillInvocationPolicy,
): SkillInvocationPolicy {
  if (mode === "off") return { modelDiscoverable: false, userInvokable: false };
  return { modelDiscoverable: mode === "auto", userInvokable: author.userInvokable };
}

/**
 * THE resolver: one skill's effective policy under one project's rules.
 *
 * The precedence the whole feature is defined by, and the only place it is
 * spelled:
 *
 *   1. the Project's override for this slug, if it has one
 *   2. the author's own declaration ({@link readAuthorInvocationPolicy})
 *   3. the format's default — already folded into (2)
 *
 * Every consumer resolves through here or through {@link applySkillModes},
 * which is this function in a loop. Before VC-181 the same question was
 * answered in four places against a single boolean, and "is it in the picker"
 * and "is it in the index" could not be asked separately at all.
 */
export function resolveSkillPolicy(
  modes: SkillModes,
  skill: SkillReference,
): SkillInvocationPolicy {
  const mode = modes[skill.name];
  return mode === undefined ? skill.invocation : skillModePolicy(mode, skill.invocation);
}

/**
 * The mode a policy reads as — the Settings Select's value, and the rule the
 * writer uses to tell a real override from a restatement.
 *
 * Lossy on purpose, and only in the direction that cannot mislead: a skill
 * whose author closed both axes reads as `off`, and one that is merely not
 * user-invokable still reads by its model axis, because that is the axis the
 * column governs.
 */
export function authorSkillMode(policy: SkillInvocationPolicy): SkillMode {
  if (isSkillUnavailable(policy)) return "off";
  return policy.modelDiscoverable ? "auto" : "manual";
}

/**
 * What a skill's mode resolves to: the project's rule if it has one, otherwise
 * the mode the author's own declaration reads as.
 *
 * Now that {@link parseSkillModes} keeps `auto`, this answers in both
 * directions — a project can demote a discoverable skill to Manual AND
 * promote an author-manual one to Auto, and neither answer snaps back.
 */
export function resolveSkillMode(modes: SkillModes, skill: SkillReference): SkillMode {
  return modes[skill.name] ?? authorSkillMode(skill.invocation);
}

/**
 * One project's skill list, with its rules applied — the single seam every
 * consumption point goes through.
 *
 * It works by REWRITING each reference's {@link SkillReference.invocation} to
 * its effective policy rather than by teaching every consumer about modes, so
 * a downstream surface asks one question of the row in front of it:
 * {@link skillsIndexResource} reads `modelDiscoverable`, `resolveSlashNamespace`
 * reads `userInvokable`, and neither has to know a Project exists.
 *
 * A skill left {@link isSkillUnavailable} is DROPPED, which is `off`'s job and
 * also an author's when they close both axes themselves. Filesystem read
 * limits and unreadable entries remain the loader's separate safety policy; a
 * shadowed loaded name is renamed rather than dropped.
 *
 * Applied AFTER {@link mergeSkills}, so project-over-personal is already
 * resolved and a slug names exactly one surviving skill — a rule cannot mean
 * "the project's copy but not the personal one".
 *
 * A rule naming nothing installed is ignored: a skill can be uninstalled while
 * its slug is still in the row, and a stale entry is not a reason to fail a
 * read that every composer open depends on.
 *
 * NOTE there is no empty-rules fast path. An author can close both axes with
 * no Project rule at all, so "no rules" is not the same as "nothing to do".
 * References whose policy is unchanged are still returned by identity.
 */
export function applySkillModes(
  skills: readonly SkillReference[],
  modes: SkillModes,
): readonly SkillReference[] {
  const ruled: SkillReference[] = [];
  for (const skill of skills) {
    const invocation = resolveSkillPolicy(modes, skill);
    if (isSkillUnavailable(invocation)) continue;
    ruled.push(sameSkillPolicy(skill.invocation, invocation) ? skill : { ...skill, invocation });
  }
  return ruled;
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
 * The portable top-level field that withholds a skill from the model.
 *
 * Not a Volli invention and not read out of `metadata`: Claude Code,
 * Cursor, VS Code/Copilot and Pi all read this exact top-level key, and Codex
 * spells the same split as `policy.allow_implicit_invocation: false`. The open
 * Agent Skills core format does not standardize it — the spec's frontmatter
 * table stops at `name`, `description`, `license`, `compatibility`,
 * `metadata` and `allowed-tools` — so it remains a client extension. It is
 * nevertheless the one a skill author actually writes, which makes reading it
 * the difference between absorbing the user's toolkit and ignoring half of
 * what it declared.
 */
export const SKILL_DISABLE_MODEL_INVOCATION_KEY = "disable-model-invocation";

/**
 * The portable top-level field that withholds a skill from the `/` menu.
 *
 * The other axis, and the one Volli could not previously express at all.
 * Copilot's table is the clearest statement of it: `user-invocable: false`
 * hides the row "while still allowing the agent to load it automatically" —
 * background knowledge a person never types.
 */
export const SKILL_USER_INVOCABLE_KEY = "user-invocable";

/**
 * Volli's original `metadata` spelling of "keep me out of the index".
 *
 * KEPT AS AN ALIAS, NOT AS THE PRIMARY SPELLING (VC-181). It was chosen
 * because `metadata` is where the spec sanctions client-specific properties,
 * which is correct about the spec and wrong about the ecosystem: no skill in
 * the wild carries it, and a Volli-only key asks an author to write something
 * for Volli alone. {@link SKILL_DISABLE_MODEL_INVOCATION_KEY} is now the
 * spelling Volli documents; this one still resolves so a SKILL.md written
 * against the old rule does not silently change behaviour.
 */
export const SKILL_USER_INVOKE_ONLY_KEY = "volli-user-invoke-only";

/** What one frontmatter flag turned out to be. */
type FlagRead =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly value: boolean }
  | { readonly kind: "malformed"; readonly raw: string };

/**
 * One boolean-ish frontmatter flag, read leniently.
 *
 * YAML gives a bare `true` as a boolean, but `metadata` is typed string→string
 * by the spec and plenty of authors quote their flags regardless, so `"true"`
 * and `"false"` are accepted in either case. Anything else is MALFORMED rather
 * than false: a value nobody can act on is a mistake worth naming, and
 * silently reading `disable-model-invocation: yes` as "no" is precisely the
 * kind of quiet wrong answer this module exists to avoid.
 */
function readFlag(value: unknown): FlagRead {
  if (value === undefined || value === null) return { kind: "absent" };
  if (typeof value === "boolean") return { kind: "read", value };
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "") return { kind: "absent" };
    if (normalized === "true") return { kind: "read", value: true };
    if (normalized === "false") return { kind: "read", value: false };
    return { kind: "malformed", raw: value.trim() };
  }
  return { kind: "malformed", raw: String(value) };
}

/** The invocation-shaped fields of a parsed SKILL.md, as the reader hands them over. */
export interface SkillPolicyFrontmatter {
  /** Top-level `disable-model-invocation`. */
  readonly disableModelInvocation?: unknown;
  /** Top-level `user-invocable`. */
  readonly userInvocable?: unknown;
  /** The spec's `metadata` map, for the legacy alias alone. */
  readonly metadata?: unknown;
}

/** An author's declared policy, and anything about it worth saying out loud. */
export interface AuthorInvocationPolicy {
  readonly policy: SkillInvocationPolicy;
  /** One line naming a conflict or a value that could not be read. */
  readonly diagnostic: string | null;
}

/** The legacy `metadata` alias, or absent. */
function readLegacyFlag(metadata: unknown): FlagRead {
  if (typeof metadata !== "object" || metadata === null) return { kind: "absent" };
  return readFlag((metadata as Record<string, unknown>)[SKILL_USER_INVOKE_ONLY_KEY]);
}

/**
 * What a SKILL.md's own frontmatter asked for — rung 2 of
 * {@link resolveSkillPolicy}'s precedence, and the only place a file's words
 * become a policy.
 *
 * ## The deterministic answer to a conflict
 *
 * The model axis has two spellings and they can disagree. The portable
 * top-level field WINS, always, and the disagreement is reported rather than
 * absorbed. That direction is the only defensible one: the top-level field is
 * what the author wrote for every other harness they use, so a Volli-only
 * `metadata` key quietly overriding it would make this the one client that
 * reads their file differently. The alias still decides the axis when the
 * portable field is absent, which is the whole point of keeping it.
 *
 * A malformed value never silently becomes `false`. It falls through to the
 * next rung — alias, then the format's default — and says so, because
 * `disable-model-invocation: yes` is a skill whose author believes it is
 * withheld from the model and is wrong about that.
 */
export function readAuthorInvocationPolicy(
  frontmatter: SkillPolicyFrontmatter,
): AuthorInvocationPolicy {
  const diagnostics: string[] = [];
  const portable = readFlag(frontmatter.disableModelInvocation);
  const legacy = readLegacyFlag(frontmatter.metadata);
  const invocable = readFlag(frontmatter.userInvocable);

  if (portable.kind === "malformed") {
    diagnostics.push(
      `${SKILL_DISABLE_MODEL_INVOCATION_KEY}: "${portable.raw}" is not true or false — ignored.`,
    );
  }
  if (legacy.kind === "malformed") {
    diagnostics.push(
      `metadata.${SKILL_USER_INVOKE_ONLY_KEY}: "${legacy.raw}" is not true or false — ignored.`,
    );
  }
  if (invocable.kind === "malformed") {
    diagnostics.push(
      `${SKILL_USER_INVOCABLE_KEY}: "${invocable.raw}" is not true or false — ignored.`,
    );
  }
  if (portable.kind === "read" && legacy.kind === "read" && portable.value !== legacy.value) {
    diagnostics.push(
      `${SKILL_DISABLE_MODEL_INVOCATION_KEY}: ${String(portable.value)} conflicts with ` +
        `metadata.${SKILL_USER_INVOKE_ONLY_KEY}: ${String(legacy.value)} — ` +
        `${SKILL_DISABLE_MODEL_INVOCATION_KEY} wins.`,
    );
  }

  // Precedence, top down: portable field, legacy alias, format default.
  const withheld =
    portable.kind === "read" ? portable.value : legacy.kind === "read" ? legacy.value : false;
  return {
    policy: {
      modelDiscoverable: !withheld,
      userInvokable: invocable.kind === "read" ? invocable.value : true,
    },
    diagnostic: diagnostics.length === 0 ? null : diagnostics.join(" "),
  };
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
 * Two kinds of skill are left out, and only two. A skill whose effective
 * policy is not `modelDiscoverable` is not advertised — its author's decision,
 * its project's, or both. Hidden ENTIRELY rather than listed and refused at
 * activation, which is the client guide's own rule: listing a skill the model
 * cannot load only buys a wasted turn. And `injectedNames` are removed because a
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
    .filter((skill) => skill.invocation.modelDiscoverable && !injected.has(skill.name))
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
