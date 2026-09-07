/**
 * The one rewriting pass the read-only Markdown Preview adds to the chat
 * renderer's sanitization chain (VC-307).
 *
 * It runs AFTER `rehype-sanitize` and before the hardening step, and both
 * halves of that placement are load-bearing:
 *
 *  - After sanitization, so the `volli-preview:` sources it mints cannot be
 *    forged. The schema admits no such scheme on `src`, so any that a FILE
 *    contained was deleted before this pass ran; every one that survives to the
 *    image component was minted here, from a path
 *    {@link previewImageSource} resolved.
 *  - Before hardening, because hardening replaces an image whose source it does
 *    not recognise with a fixed "[Image blocked]" stand-in — and a bare
 *    repository path (`apps/docs/shot.png`) is exactly such a source. Left to
 *    it, this repository's own README would preview with its icon and its
 *    screenshot replaced by someone else's error message, and the preview's own
 *    resolver would never get to answer.
 *
 * Every `<img>` is rewritten, including the ones inside raw HTML blocks, so a
 * README that writes its images as markup and one that writes them as markdown
 * resolve through the same policy. What the pass never does is FETCH: it
 * classifies a source and stamps the verdict on the node; reading the bytes is
 * the image component's job, through main's safe reader.
 */
import { previewImageSource, previewImageSrc } from "./markdown-preview-image";

/** As much of a hast node as this pass reads. `unist`'s own types are not a dependency here. */
interface HastNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * A rehype plugin that resolves every image source in the markdown file at
 * `markdownRelPath` into a verdict the preview's image component can trust.
 */
export function previewImageRehypePlugin(markdownRelPath: string) {
  return () => (tree: HastNode) => {
    rewriteImages(tree, markdownRelPath);
  };
}

function rewriteImages(node: HastNode, markdownRelPath: string): void {
  if (node.type === "element" && node.tagName === "img" && node.properties !== undefined) {
    const src = node.properties["src"];
    // A source the sanitizer deleted (`file:`, an unknown scheme) arrives as no
    // source at all, and `previewImageSource` reads the empty string as
    // unresolved — so the picture is replaced by a sentence rather than by the
    // browser's broken-image glyph.
    node.properties["src"] = previewImageSrc(
      previewImageSource({ markdownRelPath, src: typeof src === "string" ? src : "" }),
    );
  }
  for (const child of node.children ?? []) rewriteImages(child, markdownRelPath);
}
