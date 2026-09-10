// @vitest-environment jsdom
/**
 * The read-only Markdown Preview (VC-307): what it draws for the files
 * Document view refuses, and — more importantly — what it refuses to draw.
 *
 * Every input here is treated as hostile, because the files this surface exists
 * for are exactly the ones nobody vetted: a README written by whoever opened a
 * pull request, a plan an agent wrote into the worktree. The assertions are
 * therefore mostly negative — no script ran, no handler survived, no request
 * left the machine — with the positive ones proving the surface is still worth
 * having.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MarkdownPreview } from "./markdown-preview";

const README = `<p align="center">
  <img src="apps/desktop/build/icon-source.svg" width="96" alt="Volli Code icon" />
</p>

<h1 align="center">Volli Code</h1>

<p align="center">
  <a href="https://volli.app/download/">Download</a>
</p>

<p align="center">
  <img src="apps/docs/src/assets/screenshots/board.png" alt="The Home Board tab." width="1200" />
</p>

## Install

Download the current build from [volli.app](https://volli.app/download/).
`;

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';

let root: Root | null = null;
let container: HTMLElement | null = null;
let read: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;
let fetched: ReturnType<typeof vi.fn>;

/** Main's answer for the two shapes a repository image arrives in. */
function readsRepositoryFiles() {
  return vi.fn(async ({ relPath }: { relPath: string }) => {
    if (relPath.endsWith(".svg")) {
      return {
        ok: true as const,
        source: "main" as const,
        kind: "other" as const,
        size: SVG_TEXT.length,
        mtime: 1,
        content: { type: "text" as const, text: SVG_TEXT, truncated: false },
      };
    }
    return {
      ok: true as const,
      source: "main" as const,
      kind: "image" as const,
      size: 12,
      mtime: 1,
      content: { type: "image" as const, dataUrl: PNG_DATA_URL },
    };
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  read = readsRepositoryFiles();
  write = vi.fn();
  fetched = vi.fn();
  vi.stubGlobal("fetch", fetched);
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { files: { read, write } },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

async function preview(
  text: string,
  options: { relPath?: string; ticketId?: string } = {},
): Promise<HTMLElement> {
  await act(async () => {
    root?.render(
      <MarkdownPreview
        projectId="project-1"
        ticketId={options.ticketId}
        relPath={options.relPath ?? "README.md"}
        text={text}
      />,
    );
  });
  if (container === null) throw new Error("missing test container");
  return container;
}

describe("MarkdownPreview — the README the ticket started from", () => {
  it("draws its centred HTML wrappers, heading, link and prose", async () => {
    const view = await preview(README);

    expect(view.querySelector("p[align='center']")).not.toBeNull();
    expect(view.textContent).toContain("Volli Code");
    expect(view.textContent).toContain("Download the current build");
    expect(view.textContent).toContain("Install");
    expect(view.textContent).not.toContain("HTML block not rendered");
  });

  it("resolves its local SVG icon and PNG screenshot through main's safe reader", async () => {
    const view = await preview(README);

    expect(read.mock.calls.map((call) => call[0])).toEqual([
      {
        projectId: "project-1",
        ticketId: undefined,
        relPath: "apps/desktop/build/icon-source.svg",
      },
      {
        projectId: "project-1",
        ticketId: undefined,
        relPath: "apps/docs/src/assets/screenshots/board.png",
      },
    ]);
    const sources = [...view.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(sources).toEqual([
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG_TEXT)}`,
      PNG_DATA_URL,
    ]);
    // Only ever a data: URL on the page — never a file: URL, never a path.
    expect(view.innerHTML).not.toContain("file:");
  });

  it("reads a ticket's own worktree copy when it is opened from one", async () => {
    await preview("![shot](docs/board.png)", { relPath: "docs/guide.md", ticketId: "VC-307" });

    expect(read).toHaveBeenCalledWith({
      projectId: "project-1",
      ticketId: "VC-307",
      relPath: "docs/board.png",
    });
  });

  it("asks the network for nothing at all", async () => {
    await preview(README);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("never writes the file it is previewing", async () => {
    await preview(README);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("MarkdownPreview — markdown a document view cannot show", () => {
  it("keeps a <details>/<summary> disclosure readable", async () => {
    const view = await preview(
      "<details>\n<summary>More</summary>\n\nHidden body.\n\n</details>\n",
    );

    expect(view.querySelector("details")).not.toBeNull();
    expect(view.querySelector("summary")?.textContent).toBe("More");
    expect(view.textContent).toContain("Hidden body.");
  });

  it("leaves leading YAML frontmatter off the page without touching the file", async () => {
    const text = "---\ntitle: Notes\nsecret: value\n---\n\n# Real\n\nBody.\n";
    const view = await preview(text);

    expect(view.textContent).not.toContain("secret: value");
    expect(view.querySelector("h1")?.textContent).toBe("Real");
    expect(write).not.toHaveBeenCalled();
  });

  it("still renders what markdown itself is made of, after the hardening pass", async () => {
    // The pass strips by allowlist, so the risk it carries is the opposite of
    // the one it removes: a table, a task list or a footnote quietly losing the
    // chrome that makes it readable.
    const view = await preview(
      "| Column | Meaning |\n| --- | --- |\n| Todo | queued |\n\n- [x] done\n- [ ] next\n\nA sentence.[^1]\n\n[^1]: The note.\n",
    );

    expect(view.querySelector("table")).not.toBeNull();
    expect(view.querySelectorAll("td")).toHaveLength(2);
    const boxes = view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[0].disabled).toBe(true);
    expect(view.textContent).toContain("The note.");
  });

  it("renders a file that alternates HTML blocks and markdown", async () => {
    const view = await preview('# Title\n\n<div align="center">\n\n**bold**\n\n</div>\n\nAfter.\n');

    expect(view.querySelector("h1")?.textContent).toBe("Title");
    expect(view.textContent).toContain("bold");
    expect(view.textContent).toContain("After.");
  });
});

describe("MarkdownPreview — hostile input", () => {
  it("replaces a script block with a visible marker and runs nothing", async () => {
    const view = await preview("# Title\n\n<script>globalThis.pwned = true;</script>\n\nAfter.\n");

    expect(view.textContent).toContain("HTML block not rendered");
    expect(view.querySelector("script")).toBeNull();
    expect(view.innerHTML).not.toContain("pwned");
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
    // The prose on both sides of it survives — an omission, not a truncation.
    expect(view.querySelector("h1")?.textContent).toBe("Title");
    expect(view.textContent).toContain("After.");
  });

  it("refuses a frame, an object, a form and an SVG block the same way", async () => {
    for (const markup of [
      '<iframe src="https://evil.example/"></iframe>',
      '<object data="x.swf">\n</object>',
      "<svg>\n<script>globalThis.pwned = true;</script>\n</svg>",
      '<form action="https://evil.example/">\n<button>Go</button>\n</form>',
    ]) {
      const view = await preview(`${markup}\n`);
      expect(view.textContent).toContain("HTML block not rendered");
      expect(view.querySelector("iframe")).toBeNull();
      expect(view.querySelector("object")).toBeNull();
      expect(view.querySelector("svg")).toBeNull();
      expect(view.querySelector("form")).toBeNull();
    }
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it("sanitizes INLINE html, which is not a block and never was", async () => {
    // The Document policy already draws this line: inline HTML is one token in
    // a paragraph, not structure, so there is no block to mark. It still goes
    // through the same sanitizer, which is what keeps it inert.
    const view = await preview(
      'A sentence with <marquee onclick="globalThis.pwned = true">markup</marquee> in it.\n',
    );

    expect(view.textContent).toContain("A sentence with");
    expect(view.innerHTML).not.toContain("onclick");
    expect(view.querySelector("marquee")).toBeNull();
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it("marks a block that authors a document root or hides a request in CSS", async () => {
    // Both rendered with no marker until review round 2: the sanitizer cleaned
    // them, and the page said nothing about what it had left out.
    for (const markup of [
      '<body onload="globalThis.pwned = true">body</body>',
      '<html onclick="globalThis.pwned = true"><body>html</body></html>',
      '<div style="background-image:u\\72l(https://tracker.invalid/x.png)">CSS</div>',
    ]) {
      const view = await preview(`# Title\n\n${markup}\n`);
      expect(view.textContent, markup).toContain("HTML block not rendered");
      expect(view.textContent, markup).toContain("(line 3)");
      expect(view.innerHTML, markup).not.toContain("tracker.invalid");
      expect(view.querySelector("h1")?.textContent, markup).toBe("Title");
    }
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it("strips an event handler rather than drawing a live one", async () => {
    const view = await preview('<div onclick="globalThis.pwned = true">Click me</div>\n');

    expect(view.innerHTML).not.toContain("onclick");
    expect(view.textContent).toContain("HTML block not rendered");
  });

  it("neutralises a javascript: link inside otherwise ordinary markup", async () => {
    const view = await preview("[run](javascript:globalThis.pwned=1)\n");

    expect(view.innerHTML).not.toContain("javascript:");
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  it("does not let an author mint the preview's own image scheme", async () => {
    // `volli-preview:` is what the preview's rehype pass stamps on a resolved
    // repository path. Written INTO the file, it must never become a read.
    const view = await preview(
      '<p><img src="volli-preview:file/..%2F..%2Fetc%2Fpasswd" alt="hack"></p>\n',
    );

    expect(read).not.toHaveBeenCalled();
    expect(view.querySelector("img")).toBeNull();
  });

  it("refuses an image that climbs out of the checkout", async () => {
    const view = await preview("![keys](../../.ssh/id_rsa.png)", { relPath: "docs/guide.md" });

    expect(read).not.toHaveBeenCalled();
    expect(view.textContent).toContain("Image unavailable");
    expect(view.textContent).toContain("keys");
  });
});

/**
 * The no-network promise, probed at the DOM rather than at `fetch` (review
 * round 1, P1). A `fetch` spy cannot see what the BROWSER loads for a page: an
 * `<img srcset>` or a `<source>` inside a `<picture>` is a request the platform
 * makes on its own, and the first round of this work left one standing because
 * the loud gate only sees Lezer HTML BLOCKS and the image pass rewrote only
 * `<img>`. So the assertion is now about the tree that reaches the document:
 * nothing in it may name a remote host.
 */
describe("MarkdownPreview — nothing that reaches the page can fetch", () => {
  it("strips a remote <source srcset> from INLINE html beside a good local image", async () => {
    const view = await preview(
      'Before <picture><source srcset="https://tracker.invalid/pixel.png 1x"><img src="local.png" alt="x"></picture> after.\n',
    );

    expect(view.innerHTML).not.toContain("tracker.invalid");
    expect(view.querySelector("source")).toBeNull();
    expect(view.querySelector("[srcset]")).toBeNull();
    // The picture a person actually wrote still draws, from main's bytes.
    expect(view.querySelector("img")?.getAttribute("src")).toBe(PNG_DATA_URL);
    expect(view.textContent).toContain("Before");
    expect(view.textContent).toContain("after.");
  });

  it("strips srcset from an <img> that also carries a good src", async () => {
    const view = await preview(
      'Text <img src="local.png" srcset="https://tracker.invalid/2x.png 2x" alt="x"> more.\n',
    );

    expect(view.innerHTML).not.toContain("tracker.invalid");
    expect(view.querySelector("[srcset]")).toBeNull();
  });

  it("strips every other attribute that loads or beacons on render", async () => {
    for (const markup of [
      '<a href="https://volli.app" ping="https://tracker.invalid/beacon">link</a>',
      '<p style="background:url(https://tracker.invalid/bg.png)">styled</p>',
      '<span title="t" background="https://tracker.invalid/bg.png">bg</span>',
      '<video src="https://tracker.invalid/v.mp4" poster="https://tracker.invalid/p.png"></video>',
      '<object data="https://tracker.invalid/x.swf"></object>',
      '<embed src="https://tracker.invalid/x.swf">',
      '<link rel="stylesheet" href="https://tracker.invalid/x.css">',
      '<meta http-equiv="refresh" content="0;url=https://tracker.invalid/">',
      '<svg><image href="https://tracker.invalid/x.png"/></svg>',
      "<math><mtext>x</mtext></math>",
    ]) {
      const view = await preview(`Around ${markup} it.\n`);
      expect(view.innerHTML, markup).not.toContain("tracker.invalid");
      expect(view.querySelector("svg, math, video, embed, object, link, meta"), markup).toBeNull();
      // The prose the markup was written into survives — stripped, not truncated.
      expect(view.textContent, markup).toContain("Around");
    }
  });
});

describe("MarkdownPreview — images it will not draw", () => {
  it("names a remote badge instead of fetching it", async () => {
    const view = await preview("![build status](https://img.shields.io/badge/x.svg)");

    expect(view.textContent).toContain("Remote image not loaded");
    expect(view.textContent).toContain("build status");
    expect(view.querySelector("img")).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(fetched).not.toHaveBeenCalled();
  });

  it("says so when the file is not there, and keeps the alt text", async () => {
    read.mockResolvedValue({ ok: false, error: "No such file or directory" });
    const view = await preview("![missing diagram](docs/gone.png)");

    expect(view.textContent).toContain("Image unavailable");
    expect(view.textContent).toContain("missing diagram");
    expect(view.querySelector("img")).toBeNull();
  });

  it("says so when the picture is past the inline cap", async () => {
    read.mockResolvedValue({
      ok: true,
      source: "main",
      kind: "image",
      size: 99_000_000,
      mtime: 1,
      content: { type: "binary" },
    });
    const view = await preview("![huge](docs/huge.png)");

    expect(view.textContent).toContain("Image too large to preview");
    expect(view.textContent).toContain("huge");
  });

  it("survives a read that fails outright", async () => {
    read.mockRejectedValue(new Error("bridge is gone"));
    const view = await preview("![shot](docs/board.png)");

    expect(view.textContent).toContain("Image unavailable");
  });

  it("draws an inline data image, which carries its own bytes", async () => {
    const view = await preview(`![dot](${PNG_DATA_URL})`);

    expect(view.querySelector("img")?.getAttribute("src")).toBe(PNG_DATA_URL);
    expect(read).not.toHaveBeenCalled();
  });
});
