/**
 * What the Skills pane says about tokens — estimated, and honest about it.
 *
 * Two numbers, two different bills:
 *
 *  - {@link skillBodyTokens} is one skill's SIZE: what activating it costs,
 *    once, when the model reads its SKILL.md. A column in the table, so "this
 *    skill is a pamphlet" and "this skill is a book" are visible before anyone
 *    turns it to Auto.
 *  - {@link skillsIndexTokens} is the standing charge: the metadata index that
 *    rides the stable prefix of EVERY turn, for the skills currently resolving
 *    to Auto. Computed by composing the REAL index — `applySkillModes` into
 *    `skillsIndexResource`, the exact functions the runtime composes with — so
 *    this number cannot drift from what a Session actually pays.
 *
 * The estimator is the app's standing heuristic (4 chars ≈ 1 token, the same
 * constant `chat/context-usage.ts` uses); every rendering of these numbers
 * carries a `~` for that reason.
 */
import {
  applySkillModes,
  skillsIndexResource,
  type SkillModes,
  type SkillReference,
} from "@volli/shared";

/** Mirrors `CHARS_PER_TOKEN` in `chat/context-usage.ts` — one heuristic, app-wide. */
const CHARS_PER_TOKEN = 4;

/** The 4-chars-per-token estimate. Zero text is zero tokens, never `ceil(0/4)` edge-cased. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** What reading this skill costs when it is activated: its body, estimated. */
export function skillBodyTokens(skill: SkillReference): number {
  return estimateTokens(skill.body);
}

/**
 * The per-turn index charge under `modes`: preamble plus one row per skill
 * still advertised after the project's rules are applied. `0` when nothing is
 * advertised — the runtime composes no index resource at all then.
 */
export function skillsIndexTokens(skills: readonly SkillReference[], modes: SkillModes): number {
  const resource = skillsIndexResource(applySkillModes(skills, modes));
  return resource === null ? 0 : estimateTokens(resource.text);
}
