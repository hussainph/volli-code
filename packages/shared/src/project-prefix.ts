/**
 * A project's naming rules that need nothing else: the words of a name, the
 * ticket prefix derived from it, prefix validity, and the tile palette. Kept
 * apart from `project-identity.ts` so the cloud board rules can use them
 * without importing the local project record and everything it names.
 */

/** Splits on runs of non-alphanumeric characters (Unicode-aware), dropping empties. */
export function words(name: string): string[] {
  return name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
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
