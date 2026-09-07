/**
 * What the read-only Markdown Preview is allowed to render, decided on the
 * file's own bytes before a renderer ever sees them (VC-307).
 *
 * Preview exists for the files `document-view-policy.ts` refuses — this repo's
 * README among them — and its promise is the opposite of Document Mode's. It
 * never writes, so it may draw constructs the editable projection must turn
 * down; but it renders RAW HTML that a person did not necessarily write and an
 * agent may have, so every byte on the way in is judged twice:
 *
 *  1. **Here**, per HTML block, before rendering: a block whose markup is not
 *     plainly supported and inert is replaced by a visible
 *     `HTML block not rendered` marker.
 *  2. **The renderer's sanitizer** (`chatRehypePlugins`), which parses and
 *     cleans everything that survives step 1.
 *
 * Two layers because they fail differently. The sanitizer is thorough and
 * SILENT: it deletes an `<iframe>` and renders the rest, so a reader is left
 * with a page that quietly lost something and no way to know. This module is
 * coarse and LOUD: it refuses a whole block and says so, which is the honest
 * answer for a surface whose entire job is to show what a file says. Neither
 * layer is a substitute for the other, and this one is deliberately the
 * stricter: refusing markup the sanitizer would have cleaned costs a marker,
 * while admitting markup it would not have cleaned costs a person their
 * machine.
 *
 * The tag allowlist is DERIVED from the renderer's own sanitization schema
 * rather than written out here, for the reason `chat-markdown.tsx` derives its
 * chain: a hand-copied list drifts, and it drifts in the direction that hurts —
 * a tag we admit but the sanitizer strips is exactly the silent loss the marker
 * exists to prevent. What this module adds on top of that list is a small
 * refusal set of its own (see {@link PREVIEW_DENIED_TAGS}) and the attribute
 * scan below.
 *
 * Pure and byte-preserving: it slices the caller's string and never rewrites
 * it. Preview cannot save, and this module could not help it if it tried.
 */
import { defaultRehypePlugins } from "streamdown";

import { frontmatterSpan } from "./document-view-policy";
import { MARKDOWN_PARSER } from "./markdown-projection";
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

/** The `src`/`href` schemes that execute, plus `data:` in every form but a picture. */
const DANGEROUS_URL = /(?:javascript|vbscript):|data:(?!image\/)/i;

/** An `on…=` handler inside a tag. Attribute regions only — see {@link renderableHtmlBlock}. */
const EVENT_HANDLER_ATTRIBUTE = /\son[a-z]{2,}\s*=/i;

/** A responsive-source attribute, which would fetch on render. Refused wherever it appears. */
const SRCSET_ATTRIBUTE = /\ssrcset\s*=/i;

/** A comment, which the sanitizer deletes — stripped before the scan so its content is not markup. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** `<!doctype`, `<![CDATA[`, `<?…?>`: not elements, and nothing a document preview needs. */
const NON_ELEMENT_MARKUP = /<[!?]/;

/** Every tag opening in a block, with whatever attribute text follows it. */
const TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)/g;

/** The `tagNames` of the renderer's sanitization schema, as much of it as this module reads. */
interface SanitizeSchemaLike {
  tagNames?: readonly string[];
}

/*
 * Streamdown ships `sanitize` as a `[plugin, schema]` pair; the schema's
 * `tagNames` is the exact set its renderer keeps. Read rather than copied, and
 * read leniently: if a future release changed the shape, `tagNames` reads as
 * `undefined`, the allowlist below is EMPTY, and every raw HTML block draws a
 * marker. That is the safe direction for a wrong answer.
 */
const [, SANITIZE_SCHEMA] = defaultRehypePlugins["sanitize"] as unknown as [
  unknown,
  SanitizeSchemaLike,
];

/** Every element the renderer's sanitizer would keep. */
const SANITIZED_TAGS: ReadonlySet<string> = new Set(SANITIZE_SCHEMA.tagNames);

/**
 * Elements this preview refuses even though the sanitizer would keep them.
 *
 * `picture`/`source` carry `srcset`, which the schema does not protocol-check —
 * a remote candidate would be a network request made by opening a file, and
 * "Preview fetches nothing" is a promise this surface keeps by not emitting the
 * markup rather than by trusting a Content-Security-Policy to catch it. `input`
 * is the sanitizer's task-list checkbox: markdown task lists still draw (they
 * are not raw HTML), and a checkbox typed into a README is chrome a read-only
 * page has no use for.
 */
const PREVIEW_DENIED_TAGS: ReadonlySet<string> = new Set(["picture", "source", "input"]);

/**
 * Whether one raw HTML block may be handed to the renderer at all.
 *
 * Conservative by construction: unknown markup is refused, not repaired. The
 * scan runs over the block with comments removed — the sanitizer deletes
 * comment nodes, so what is inside one cannot reach the page, and reading a
 * commented-out `<script>` as markup would hide the paragraph a person wrote
 * around it.
 *
 * Attribute checks are split on purpose. Event handlers are matched inside TAG
 * regions, because `on…=` shapes occur in ordinary prose (`only = 2`) and a
 * refusal there would be a marker over a paragraph nobody could see the problem
 * with; the sanitizer's own attribute allowlist is what catches a handler
 * smuggled past this scan by a `>` inside a quoted value. The executing URL
 * schemes are matched over the WHOLE block, because they have no innocent form
 * worth protecting inside markup.
 */
export function renderableHtmlBlock(html: string): boolean {
  const markup = html.replace(HTML_COMMENT, "");
  if (NON_ELEMENT_MARKUP.test(markup)) return false;
  if (DANGEROUS_URL.test(markup)) return false;
  if (SRCSET_ATTRIBUTE.test(markup)) return false;
  for (const [, name, attributes] of markup.matchAll(TAG)) {
    const tag = name.toLowerCase();
    if (!SANITIZED_TAGS.has(tag) || PREVIEW_DENIED_TAGS.has(tag)) return false;
    if (EVENT_HANDLER_ATTRIBUTE.test(attributes)) return false;
  }
  return true;
}

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

  for (const block of htmlBlocks(text)) {
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

/**
 * Every top-level raw HTML block in the file, in order.
 *
 * The projection's own parser answers this, exactly as the Document view gate
 * does — so "an HTML block" means the same thing in the refusal and in the
 * fallback the refusal offers. Markup inside a fenced code block is `CodeText`
 * to this parser and inline `<editor>` is `HTMLTag`, so neither is cut out of
 * the prose it belongs to.
 */
function htmlBlocks(text: string): { from: number; to: number }[] {
  const blocks: { from: number; to: number }[] = [];
  MARKDOWN_PARSER.parse(text).iterate({
    enter: (node) => {
      if (node.name !== "HTMLBlock") return true;
      blocks.push({ from: node.from, to: node.to });
      return false; // its children are the same markup, already accounted for
    },
  });
  return blocks;
}
