/**
 * Reading per-project skills off disk — the `/` picker's second supply, and
 * the attach-time injection's source of bodies.
 *
 * One directory, one shape: `<projectPath>/.agents/skills/<slug>/SKILL.md`,
 * the `npx skills add` convention this repo already vendors. The slug — the
 * directory name — is the skill's whole identity here (`@volli/shared`'s
 * `skill.ts` says why the frontmatter `name` cannot be), so a slug the `/name`
 * grammar cannot spell is skipped rather than offered unreachably. The
 * frontmatter parses under the same rules as a prompt template — same fence,
 * same description key, same first-line fallback — which is why this module
 * borrows `prompt-templates.ts`'s parser instead of writing a second one.
 *
 * The failure policy is `prompt-templates.ts`'s, verbatim: a missing
 * directory is the normal case and reads as empty, only a directory that
 * exists and cannot be read is an error, and one broken skill loses that
 * skill alone. A directory without a readable SKILL.md is not a skill and is
 * not a fault either — `.agents/skills/` may hold anything an installer left.
 */
import { promises as fsp, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  errorMessage,
  isSkillName,
  promptTemplateDescription,
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

/**
 * Every skill under `dir`, name-sorted.
 *
 * One level deep and `SKILL.md`-only: the convention is dir-per-skill, and
 * anything else in the directory — READMEs, assets, `custom/` extensions — is
 * the skill's own business, delivered by reference if the skill's body points
 * at it, never inlined here.
 */
export async function readProjectSkills(
  dir: string,
): Promise<{ ok: true; skills: SkillReference[] } | { ok: false; error: string }> {
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
    const { description, body } = parsePromptTemplateFile(raw);
    skills.push({
      name: slug,
      description: promptTemplateDescription({ body, frontmatterDescription: description }),
      body,
    });
  }
  return { ok: true, skills };
}

/** ENOENT/ENOTDIR — the directory is absent, which this surface treats as empty. */
function isMissingPath(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
