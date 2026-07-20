/**
 * Project identity: the record shape, and the naming rules used when a
 * project is created (monogram for the rail avatar, ticket-prefix
 * derivation, prefix validation, and the round-robin color palette).
 * Ported behavior-for-behavior from the Swift original.
 */

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
