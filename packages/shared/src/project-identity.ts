/**
 * Project identity: the record shape, and the naming rules used when a
 * project is created (monogram for the rail avatar, ticket-prefix
 * derivation, prefix validation, and the round-robin color palette).
 * Ported behavior-for-behavior from the Swift original.
 */

import { REASONING_LEVELS, type ModelSelection } from "./agent-runtime";
import type { AuthorityPolicyOverride } from "./authority-config";
import type { SkillModes } from "./skill";
import type { Appearance, Canvas } from "./theme/canvas/types";
import type { ProjectThemeOverride } from "./theme/project-override";

/**
 * A tracked project. Mirrors the SQLite `projects` row shape (migration
 * 001): `sortOrder` drives rail order (dense, rewritten `0..n-1` on
 * reorder) and `updatedAt` tracks the row's last write.
 */
export interface Project {
  id: string;
  name: string;
  path: string;
  ticketPrefix: string;
  /** Pinned automation base branch; null until detected or explicitly configured. */
  baseBranch?: string | null;
  /**
   * Per-project setup command run in a fresh ticket worktree's terminal before
   * the harness starts (worktree-support §6, migration 008). Null until the
   * user configures one, in which case the worktree phase skips setup entirely.
   */
  setupCommand?: string | null;
  /**
   * Per-surface theming override (decision #69, migration 013). `null` — the
   * default for every project (#72) — means the project inherits the global
   * theme on all three surfaces; a non-null value still inherits per surface
   * wherever its own field is null.
   */
  themeOverride?: ProjectThemeOverride | null;
  /**
   * This workspace's own canvas (migration 014), or `null` to inherit the
   * global one. Whole or not at all — a canvas is a gradient, and half of one
   * is not a thing you can paint, which is why this is one nullable field
   * rather than 013's per-surface set.
   */
  themeCanvas?: Canvas | null;
  /**
   * This workspace's own light/dark/auto choice (migration 014), or `null` to
   * inherit the global one. Scoped SEPARATELY from {@link themeCanvas}: one
   * canvas is designed to render correctly in both modes, so overriding the
   * gradient and overriding the mode are independent things to want.
   */
  themeAppearance?: Appearance | null;
  /**
   * How much of itself each skill offers this project (migration 023,
   * VC-111) — see {@link SkillMode}. Holds only DEPARTURES from each skill's
   * own frontmatter default, so an empty map means "every skill as its author
   * intended", which is exactly what an absent column means.
   */
  skillModes?: SkillModes;
  /**
   * This project's harness for new Sessions, or `null` to inherit the app-wide
   * default ({@link DEFAULT_HARNESS_ID}). Not constrained to {@link HarnessId}:
   * harnesses are user-registrable, so the legal set is a table at runtime.
   */
  sessionHarness?: string | null;
  /**
   * This project's model for new Sessions, or `null` to inherit Model Access's
   * app-wide per-purpose default. Scoped separately from {@link sessionHarness}
   * for migration 014's reason: overriding one must not clear the other.
   */
  sessionModel?: ModelSelection | null;
  /**
   * What this project says about the authority its Sessions run under
   * (migration 025, VC-44) — or `null`/absent to be governed entirely by
   * {@link DEFAULT_AUTHORITY_POLICY}.
   *
   * The DEPARTURES, never the resolved document, for the reason migration 025
   * ruled: storing the resolved policy would mean tightening a built-in default
   * later silently skipped every project anyone had ever touched. `skillModes`
   * above holds its column the same way and for the same reason.
   *
   * Carried up to the renderer in this shape too, so the surface that edits it
   * can tell "this project chose `observe`" from "this project inherits
   * `observe`" — a distinction the resolved document destroys, and the one a
   * revert control needs in order to exist. Resolve it with
   * {@link resolveAuthorityPolicy}; never hand the resolved value back here.
   */
  authorityPolicy?: AuthorityPolicyOverride | null;
  /** Index into {@link PROJECT_COLORS}, assigned round-robin at creation. */
  colorIndex: number;
  /** Rail order; dense, rewritten `0..n-1` whenever the rail is reordered. */
  sortOrder: number;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
}

/** Splits on runs of non-alphanumeric characters (Unicode-aware), dropping empties. */
function words(name: string): string[] {
  return name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

/**
 * Short avatar text for a project's rail icon: initials of the first two
 * words, or the first two characters of a single word, uppercased.
 * Falls back to `"?"` when the name has no word characters at all.
 */
export function monogram(name: string): string {
  const parts = words(name);
  if (parts.length >= 2) {
    return (parts[0]![0] + parts[1]![0]).toUpperCase();
  }
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return "?";
}

/**
 * Derives a default ticket prefix from a project name: initials of the
 * first three words (or the first two characters of a single word),
 * uppercased, stripped to letters/numbers, then stripped of any leading
 * digits. Falls back to `"PRJ"` when nothing survives.
 */
export function derivePrefix(name: string): string {
  const parts = words(name);
  let candidate: string;
  if (parts.length >= 2) {
    candidate = parts
      .slice(0, 3)
      .map((word) => word[0])
      .join("");
  } else if (parts.length === 1) {
    candidate = parts[0]!.slice(0, 2);
  } else {
    return "PRJ";
  }

  const alnum = candidate
    .toUpperCase()
    .split("")
    .filter((ch) => /[\p{L}\p{N}]/u.test(ch))
    .join("");

  const stripped = alnum.replace(/^[\p{N}]+/u, "");
  return stripped || "PRJ";
}

/**
 * A prefix is valid iff it is 1–5 characters, starts with an ASCII
 * uppercase letter, and contains only ASCII uppercase letters and digits
 * thereafter (e.g. "VC", "VC12").
 */
export function isValidPrefix(s: string): boolean {
  return /^[A-Z][A-Z0-9]{0,4}$/.test(s);
}

export type PrefixValidationResult = { ok: true } | { ok: false; error: string };

/** Validates the workspace-global ticket-prefix invariant with a human-readable collision. */
export function validateUniquePrefix(
  prefix: string,
  projects: readonly Pick<Project, "id" | "name" | "ticketPrefix">[],
  excludingProjectId?: string,
): PrefixValidationResult {
  if (!isValidPrefix(prefix)) {
    return {
      ok: false,
      error: "Ticket prefixes must be 1–5 uppercase letters or digits and start with a letter.",
    };
  }
  const collision = projects.find(
    (project) => project.id !== excludingProjectId && project.ticketPrefix === prefix,
  );
  return collision
    ? { ok: false, error: `Ticket prefix "${prefix}" is already used by ${collision.name}.` }
    : { ok: true };
}

/**
 * Palette assigned round-robin (`projects.length % PROJECT_COLORS.length`)
 * when a project is created. Order is data: index 0 is the ember accent.
 */
export const PROJECT_COLORS = [
  "#E8652A",
  "#C98A1B",
  "#6E8B5E",
  "#5E7A8B",
  "#8B5E7A",
  "#A96A4F",
  "#4F7D6B",
  "#7A7A72",
] as const;

/**
 * Looks up a project's color, wrapping out-of-range indices modulo the
 * palette length. Defensively coerces non-integer/negative input.
 */
export function projectColor(colorIndex: number): string {
  const index = Math.abs(Math.trunc(colorIndex)) % PROJECT_COLORS.length;
  return PROJECT_COLORS[index]!;
}

/**
 * A stored `session_model` payload as a {@link ModelSelection}, or `null` for
 * anything that is not one. Same degrade-don't-throw stance as
 * {@link parseSkillModes}; a project whose column is nonsense inherits the
 * app-wide default, which is both survivable and visible.
 */
export function parseSessionModel(value: unknown): ModelSelection | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const { providerId, modelId, reasoningLevel } = candidate;
  if (typeof providerId !== "string" || providerId.length === 0) return null;
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  const level = REASONING_LEVELS.find((known) => known === reasoningLevel);
  if (level === undefined) return null;
  return { providerId, modelId, reasoningLevel: level };
}
