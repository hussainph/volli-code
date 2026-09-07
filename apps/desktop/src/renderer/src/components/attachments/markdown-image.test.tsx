import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { blobUrl, SESSION_ATTACHMENTS_REL_DIR, type NamedBlobLink } from "@volli/shared";

import { MarkdownAttachmentsProvider, MarkdownImage } from "./markdown-image";

const HASH = "b".repeat(64);

function link(originalName: string): NamedBlobLink {
  return { linkId: `l-${originalName}`, blobHash: HASH, label: originalName, originalName };
}

function render(
  src: string | undefined,
  alt: string,
  attachments: readonly NamedBlobLink[] = [],
): string {
  return renderToStaticMarkup(
    <MarkdownAttachmentsProvider attachments={attachments}>
      <MarkdownImage src={src} alt={alt} />
    </MarkdownAttachmentsProvider>,
  );
}

describe("MarkdownImage (VC-273)", () => {
  it("renders a canonical volli-blob source", () => {
    const html = render(blobUrl(HASH), "shipped pane");
    expect(html).toContain(`src="${blobUrl(HASH)}"`);
    expect(html).toContain('alt="shipped pane"');
  });

  it("resolves the materialized path an agent is handed in the brief", () => {
    const html = render(`${SESSION_ATTACHMENTS_REL_DIR}/spec.png`, "spec", [link("spec.png")]);
    expect(html).toContain(`src="${blobUrl(HASH)}"`);
  });

  it("draws a notice, not a broken img, for the ticket's original failure", () => {
    // `![shipped pane](/Users/…/shipped.png)` — admitted by the OLD allowlist,
    // unloadable on this origin, and the broken glyph in the screenshot.
    const html = render("/Users/me/shipped.png", "shipped pane");
    expect(html).not.toContain("<img");
    expect(html).toContain("Image unavailable");
    expect(html).toContain("shipped pane");
  });

  it("keeps declining remote images, and says which problem it is", () => {
    const html = render("https://example.com/pixel.png", "tracker");
    expect(html).not.toContain("<img");
    expect(html).toContain("Remote image not loaded");
  });

  it("no longer admits a source that could never load", () => {
    // `file:` and `./rel` were both on the old allowlist. Neither can load
    // under the renderer's `img-src 'self' data: volli-blob:` policy.
    for (const src of ["file:///Users/me/a.png", "./a.png", "../a.png"]) {
      expect(render(src, "x")).not.toContain("<img");
    }
  });

  it("handles a missing source without throwing", () => {
    expect(render(undefined, "")).toContain("Image unavailable");
  });

  it("renders nothing but the notice when there is no alt text", () => {
    const html = render("https://example.com/a.png", "");
    expect(html).toContain("Remote image not loaded");
    expect(html).not.toContain("—");
  });

  it("resolves nothing outside a provider", () => {
    const html = renderToStaticMarkup(<MarkdownImage src="spec.png" alt="spec" />);
    expect(html).toContain("Image unavailable");
  });
});
