/**
 * The file-classification + `@file`-ref domain (global-artifacts decisions
 * #3/#4/#7/#8): classifying a repo file by extension, parsing `@relative/path`
 * references out of markdown, fuzzy-ranking the project file index for the `@`
 * picker, and the name-safety rules for creating a new artifact. Pure
 * string/classification logic only — no Node imports (`fs`/`path`); the actual
 * filesystem work lives in main's `volli-fs.ts`, which consumes these helpers
 * so the classification, ref-parsing, and name-safety rules are unit-tested
 * once and shared by every caller (editor decoration, the picker, main).
 */

/**
 * How a file's BYTES are handled: `"markdown"` and `"other"` are utf8 text the
 * editor round-trips (`.md`/`.markdown` get the document treatment; everything
 * else is source), while `"image"` means raster bytes — rendered inline, never
 * served or written as text. SVG is text, not `"image"`: see
 * {@link IMAGE_EXTENSIONS}.
 */
export type FileKind = "markdown" | "image" | "other";

/** Which checkout a resolved path came from — the worktree copy or the main repo. */
export type FileSource = "worktree" | "main";

/**
 * One entry in the project file index the `@` picker ranks over: a
 * project-relative path, its {@link FileKind}, and whether it lives under
 * `.volli/artifacts/` (force-included in the index and ranked first).
 */
export interface IndexedFile {
  relPath: string;
  kind: FileKind;
  artifact: boolean;
}

/** The project-relative directory every artifact lives under (decision #1). */
export const VOLLI_ARTIFACTS_REL_DIR = ".volli/artifacts";

/** Whether `relPath` is (or is under) `.volli/artifacts/` — the artifact tier. */
export function isArtifactRelPath(relPath: string): boolean {
  return relPath === VOLLI_ARTIFACTS_REL_DIR || relPath.startsWith(`${VOLLI_ARTIFACTS_REL_DIR}/`);
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
/**
 * RASTER image extensions. `"image"` is the kind that means "these bytes are
 * not text": it is the single gate that makes main serve a `data:` URI instead
 * of utf8 (`readContent`), makes `writeFile` refuse the path outright, and
 * makes {@link import("./file-save-policy").fileSavePolicy} return `read-only`.
 *
 * SVG is deliberately NOT here. It is markup — utf8 the editor can show, edit
 * and write back losslessly — and in a general-purpose file workbench that is
 * the affordance that matters: an `<img>` of your icon with no way to touch the
 * path data is a dead end. (Monaco already agreed: `document-identity.ts` has
 * mapped `svg → "xml"` since the editor landed, a branch that was unreachable
 * while this set claimed SVG was an image.) It stays in
 * {@link IMAGE_MIME_TYPES}, so any surface that wants to PREVIEW one can still
 * build its data URI.
 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** The basename of a `/`-separated path (or the whole string when there's no separator). */
export function baseNameOf(pathOrName: string): string {
  const slash = pathOrName.lastIndexOf("/");
  return slash === -1 ? pathOrName : pathOrName.slice(slash + 1);
}

/** The directory portion of a relPath — `""` at the repo root (no separator). */
export function dirNameOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

/**
 * The lowercased extension (no dot) of a path's basename, or `null` when it has
 * none — pure, no `path.extname`. Operates on the basename so a dot in a parent
 * directory name (`a.b/notes`) never counts as the file's extension, and a
 * leading dot alone (`.gitignore`) is a dotfile, not an extension.
 */
function extensionOf(pathOrName: string): string | null {
  const name = baseNameOf(pathOrName);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** Classifies a file's kind by its extension (case-insensitive), accepting a bare name or a full relPath. */
export function classifyFileKind(pathOrName: string): FileKind {
  const ext = extensionOf(pathOrName);
  if (ext === null) return "other";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "other";
}

/**
 * MIME types for rendering a file AS an image. Wider than
 * {@link IMAGE_EXTENSIONS} by exactly one entry: SVG classifies as text (so it
 * opens in the editor) but is still a perfectly good `<img>` source, and this
 * map is what any preview surface needs to build its data URI.
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The MIME type for rendering a path as an image, or `null` when it names no image format. */
export function imageMimeType(pathOrName: string): string | null {
  const ext = extensionOf(pathOrName);
  return ext === null ? null : (IMAGE_MIME_TYPES[ext] ?? null);
}

// ---- @file ref parsing --------------------------------------------------------

/** One `@relative/path` reference found in markdown: the path plus its source span. */
export interface FileRef {
  /** The referenced project-relative path (the text after `@`, trailing punctuation stripped). */
  path: string;
  /** Offset of the `@` sigil in the source string. */
  from: number;
  /** Offset one past the last path character (after trailing punctuation is stripped). */
  to: number;
}

/** Path-token character class: the run consumed right after an `@` sigil. */
function isPathChar(ch: string): boolean {
  return /[A-Za-z0-9._/-]/.test(ch);
}

/** Trailing sentence punctuation stripped off a consumed path token (`plan.md.` → `plan.md`). */
function stripTrailingPunctuation(token: string): string {
  let end = token.length;
  // charAt (not indexing) — it returns "" out of range, so no dead ?? branch
  // survives to break the shared package's 100% branch-coverage gate.
  while (end > 0 && ".,;:!?)".includes(token.charAt(end - 1))) end -= 1;
  return token.slice(0, end);
}

/**
 * Finds `@`-file references in `markdown` (decision #4). An `@` starts a ref
 * only at start-of-line, after whitespace, or after `(` — so an email's
 * `foo@bar.com` is never a ref. The path is a run of `[A-Za-z0-9._/-]` (no
 * spaces — the accepted v1 limitation) that must contain at least one `/` or
 * `.` to distinguish a file path from a bare `@mention`; trailing `.,;:!?)` is
 * stripped. Returns each ref's path plus its `[from, to)` span so the editor
 * can decorate the token into a chip. Dangling-safe: a lone `@`, an `@` at
 * end-of-string, or an `@word` with no `/` or `.` yields no ref.
 */
export function parseFileRefs(markdown: string): FileRef[] {
  const refs: FileRef[] = [];
  for (let i = 0; i < markdown.length; i += 1) {
    if (markdown[i] !== "@") continue;
    const prev = i === 0 ? undefined : markdown[i - 1];
    const boundaryOk = prev === undefined || /\s/.test(prev) || prev === "(";
    if (!boundaryOk) continue;

    let j = i + 1;
    while (j < markdown.length && isPathChar(markdown.charAt(j))) j += 1;
    const rawToken = markdown.slice(i + 1, j);
    const path = stripTrailingPunctuation(rawToken);
    // Advance past the whole consumed run regardless, so an invalid token
    // doesn't get its inner `@`s re-scanned.
    i = j - 1;
    if (path.length === 0) continue;
    if (!path.includes("/") && !path.includes(".")) continue;
    refs.push({ path, from: i - rawToken.length, to: i - rawToken.length + 1 + path.length });
  }
  return refs;
}

/**
 * Whether inserting `@${relPath}` round-trips through {@link parseFileRefs}
 * back to exactly `relPath` — the picker uses this to refuse paths the ref
 * grammar can't express, which would otherwise be inserted verbatim and then
 * silently degrade to plain text. Three conditions, mirroring the parser:
 * every character is in the path char class `[A-Za-z0-9._/-]` (so a space,
 * `[slug]`, or `+` truncates the run early), {@link stripTrailingPunctuation}
 * is a no-op on it (a path ending in `.`/`,`/… would be clipped), and it holds
 * at least one `/` or `.` (the parser needs one to tell a file ref from a bare
 * `@mention`, so a repo-root extensionless file like `Makefile` is NOT
 * expressible). Empty is never expressible. This is the accepted v1 grammar
 * limitation — paths with spaces or shell-glob characters simply can't be `@`-
 * referenced yet.
 */
export function isExpressibleRefPath(relPath: string): boolean {
  if (relPath.length === 0) return false;
  for (const ch of relPath) {
    if (!isPathChar(ch)) return false;
  }
  if (stripTrailingPunctuation(relPath) !== relPath) return false;
  return relPath.includes("/") || relPath.includes(".");
}

// ---- fuzzy ranking for the @ picker -------------------------------------------

/**
 * Subsequence-match score of `query` against `text` (both already lowercased),
 * or `null` when `query`'s characters don't appear in order. Rewards contiguous
 * runs and matches at a word boundary (start, or right after `/._-`) so a
 * basename hit outranks scattered mid-path hits.
 */
function subsequenceScore(query: string, text: string): number | null {
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < text.length && qi < query.length; ti += 1) {
    if (text[ti] !== query[qi]) continue;
    score += 1;
    if (ti === prevMatch + 1) score += 3;
    const before = ti === 0 ? "/" : text.charAt(ti - 1);
    if (before === "/" || before === "." || before === "-" || before === "_") score += 5;
    prevMatch = ti;
    qi += 1;
  }
  return qi === query.length ? score : null;
}

/**
 * A path's category/shape ranking bonus, independent of the query: artifacts
 * rank first (decision #3), then shallower paths (fewer `/`) rank above deeper
 * ones. The artifact boost dominates so the picker groups artifacts ahead of
 * ordinary repo files, matching Claude Code's force-included behavior.
 */
function shapeBonus(relPath: string): number {
  const depth = relPath.split("/").length - 1;
  const shallow = Math.max(0, 20 - depth * 2);
  return (isArtifactRelPath(relPath) ? 1000 : 0) + shallow;
}

/**
 * Fuzzy-match score for ranking `relPath` against the picker `query`, or `null`
 * when `query` is not a subsequence of the path (filtered out). Higher is
 * better. An empty query matches everything, ranked by shape alone (artifacts
 * and shallow paths first). Combines the subsequence-match quality with the
 * query-independent {@link shapeBonus}.
 */
export function scoreFileMatch(query: string, relPath: string): number | null {
  const q = query.toLowerCase();
  if (q.length === 0) return shapeBonus(relPath);
  const match = subsequenceScore(q, relPath.toLowerCase());
  if (match === null) return null;
  return match + shapeBonus(relPath);
}

// ---- new-artifact name safety (the create flow) -------------------------------

/**
 * Whether `name` is safe to join onto the artifacts directory: non-empty, no
 * path separators (blocks both traversal like `"../x"` and absolute inputs like
 * `"/etc/passwd"` in one check, since either requires a separator), and not the
 * literal `"."`/`".."`. First of two path-safety layers — `volli-fs.ts`
 * additionally verifies via `realpath` that the resolved file stays inside the
 * resolved root.
 */
export function isSafeArtifactEntryName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name === "." || name === "..") return false;
  return true;
}

/**
 * Whether `rawName` is a valid *base* name for a brand-new artifact (before
 * {@link withMarkdownExtension} forces the `.md` suffix): trims to non-empty,
 * passes the separator/`..` safety check, and additionally rejects a
 * leading-dot name (a dotfile artifact would be created but then hidden by the
 * gitignore-respecting file index, so it would vanish from the picker the
 * moment it appeared).
 */
export function isValidNewArtifactName(rawName: string): boolean {
  const trimmed = rawName.trim();
  if (trimmed.startsWith(".")) return false;
  return isSafeArtifactEntryName(trimmed);
}

/** Forces a trimmed name to end in `.md` (a case-insensitively already-`.md` name passes through unchanged). */
export function withMarkdownExtension(name: string): string {
  const trimmed = name.trim();
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

/** The name with its extension stripped — used to seed a new artifact's `# Heading` template. */
export function artifactBaseName(name: string): string {
  const ext = extensionOf(name);
  return ext === null ? name : name.slice(0, name.length - ext.length - 1);
}

// ---- relative-path safety (read/write/reveal) ---------------------------------

/**
 * Whether `relPath` is a safe project-relative path: non-empty, not absolute,
 * no backslash or NUL, and no `.`/`..`/empty segment. The pure first layer of
 * the two-layer path safety (decision: normalized relPath, reject `..`/absolute)
 * — `volli-fs.ts` adds the realpath-containment check inside the resolved root.
 */
export function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0) return false;
  if (relPath.startsWith("/")) return false;
  if (relPath.includes("\\") || relPath.includes("\0")) return false;
  for (const segment of relPath.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}
