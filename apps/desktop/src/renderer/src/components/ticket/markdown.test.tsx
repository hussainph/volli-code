import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { blobUrl, SESSION_ATTACHMENTS_REL_DIR, type NamedBlobLink } from "@volli/shared";

import { MarkdownAttachmentsProvider } from "@renderer/components/attachments/markdown-image";
import { ALLOWED_URI_REGEXP, Markdown } from "./markdown";

// The renderer test project runs under Node with no DOM, and dompurify only
// binds `sanitize` when a window exists (see `clamped-markdown.test.tsx` for
// the same mock). The identity here means these tests pin what the MARKED half
// of the pipeline emits; that the sanitizer then KEEPS a `volli-blob:` src is a
// separate claim, pinned by the `ALLOWED_URI_REGEXP` tests at the bottom — that
// regexp is the whole of what we changed about sanitization.
vi.mock("dompurify", () => ({ default: { sanitize: (raw: string) => raw } }));

const HASH = "a".repeat(64);

function link(originalName: string, blobHash = HASH): NamedBlobLink {
  return { linkId: `l-${originalName}`, blobHash, label: originalName, originalName };
}

function render(source: string, attachments: readonly NamedBlobLink[] = []): string {
  return renderToStaticMarkup(
    <MarkdownAttachmentsProvider attachments={attachments}>
      <Markdown source={source} />
    </MarkdownAttachmentsProvider>,
  );
}

describe("Markdown images (VC-273)", () => {
  it("renders a canonical volli-blob source", () => {
    const html = render(`![shipped pane](${blobUrl(HASH)})`);
    expect(html).toContain(`src="${blobUrl(HASH)}"`);
    expect(html).toContain('alt="shipped pane"');
  });

  it("resolves an attachment named by its materialized path", () => {
    // The path an agent is handed in the Ticket brief.
    const html = render(`![spec](${SESSION_ATTACHMENTS_REL_DIR}/spec.png)`, [link("spec.png")]);
    expect(html).toContain(`src="${blobUrl(HASH)}"`);
  });

  it("resolves a bare attachment name", () => {
    const html = render("![spec](spec.png)", [link("spec.png")]);
    expect(html).toContain(`src="${blobUrl(HASH)}"`);
  });

  it("says so, rather than emitting a broken img, when a source names nothing", () => {
    const html = render("![shipped pane](/Users/me/shipped.png)");
    // This is the exact markdown from the ticket's screenshot: an absolute
    // local path, which resolves against the app origin and 404s.
    expect(html).not.toContain("<img");
    expect(html).toContain("Image unavailable");
    expect(html).toContain("shipped pane");
  });

  it("declines a remote image and names that as the reason", () => {
    const html = render("![tracker](https://example.com/pixel.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("Remote image not loaded");
  });

  it("keeps the notice alone when the image had no alt text", () => {
    const html = render("![](https://example.com/pixel.png)");
    expect(html).toContain("Remote image not loaded");
    expect(html).not.toContain("—");
  });

  it("escapes alt text rather than letting it become markup", () => {
    const html = render("![<img src=x onerror=alert(1)>](https://e.com/a.png)");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).toContain("&lt;img");
  });

  it("does not leak one surface's attachments into another", () => {
    // The renderer instance is per-render and closes over THIS surface's links.
    expect(render("![spec](spec.png)", [link("spec.png")])).toContain("<img");
    expect(render("![spec](spec.png)", [])).toContain("Image unavailable");
  });

  it("still renders ordinary markdown", () => {
    const html = render("# Title\n\n- one\n- two\n\nbody `code`");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders GFM task list checkboxes", () => {
    const html = render("- [ ] todo\n- [x] done");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });
});

/**
 * The sanitizer's URI allowlist, which is upstream's with one scheme added.
 *
 * Worth its own tests because a `volli-blob:` src surviving sanitization is the
 * difference between an image on a Ticket and the broken box this ticket
 * started from — DOMPurify's DEFAULT regexp deletes the attribute outright —
 * and because a careless edit to a hand-copied upstream constant could widen it
 * far past the one scheme we meant to add.
 */
describe("ALLOWED_URI_REGEXP", () => {
  it("admits the app's own blob scheme, which the default regexp strips", () => {
    expect(ALLOWED_URI_REGEXP.test(blobUrl(HASH))).toBe(true);
  });

  it.each(["https://example.com/a.png", "mailto:a@b.c", "/relative/path.png", "#anchor"])(
    "still admits what upstream admits: %s",
    (uri: string) => {
      expect(ALLOWED_URI_REGEXP.test(uri)).toBe(true);
    },
  );

  it.each(["javascript:alert(1)", "data:text/html,<script>", "vbscript:msgbox"])(
    "still refuses what upstream refuses: %s",
    (uri: string) => {
      expect(ALLOWED_URI_REGEXP.test(uri)).toBe(false);
    },
  );
});
