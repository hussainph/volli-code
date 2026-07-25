/**
 * The one conversion between the two path vocabularies the renderer holds at
 * once: the sidebar file tree walks ABSOLUTE paths (it lists directories by
 * absolute path and remembers expansion by absolute path), while every file API
 * — reads, writes, watches, and the Project Files tab workspace — speaks
 * PROJECT-RELATIVE paths.
 *
 * Renderer-side and string-only: there is no `path` module here (no Node
 * imports), and this is deliberately NOT a security boundary — main re-resolves
 * and re-validates every relPath it is handed. What it must get right is the
 * containment test, because the naive `startsWith` version happily maps
 * `/repo-old/src` into `/repo` and would then read the wrong repository's file.
 */

/**
 * Repeated and trailing separators collapsed.
 *
 * Backslash is deliberately left alone. This is a macOS-only app, where `\` is
 * an ordinary filename character: rewriting it would alias a root file named
 * `a\b.txt` onto the relPath `a/b.txt` — a DIFFERENT file, which may well
 * exist. Kept literal, such a name is rejected outright by `isSafeRelPath` in
 * main (backslash is not a legal relPath character there), so the tree row
 * fails honestly instead of quietly opening the wrong file.
 */
function normalize(path: string): string {
  return path.replace(/\/+/g, "/").replace(/\/+$/, "");
}

/**
 * `absPath` expressed relative to `projectPath`, or `null` when it lies outside
 * the project. The project directory itself maps to `""` — the root relPath the
 * directory-watch API expects (`"."` is rejected by main).
 */
export function toProjectRelPath(projectPath: string, absPath: string): string | null {
  const root = normalize(projectPath);
  const target = normalize(absPath);
  if (root === "") return null;
  if (target === root) return "";
  // The separator is part of the prefix test on purpose: without it `/repo`
  // "contains" the sibling `/repo-old`.
  if (!target.startsWith(`${root}/`)) return null;
  return target.slice(root.length + 1);
}
