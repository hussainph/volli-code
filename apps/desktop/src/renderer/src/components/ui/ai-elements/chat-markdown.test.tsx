import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { blobUrl } from "@volli/shared";

import { MessageResponse } from "./message";
import { ReasoningBody } from "./reasoning";

/*
 * Through `MessageResponse`, not a bare `Streamdown`, because the two do not
 * render the same markdown the same way: the sanitizer's `src` allowlist is
 * configured there, and a test that mounted Streamdown directly would pass
 * while every real transcript still blocked the image.
 */
function render(source: string): string {
  return renderToStaticMarkup(<MessageResponse>{source}</MessageResponse>);
}

describe("chat markdown overrides", () => {
  /*
   * `node` is the hast node react-markdown hands every component. Only the `ul`
   * override destructured it, so every other element spread it onto the DOM and
   * rendered `node="[object Object]"` — invalid markup, and a React warning per
   * element (VC-273).
   */
  it("never leaks the hast node onto the DOM", () => {
    const sources = [
      "- [ ] todo\n- [x] done\n",
      "*emphasis* and `3.14`",
      "a `src/file.ts` mention",
      "- one\n- two",
    ];
    for (const source of sources) {
      expect(render(source)).not.toContain("[object Object]");
      expect(render(source)).not.toContain("node=");
    }
  });

  it("draws a task list as checkboxes with no bullet", () => {
    const html = render("- [ ] todo\n- [x] done\n");
    expect(html).toContain("list-none");
    expect(html).toContain('type="checkbox"');
    // The second item is the checked one.
    expect(html.split('type="checkbox"')[2]).toContain("checked");
  });

  it("keeps an ordinary bullet list discs-and-indent", () => {
    const html = render("- one\n- two");
    expect(html).toContain("list-disc");
    expect(html).not.toContain('type="checkbox"');
  });

  it("marks a real path as a file mention and leaves a number alone", () => {
    const html = render("`src/a.ts` and `3.14`");
    // The mention carries the dotted-underline treatment; the number does not.
    expect(html).toContain("decoration-dotted");
    expect(html).toContain("<code>3.14</code>");
  });

  it("renders an attachment image over volli-blob rather than blocking it", () => {
    const hash = "a".repeat(64);
    expect(render(`![shot](${blobUrl(hash)})`)).toContain(`src="${blobUrl(hash)}"`);
  });

  it("renders an inline data image", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(render(`![dot](${src})`)).toContain(`src="${src}"`);
  });

  it("explains an image it will not load instead of drawing a broken one", () => {
    const html = render("![shipped pane](/Users/me/shipped.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("Image unavailable");
  });

  /*
   * The reasoning body is the app's OTHER Streamdown, and it took
   * `chatMarkdownComponents` without the rehype chain they depend on — so the
   * same picture drew in the answer and reported `[Image blocked]` one block
   * above it. The two exports now live in one module for this reason; this is
   * the test that notices if a third surface takes only half of it again.
   */
  it("renders an attachment image inside a reasoning body too", () => {
    const hash = "a".repeat(64);
    const html = renderToStaticMarkup(<ReasoningBody>{`![shot](${blobUrl(hash)})`}</ReasoningBody>);
    expect(html).toContain(`src="${blobUrl(hash)}"`);
    expect(html).not.toContain("Image blocked");
  });

  it("still declines a remote image after the sanitizer was widened", () => {
    // Widening `protocols.src` must not have re-opened the network: `https` was
    // always allowed through sanitization, and the refusal is ours.
    const html = render("![tracker](https://example.com/pixel.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("Remote image not loaded");
  });
});
