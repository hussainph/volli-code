/**
 * Reading per-project skills off disk — the `/` picker's second supply, and
 * the attach-time injection's source of bodies.
 *
 * Two directories, one shape: `<projectPath>/.agents/skills/<slug>/SKILL.md`
 * and `<home>/.agents/skills/<slug>/SKILL.md` — the project and personal
 * tiers of the `npx skills add` convention this repo already vendors, merged
 * project-over-personal by `mergeSkills`. The slug — the
 * directory name — is the skill's whole identity here (`@volli/shared`'s
 * `skill.ts` says why the frontmatter `name` cannot be), so a slug the `/name`
 * grammar cannot spell is skipped rather than offered unreachably. The
 * frontmatter parses under the same rules as a prompt template — same fence,
 * same description key, same first-line fallback — which is why this module
 * borrows `prompt-templates.ts`'s parser instead of writing a second one.
 * Two kinds of field are read and no others: `description`, and the invocation
 * policy — portable `disable-model-invocation`, recognized
 * `user-invocable`, plus Volli's original `metadata` alias for the first
 * of them. What those declarations MEAN is not decided here: the frontmatter
 * goes to `@volli/shared`'s `readAuthorInvocationPolicy`, which owns
 * precedence and the diagnostics a conflicting file earns, so main and the
 * renderer cannot hold two answers about one file. A skill that declares
 * nothing behaves the way the format says it should, which is disclosed.
 *
 * Codex's `agents/openai.yaml` is deliberately NOT read. It is that client's
 * own presentation/configuration file and lives beside a skill rather than
 * inside its frontmatter; parsing it here would make Volli's answer depend on
 * whether another harness happened to be configured in this checkout.
 *
 * The failure policy is `prompt-templates.ts`'s, verbatim: a missing
 * directory is the normal case and reads as empty, only a directory that
 * exists and cannot be read is an error, and one unreadable SKILL.md loses
 * that skill alone. Malformed YAML remains an unruled Settings row carrying a
 * diagnostic but fails closed everywhere else. A directory without a readable
 * SKILL.md is not a skill and is not a fault either — `.agents/skills/` may
 * hold anything an installer left.
 */
import { promises as fsp, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  errorMessage,
  isSkillName,
  mergeSkills,
  promptTemplateDescription,
  readAuthorInvocationPolicy,
  SKILL_POLICY_UNAVAILABLE,
  skillRootDir,
  type SkillReference,
} from "@volli/shared";

import { parsePromptTemplateFile } from "./prompt-templates";

/**
 * How many skill directories one project may contribute. The same cap and the
 * same reasoning as templates: skills are installed one by one, and the cap
 * exists so a mistyped path cannot turn a picker open into a directory storm.
 */
const MAX_SKILLS_PER_DIR = 200;

/** The one file that makes a directory a skill. */
const SKILL_FILE = "SKILL.md";

/** Both tiers' reads, and what one of them failing means. */
export type SkillReadResult = { ok: true; skills: SkillReference[] } | { ok: false; error: string };

/**
 * Every skill under `dir`, name-sorted.
 *
 * One level deep and `SKILL.md`-only: the convention is dir-per-skill, and
 * anything else in the directory — READMEs, assets, `custom/` extensions — is
 * the skill's own business, delivered by reference if the skill's body points
 * at it, never inlined here.
 *
 * `rootFor` spells the directory the MODEL is given for a slug, which is the
 * one thing the two tiers do not share: workspace-relative for a project
 * skill, absolute for a personal one. The reader takes it rather than
 * deriving it, because only the caller knows which tier `dir` is.
 */
export async function readSkillDir(
  dir: string,
  rootFor: (slug: string) => string,
): Promise<SkillReadResult> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // The directory simply not being there is the normal case, not a fault.
    if (isMissingPath(error)) return { ok: true, skills: [] };
    return { ok: false, error: errorMessage(error) };
  }

  // Symlinked skill directories count for the reason symlinked templates do:
  // a shared skill set linked into a project is a real thing people do, and a
  // dirent for a symlink says `isSymbolicLink`, never `isDirectory`. The read
  // below follows it; one that points at nothing loses that row alone.
  const slugs = entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && isSkillName(entry.name))
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b))
    .slice(0, MAX_SKILLS_PER_DIR);

  const skills: SkillReference[] = [];
  for (const slug of slugs) {
    let raw: string;
    try {
      raw = await fsp.readFile(join(dir, slug, SKILL_FILE), "utf8");
    } catch {
      // No readable SKILL.md — not a skill, and one loss never costs the rest.
      continue;
    }
    const {
      description,
      metadata,
      disableModelInvocation,
      userInvocable,
      frontmatterDiagnostic,
      body,
    } = parsePromptTemplateFile(raw);
    const author =
      frontmatterDiagnostic === null
        ? readAuthorInvocationPolicy({ disableModelInvocation, userInvocable, metadata })
        : {
            policy: SKILL_POLICY_UNAVAILABLE,
            diagnostic: `${frontmatterDiagnostic} This skill is unavailable until SKILL.md is fixed.`,
          };
    skills.push({
      name: slug,
      description: promptTemplateDescription({ body, frontmatterDescription: description }),
      body,
      authorPolicy: author.policy,
      effectivePolicy: author.policy,
      policyDiagnostic: author.diagnostic,
      root: rootFor(slug),
    });
  }
  return { ok: true, skills };
}

/**
 * Both tiers, merged into the list every surface sees — `loadPromptTemplates`'
 * shape, and its failure policy verbatim: the two reads are independent, so
 * one tier's ABSENCE is simply an empty tier, while a directory that exists
 * and cannot be read is a real fault either surface says out loud. Personal
 * skills are addressed absolutely because no workspace-relative path reaches
 * `~`; project skills stay workspace-relative so a worktree Session reads its
 * own checkout's copy.
 */
export async function loadSkills(input: {
  projectSkillsDir: string;
  globalSkillsDir: string;
}): Promise<{ ok: true; skills: readonly SkillReference[] } | { ok: false; error: string }> {
  const [project, global] = await Promise.all([
    readSkillDir(input.projectSkillsDir, skillRootDir),
    readSkillDir(input.globalSkillsDir, (slug) => `${input.globalSkillsDir}/${slug}`),
  ]);
  if (!project.ok) return project;
  if (!global.ok) return global;
  return { ok: true, skills: mergeSkills({ project: project.skills, global: global.skills }) };
}

/** ENOENT/ENOTDIR — the directory is absent, which this surface treats as empty. */
function isMissingPath(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
