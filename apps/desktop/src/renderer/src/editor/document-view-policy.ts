/**
 * Which repository Markdown files may wear Document Mode, and what a file that
 * may not is told (plan §4.6, VC-192).
 *
 * Document Mode is not a projection to another format and back: the Monaco
 * model holds the file's own bytes, and the live preview is decoration over
 * them — hidden delimiters, styled spans, a few widgets. Both views of a file
 * share ONE registry document, so switching Source ⇄ Document cannot change a
 * byte. What CAN stop matching the file is the picture: a construct the
 * projection has no rule for is drawn as something it is not, and a construct
 * it misreads has its real content collapsed under a decoration.
 *
 * So the rule this module enforces is the honest form of "round-trips
 * byte-identical": the surface may only open on a file whose every concealment
 * is markdown syntax the projection itself understands. Two constructs in
 * repo-typical Markdown fail that, and both refuse the whole file:
 *
 *  - **YAML frontmatter.** The parser has no frontmatter rule (see
 *    `MARKDOWN_PARSER`), so `---\ntitle: x\ntags: [a, b]\n---` parses as a
 *    thematic break, then a Setext H2. Document Mode then replaces the opening
 *    `---` with a rendered rule, hides the closing `---` as a heading mark, and
 *    hides the `[`/`]` of the YAML list as link marks. The metadata is on
 *    screen as a HEADING with pieces of itself missing — edit the "heading" and
 *    you have rewritten the file's front matter without being shown it.
 *  - **Raw HTML blocks.** An HTML block suspends markdown parsing for the lines
 *    it owns (this repo's own README opens with five of them), so what Document
 *    Mode shows there is not a rendering at all — it is markup sitting raw in a
 *    prose surface whose whole promise is that what you see is what the file
 *    says.
 *
 * INLINE HTML deliberately does NOT refuse. `<editor>` inside a sentence — the
 * shape this repo's own plans use, four times across two files — is one token
 * in a paragraph the projection renders faithfully; it conceals nothing and
 * stays visible as its own bytes, and refusing a 400-line plan over one
 * angle-bracketed word would take Document view away from the corpus it was
 * built for. Same reasoning for HTML comments (`CommentBlock`): not structure,
 * never hidden. The corpus test beside this file is what keeps those judgements
 * honest — it verifies every markdown file in `docs/` and the repo root, and
 * asserts that in every file Document Mode agrees to open, every span the
 * projection hides or replaces can be brought back by putting the caret in it.
 *
 * The gate reads the bytes on DISK (the last load or save), not the live draft:
 * a Document view that ejected you mid-sentence because you typed a `<` would
 * be a worse lie than the one it prevents. Typing frontmatter and saving it is
 * how a file leaves Document view, and it then says why.
 */
import { classifyFileKind } from "@volli/shared";

import { MARKDOWN_PARSER } from "./markdown-projection";
import { buildLineIndex, lineAt } from "./text-position";

/** Which of a markdown file tab's two views is in front (VC-192). */
export type MarkdownFileView = "source" | "document";

/**
 * Source, and that is a decision rather than an oversight: a file tab is a view
 * into a code checkout, where diffs are the lingua franca and the raw bytes are
 * what a person came to read. Document view is a per-file choice on top.
 */
export const DEFAULT_MARKDOWN_FILE_VIEW: MarkdownFileView = "source";

/** Why Document view is not on offer for one file. */
export type DocumentViewRefusalReason = "frontmatter" | "raw-html";

export interface DocumentViewRefusal {
  reason: DocumentViewRefusalReason;
  /** 1-based line of the construct that refused — the file's own coordinate. */
  line: number;
  /** One line, shown beside the (disabled) toggle. Names the construct, its line, and why. */
  message: string;
}

/**
 * Whether this file tab offers the Source ⇄ Document choice at all.
 *
 * Markdown Artifacts are not asked about here and cannot be: they take the
 * autosave path in `FileView` and are always a document (CONCEPT #49/#60).
 * `editable` is false for a read-only view — a read capped at 1 MiB holds a
 * prefix, and a live preview of a prefix would render a truncated fence as a
 * block that swallows the rest of the file.
 */
export function offersMarkdownViewToggle(input: { relPath: string; editable: boolean }): boolean {
  return input.editable && classifyFileKind(input.relPath) === "markdown";
}

/**
 * Whether the file's own bytes can be shown as a document, or the reason they
 * cannot. `null` means Document view is safe to offer.
 */
export function documentViewRefusal(text: string): DocumentViewRefusal | null {
  return frontmatterRefusal(text) ?? rawHtmlRefusal(text);
}

/**
 * The view a markdown tab actually renders: the remembered choice, unless the
 * file refuses Document view — a stored preference can never outvote the bytes,
 * because the file may have grown frontmatter since the choice was made.
 */
export function resolveMarkdownFileView(input: {
  preferred: MarkdownFileView;
  refusal: DocumentViewRefusal | null;
}): MarkdownFileView {
  return input.refusal === null ? input.preferred : "source";
}

/**
 * A leading `---` line with a `---`/`...` line somewhere after it — the
 * frontmatter convention every generator that writes it uses.
 *
 * The search runs to the end of the file rather than stopping at the first
 * blank line, because the two mistakes are not the same size: a file whose
 * opening thematic break happens to be followed by another one loses Document
 * view (Source is the default and shows it perfectly), while frontmatter read
 * as prose puts the misparse above on screen.
 */
function frontmatterRefusal(text: string): DocumentViewRefusal | null {
  if (!FRONTMATTER_OPEN.test(text) || !FRONTMATTER_CLOSE.test(text)) return null;
  return {
    reason: "frontmatter",
    line: 1,
    message: "Document view can't show this file: YAML frontmatter (line 1) renders as a heading.",
  };
}

/** The opening fence: `---` alone on the file's FIRST line (`\r` is a terminator, not content). */
const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/;
/** Its close, on a line of its own somewhere after: YAML ends a document with `---` or `...`. */
const FRONTMATTER_CLOSE = /\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * The first HTML BLOCK in the file, if any. Block-level only: `HTMLTag`
 * (inline) and `CommentBlock` are separate node names and stay allowed, per the
 * module header. Fenced code containing `<div>` is `CodeText` to this parser,
 * so a shell snippet in a doc is never mistaken for markup — which is the whole
 * reason the gate asks the projection's parser instead of a regular expression.
 */
function rawHtmlRefusal(text: string): DocumentViewRefusal | null {
  // An array rather than a `let`: the assignment happens inside a callback, and
  // TypeScript would narrow a captured `let` to its initializer afterwards.
  const blocks: number[] = [];
  MARKDOWN_PARSER.parse(text).iterate({
    enter: (node) => {
      if (blocks.length > 0) return false; // the first one already answers
      if (node.name !== "HTMLBlock") return true;
      blocks.push(node.from);
      return false;
    },
  });
  if (blocks.length === 0) return null;
  const line = lineAt(buildLineIndex(text), blocks[0]).number;
  return {
    reason: "raw-html",
    line,
    message: `Document view can't show this file: raw HTML (line ${line}) has no rendering here.`,
  };
}
