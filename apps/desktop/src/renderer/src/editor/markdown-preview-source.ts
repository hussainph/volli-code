/**
 * What the read-only Markdown Preview renders, and where it says it left
 * something out (VC-307).
 *
 * Preview exists for the files `document-view-policy.ts` refuses — this repo's
 * README among them — and its promise is the opposite of Document Mode's. It
 * never writes, so it may draw constructs the editable projection must turn
 * down; but it renders raw HTML that a person did not necessarily write and an
 * agent may have, so this module cuts the file into two kinds of thing before a
 * renderer ever sees it: markdown to render, and the place a raw HTML block was
 * refused.
 *
 * The refusal itself is `markdown-preview-html.ts`'s to make — parsed, not
 * scanned — and the two layers after it (the renderer's sanitizer, then the
 * preview's own hardening pass) are described there. What lives HERE is only
 * the cutting: which spans are metadata, which are blocks, and which line each
 * marker names.
 *
 * Pure and byte-preserving: it slices the caller's string and never rewrites
 * it. Preview cannot save, and this module could not help it if it tried.
 */
import { frontmatterSpan } from "./document-view-policy";
import { htmlBlockRanges } from "./markdown-html-blocks";
import { renderableHtmlBlock } from "./markdown-preview-html";
import { buildLineIndex, lineAt } from "./text-position";

/** The words drawn where a block was left out. One constant, so the surface and its tests agree. */
export const OMITTED_HTML_NOTICE = "HTML block not rendered";

/**
 * One piece of a previewed file, in document order: markdown to render, or the
 * place a raw HTML block was left out.
 *
 * A structural marker rather than a sentence spliced into the markdown, because
 * a sentence would be indistinguishable from a file that happens to contain the
 * same words — the preview would then be reporting its own omissions in a
 * channel any author could forge.
 */
export type PreviewSegment =
  | { kind: "markdown"; text: string }
  /** 1-based line of the refused block, in the FILE's coordinates (frontmatter counted). */
  | { kind: "omitted-html"; line: number };

/**
 * The file, cut into what Preview renders and what it refuses to.
 *
 * Leading YAML frontmatter is dropped from the output and nothing else is: the
 * metadata is not prose, and the editable projection refuses the file over
 * exactly this span (`frontmatterSpan`), so the two surfaces agree about which
 * bytes are metadata. The file itself is untouched — Source still holds every
 * byte, which is where a person edits frontmatter.
 *
 * Offsets and line numbers stay in the FILE's coordinates throughout, so a
 * marker names the line a reader can go and look at in Source.
 */
export function previewSegments(text: string): PreviewSegment[] {
  const bodyFrom = frontmatterSpan(text)?.to ?? 0;
  const lines = buildLineIndex(text);
  const segments: PreviewSegment[] = [];
  let cursor = bodyFrom;

  const takeMarkdown = (to: number): void => {
    const slice = text.slice(cursor, to);
    // A run of blank lines between two refused blocks is not a document.
    if (slice.trim() !== "") segments.push({ kind: "markdown", text: slice });
  };

  for (const block of htmlBlockRanges(text)) {
    // A block inside the hidden frontmatter is hidden with it, marker included:
    // announcing an omission from a region the reader was never shown would be
    // a sentence about nothing.
    if (block.from < bodyFrom) continue;
    if (renderableHtmlBlock(text.slice(block.from, block.to))) continue;
    takeMarkdown(block.from);
    segments.push({ kind: "omitted-html", line: lineAt(lines, block.from).number });
    cursor = block.to;
  }
  takeMarkdown(text.length);
  return segments;
}
