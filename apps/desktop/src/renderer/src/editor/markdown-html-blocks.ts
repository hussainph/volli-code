/**
 * Where a markdown file's raw HTML BLOCKS are, asked once (VC-192, VC-307).
 *
 * Two surfaces need the same answer and must never disagree about it: the
 * Document view gate refuses a file over its first block, and the read-only
 * Preview marks each block it will not draw. If those two walked the tree
 * separately, a file could be refused for a construct the fallback then failed
 * to acknowledge, or the reverse.
 *
 * The projection's own parser answers, which is the whole reason neither
 * surface uses a regular expression: markup inside a fenced code block is
 * `CodeText` to it, and inline `<editor>` is `HTMLTag`, so neither is mistaken
 * for structure.
 */
import { MARKDOWN_PARSER } from "./markdown-projection";

/** One raw HTML block's half-open `[from, to)` span in the file's own offsets. */
export interface HtmlBlockRange {
  from: number;
  to: number;
}

/** Every top-level raw HTML block in `text`, in document order. */
export function htmlBlockRanges(text: string): HtmlBlockRange[] {
  const blocks: HtmlBlockRange[] = [];
  MARKDOWN_PARSER.parse(text).iterate({
    enter: (node) => {
      if (node.name !== "HTMLBlock") return true;
      blocks.push({ from: node.from, to: node.to });
      return false; // its children are the same markup, already accounted for
    },
  });
  return blocks;
}
