/**
 * Which pictures a read-only Markdown Preview may draw, and how a repository
 * one reaches the page (VC-307).
 *
 * The chat renderer has its own answer to this question and it is the right one
 * THERE: `resolveMarkdownImageSrc` (@volli/shared) resolves Blob attachments
 * and refuses ordinary repository paths, because a transcript is not a
 * checkout and a model writing `docs/shot.png` is naming a file the chat has no
 * business reading. A file preview is the opposite case: `docs/shot.png` beside
 * the markdown file is exactly the picture the author meant, and refusing it
 * would leave this repository's own README with two broken images. So Preview
 * gets its own resolver — this module — and keeps the shared WORDING for a
 * refusal, so the same situation reads the same everywhere.
 *
 * What it will not do is fetch. A remote badge is refused rather than requested
 * (opening a file must not tell a server the file was opened), `file:` URLs are
 * refused outright, and a repository path is only ever a REQUEST to main's
 * worktree-aware, path-safe reader — never a URL the page loads for itself. The
 * only thing that reaches an `<img>` is a `data:` URL main's answer produced.
 *
 * The `volli-preview:` scheme below is how a resolved path survives the
 * renderer. Streamdown sanitizes before this module's rehype pass runs and
 * admits no such scheme on `src`, so an author cannot write one: every
 * `volli-preview:` URL on the page was minted by the pass, from a path this
 * module resolved. That is the property that lets the image component trust
 * what it is handed.
 *
 * Pure: no reads, no DOM, no `window`. The component beside it does the asking.
 */
import { classifyMarkdownUrl, dirNameOf, imageMimeType, markdownImageNotice } from "@volli/shared";

import type { FileContent } from "../../../ipc/contract";

/** How one markdown image source is to be drawn — or why it will not be. */
export type PreviewImageSource =
  /** A file in this checkout, to be read through main's safe reader. */
  | { kind: "repo-file"; relPath: string }
  /** Inert, self-contained bytes the page can carry as-is. */
  | { kind: "inline"; src: string }
  /** Somewhere on the network. Named, never fetched. */
  | { kind: "remote" }
  /** Well-formed but naming nothing this preview may read. */
  | { kind: "unresolved" };

/** The scheme a resolved repository image wears between the rehype pass and the image component. */
export const PREVIEW_IMAGE_SCHEME = "volli-preview:";

const FILE_SRC_PREFIX = `${PREVIEW_IMAGE_SCHEME}file/`;
const REMOTE_SRC = `${PREVIEW_IMAGE_SCHEME}remote`;
const UNRESOLVED_SRC = `${PREVIEW_IMAGE_SCHEME}unresolved`;

const UNRESOLVED: PreviewImageSource = { kind: "unresolved" };
const REMOTE: PreviewImageSource = { kind: "remote" };

/**
 * How to draw one `![alt](src)` (or `<img src>`) written in the markdown file
 * at `markdownRelPath`.
 *
 * A repository path resolves against the markdown file's OWN directory, which
 * is what a relative path in a document means, and the result is normalized so
 * a `..` cannot climb out of the checkout. That check is this module's own, not
 * a substitute for main's: `resolveSafePath` refuses an escape again, from the
 * side that knows where the checkout actually is. Both exist because they
 * answer different questions — this one decides what to ASK for, and asking for
 * a path outside the repository is a request that should never be made.
 */
export function previewImageSource(input: {
  markdownRelPath: string;
  src: string;
}): PreviewImageSource {
  const trimmed = input.src.trim();
  if (trimmed === "") return UNRESOLVED;
  // The app's ONE reading of what a markdown URL names (@volli/shared), so this
  // surface and the chat transcript cannot disagree about the same string.
  switch (classifyMarkdownUrl(trimmed)) {
    case "data-image":
      return { kind: "inline", src: trimmed };
    case "remote":
      return REMOTE;
    // Every other scheme — `file:`, `javascript:`, `volli-blob:`, and the
    // preview's own — names something this surface must not or cannot read.
    case "scheme":
      return UNRESOLVED;
    case "path":
      break;
  }
  // An absolute path is a claim about the disk, not about the checkout.
  if (trimmed.startsWith("/")) return UNRESOLVED;

  const written = decodePath(withoutSuffix(trimmed));
  if (written === null) return UNRESOLVED;
  const relPath = resolveAgainst(dirNameOf(input.markdownRelPath), written);
  if (relPath === null) return UNRESOLVED;
  // A path that names no image format is not a picture, whatever it holds.
  if (imageMimeType(relPath) === null) return UNRESOLVED;
  return { kind: "repo-file", relPath };
}

/** The `src` the rehype pass puts on an `<img>` for `source`. */
export function previewImageSrc(source: PreviewImageSource): string {
  switch (source.kind) {
    case "repo-file":
      return `${FILE_SRC_PREFIX}${encodeURIComponent(source.relPath)}`;
    case "inline":
      return source.src;
    case "remote":
      return REMOTE_SRC;
    case "unresolved":
      return UNRESOLVED_SRC;
  }
}

/**
 * What the image component was handed. Anything it does not recognise reads as
 * `unresolved` — a picture is drawn only for a source this module minted or for
 * inert bytes, never for a string that merely got this far.
 */
export function parsePreviewImageSrc(src: string | undefined): PreviewImageSource {
  if (src === undefined) return UNRESOLVED;
  if (src === REMOTE_SRC) return REMOTE;
  if (src.startsWith(FILE_SRC_PREFIX)) {
    const relPath = decodePath(src.slice(FILE_SRC_PREFIX.length));
    return relPath === null ? UNRESOLVED : { kind: "repo-file", relPath };
  }
  const named = classifyMarkdownUrl(src);
  if (named === "data-image") return { kind: "inline", src };
  if (named === "remote") return REMOTE;
  return UNRESOLVED;
}

/**
 * What a refused image says in place of the picture — the app's one wording for
 * it, so a chat transcript and a file preview report the same situation with
 * the same sentence.
 */
export function previewImageNotice(kind: "remote" | "unresolved"): string {
  return markdownImageNotice({ kind });
}

/** A read repository image, as an `<img>` source or as the sentence drawn instead. */
export type PreviewImageDisplay = { kind: "src"; src: string } | { kind: "notice"; notice: string };

/**
 * What main's answer for a repository image can actually be displayed as.
 *
 * Two shapes arrive, because the workbench classifies SVG as TEXT on purpose
 * (`IMAGE_EXTENSIONS` in @volli/shared): a raster file comes back as the `data:`
 * URL main built, and an SVG comes back as the editable source of a file whose
 * own tab is a text editor. Preview builds the picture for the second case
 * itself, which is why an `.svg` still opens as an editor everywhere else —
 * this module changes what a PREVIEW does with the bytes, not what the file is.
 *
 * A truncated read is refused rather than drawn: half an SVG is not a smaller
 * picture, it is a broken one.
 */
export function previewImageDisplay(input: {
  relPath: string;
  content: FileContent;
}): PreviewImageDisplay {
  if (input.content.type === "image") return { kind: "src", src: input.content.dataUrl };
  // `binary` is main's answer for an image past its inline cap (or bytes it
  // will not serve as text) — either way there is nothing here to draw.
  if (input.content.type === "binary") return { kind: "notice", notice: TOO_LARGE };
  if (imageMimeType(input.relPath) !== "image/svg+xml") {
    return { kind: "notice", notice: previewImageNotice("unresolved") };
  }
  if (input.content.truncated) return { kind: "notice", notice: TOO_LARGE };
  return { kind: "src", src: svgTextDataUrl(input.content.text) };
}

/** The notice for bytes that exist but are past a cap this surface will not draw through. */
const TOO_LARGE = "Image too large to preview";

/**
 * An SVG file's text as a `data:` URL.
 *
 * Percent-encoded rather than base64 for one reason that matters and one that
 * does not: `encodeURIComponent` cannot be ended early by a byte of the file
 * (`#`, `"`, a newline), and it keeps the URL readable in a devtools panel.
 *
 * Displayed only through `<img src>`, which is what makes an arbitrary SVG safe
 * to show: an image-context SVG runs no script, loads no external resource, and
 * has no access to the page around it. Preview never inlines SVG markup into
 * the document, and this is the reason.
 */
export function svgTextDataUrl(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}

/** Strips a `?query` / `#fragment` a markdown author may have appended. */
function withoutSuffix(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/**
 * The path a markdown author wrote, percent-decoding included — `docs/my%20shot.png`
 * is how a space survives a markdown link. Decoded BEFORE the `..` normalization
 * below, so an encoded traversal is normalized rather than smuggled, and refused
 * outright when it is not decodable or carries a NUL.
 */
function decodePath(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return decoded.includes("\0") ? null : decoded;
}

/**
 * `path` resolved against the directory `base`, as a normalized project-relative
 * path — or `null` when it names nothing inside the checkout.
 */
function resolveAgainst(base: string, path: string): string | null {
  const segments: string[] = [];
  for (const segment of `${base}/${path}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      segments.push(segment);
      continue;
    }
    // Climbing past the checkout root is an escape, not a path.
    if (segments.length === 0) return null;
    segments.pop();
  }
  return segments.length === 0 ? null : segments.join("/");
}
