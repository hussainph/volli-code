/**
 * The `.volli` artifacts domain (ticket-detail-mvp decisions #13/#14/#17):
 * filesystem-as-truth, two tiers (project-level `.volli/artifacts/` and
 * ticket-scoped `.volli/tickets/<DISPLAY-ID>/artifacts/`, see
 * `volli-dir.ts`), no artifacts DB table. Pure string/classification logic
 * only — no Node imports (`fs`/`path`); the actual filesystem work lives in
 * main's `volli-fs.ts`, which consumes these helpers so the classification
 * and name-safety rules are unit-tested once and shared by every caller.
 */

export type ArtifactTier = "project" | "ticket";

/** `.md`/`.markdown` render/edit in the Artifacts tab; images render inline; everything else is name + reveal-in-Finder. */
export type ArtifactKind = "markdown" | "image" | "other";

/** One artifact row, as listed for the Artifacts tab. */
export interface ArtifactEntry {
  name: string;
  /** Relative to the tier's artifacts directory — currently always equal to `name` (listing is flat, no subdirectories). */
  relPath: string;
  tier: ArtifactTier;
  /** Bytes. */
  size: number;
  /** Epoch milliseconds. */
  mtime: number;
  kind: ArtifactKind;
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** The lowercased extension (no dot), or `null` when `name` has none — pure, no `path.extname`. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  // A leading dot alone (".gitignore") is a dotfile, not an extension.
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** Classifies an artifact's kind by its extension (case-insensitive). */
export function classifyArtifactKind(name: string): ArtifactKind {
  const ext = extensionOf(name);
  if (ext === null) return "other";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "other";
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The MIME type for an image artifact's inline `data:` URI, or `null` when `name` isn't a recognized image extension. */
export function artifactImageMimeType(name: string): string | null {
  const ext = extensionOf(name);
  return ext === null ? null : (IMAGE_MIME_TYPES[ext] ?? null);
}

/**
 * Whether `name` is safe to join onto an artifacts directory: non-empty, no
 * path separators (blocks both traversal like `"../x"` and absolute inputs
 * like `"/etc/passwd"` in one check, since either requires a `/`), and not
 * the literal `"."`/`".."` (which would resolve to the directory itself or
 * its parent even without a separator). This is the first of two path-safety
 * layers — `volli-fs.ts` additionally verifies via `realpath` that the
 * resolved file stays inside the project's `.volli` directory (guards
 * against a symlink swapped into the artifacts directory itself).
 */
export function isSafeArtifactEntryName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name === "." || name === "..") return false;
  return true;
}

/**
 * Whether `rawName` is a valid *base* name for a brand-new artifact (the
 * `.create` name-prompt input, before {@link withMarkdownExtension} forces
 * the `.md` suffix): trims to non-empty, passes the same separator/`..`
 * safety check as an existing entry name, and — unlike an already-on-disk
 * entry name — additionally rejects a leading-dot name. A dotfile artifact
 * (e.g. `.notes` → `.notes.md`, or the literal `.md`) would be created but
 * then skipped by the tier listing (which hides dotfiles), so it would vanish
 * from the UI the moment it appeared; refusing it at creation avoids that.
 */
export function isValidNewArtifactName(rawName: string): boolean {
  const trimmed = rawName.trim();
  if (trimmed.startsWith(".")) return false;
  return isSafeArtifactEntryName(trimmed);
}

/** Forces a trimmed name to end in `.md` (case-insensitively already-`.md` names pass through unchanged). */
export function withMarkdownExtension(name: string): string {
  const trimmed = name.trim();
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

/** The name with its extension stripped — used to seed a new artifact's `# Heading` template. */
export function artifactBaseName(name: string): string {
  const ext = extensionOf(name);
  return ext === null ? name : name.slice(0, name.length - ext.length - 1);
}

/** Case-insensitive name ascending, tying on the raw string — same shape as `fs-entries.ts`'s `compareDirEntries`. */
export function compareArtifactEntries(a: ArtifactEntry, b: ArtifactEntry): number {
  const aLower = a.name.toLowerCase();
  const bLower = b.name.toLowerCase();
  if (aLower !== bLower) return aLower < bLower ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
