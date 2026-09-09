/**
 * The preview's own pass over the SANITIZED tree: the last thing between a file
 * and the document (VC-307).
 *
 * It runs after `rehype-sanitize` and before the hardening step Streamdown
 * ships, and every part of that placement is load-bearing:
 *
 *  - After sanitization, so the `volli-preview:` image sources it mints cannot
 *    be forged. The schema admits no such scheme on `src`, so any that a FILE
 *    contained was deleted before this pass ran; every one that survives to the
 *    image component was minted here, from a path
 *    {@link previewImageSource} resolved.
 *  - Before Streamdown's hardening, which replaces an image whose source it
 *    does not recognise with a fixed "[Image blocked]" stand-in — and a bare
 *    repository path (`apps/docs/shot.png`) is exactly such a source. Left to
 *    it, this repository's own README would preview with its icon and its
 *    screenshot replaced by someone else's error message.
 *
 * ## Why it re-judges what a sanitizer already cleaned
 *
 * Because the promise "Preview makes no network request" is about the DOM, not
 * about a `fetch` call, and the sanitizer's schema is not written to keep that
 * promise. Review round 1 proved it twice over: a `<picture><source srcset>`
 * written INLINE — which the block gate never sees, by design — survived
 * sanitization and the browser fetched the remote candidate; and widening the
 * schema with `math`/`mtext` put MathML on the page, because every downstream
 * opinion was derived from that same schema.
 *
 * So this pass carries its own allowlists (`markdown-preview-html.ts`) and
 * applies them to EVERY element in the tree, wherever it came from:
 *
 *  - an element that fetches or is foreign goes with its subtree;
 *  - an element nobody knows is unwrapped, so its text still reads;
 *  - every surviving attribute must be on the allowlist for its element, which
 *    is what removes `srcset`, `ping`, `style`, `poster` and whatever the next
 *    HTML revision adds, without this module having to hear about it;
 *  - a link's URL must be one a person may follow, and an image's source is
 *    always the resolver's answer, never the author's string.
 */
import {
  allowsPreviewAttribute,
  PREVIEW_DROPPED_TAGS,
  PREVIEW_TAGS,
  safeLinkUrl,
} from "./markdown-preview-html";
import { previewImageSource, previewImageSrc } from "./markdown-preview-image";

/** As much of a hast node as this pass reads. `unist`'s own types are not a dependency here. */
export interface PreviewHastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: PreviewHastNode[];
}

/**
 * A rehype plugin that hardens the tree and resolves every image source against
 * the markdown file at `markdownRelPath`.
 */
export function previewHardeningPlugin(markdownRelPath: string) {
  return () => (tree: PreviewHastNode) => {
    tree.children = hardenedChildren(tree.children ?? [], markdownRelPath);
  };
}

/** One level of the tree, hardened: dropped, unwrapped and kept children, in order. */
function hardenedChildren(
  children: readonly PreviewHastNode[],
  markdownRelPath: string,
): PreviewHastNode[] {
  const kept: PreviewHastNode[] = [];
  for (const child of children) {
    if (child.type !== "element") {
      kept.push(child); // text and comments carry no request
      continue;
    }
    const tag = String(child.tagName ?? "").toLowerCase();
    if (PREVIEW_DROPPED_TAGS.has(tag)) continue;
    const inner = hardenedChildren(child.children ?? [], markdownRelPath);
    if (!PREVIEW_TAGS.has(tag)) {
      // Unwrapped rather than dropped: an element this preview has no rule for
      // is usually a wrapper, and the words inside it are the file's content.
      kept.push(...inner);
      continue;
    }
    child.children = inner;
    child.properties = hardenProperties(tag, child.properties ?? {}, markdownRelPath);
    kept.push(child);
  }
  return kept;
}

function hardenProperties(
  tag: string,
  properties: Record<string, unknown>,
  markdownRelPath: string,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (name === "src") continue; // an image's source is decided below, never kept
    if (!allowsPreviewAttribute(tag, name)) continue;
    if (name === "href" && !(typeof value === "string" && safeLinkUrl(value))) continue;
    kept[name] = value;
  }
  if (tag === "img") {
    const src = properties["src"];
    // A source the sanitizer deleted (`file:`, an unknown scheme) arrives as no
    // source at all, and the resolver reads the empty string as unresolved — so
    // the picture becomes a sentence rather than a broken-image glyph.
    kept["src"] = previewImageSrc(
      previewImageSource({ markdownRelPath, src: typeof src === "string" ? src : "" }),
    );
  }
  return kept;
}
