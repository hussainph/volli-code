/**
 * The preview's own hardening pass, run on trees the sanitizer has already
 * cleaned (VC-307, review round 2).
 *
 * These trees are written by hand ON PURPOSE. The point of the pass is that it
 * does not trust the step before it: review round 1 widened Streamdown's
 * sanitize schema with `math`/`mtext` and the MathML reached the document,
 * because everything downstream derived its opinion from that same schema. So
 * every case here feeds the pass a node the sanitizer is not supposed to emit
 * today, and asserts the pass removes it anyway.
 */
import { describe, expect, it } from "vite-plus/test";

import { previewHardeningPlugin, type PreviewHastNode } from "./markdown-preview-rehype";

function element(
  tagName: string,
  properties: Record<string, unknown> = {},
  children: PreviewHastNode[] = [],
): PreviewHastNode {
  return { type: "element", tagName, properties, children };
}

function text(value: string): PreviewHastNode {
  return { type: "text", value };
}

/** Runs the pass over a root holding `children`, and answers the hardened root. */
function harden(children: PreviewHastNode[], relPath = "README.md"): PreviewHastNode {
  const tree: PreviewHastNode = { type: "root", children };
  previewHardeningPlugin(relPath)()(tree);
  return tree;
}

/** Every tag name left in the tree, in document order. */
function tags(node: PreviewHastNode): string[] {
  const found: string[] = [];
  const walk = (current: PreviewHastNode): void => {
    if (current.type === "element" && typeof current.tagName === "string") {
      found.push(current.tagName);
    }
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return found;
}

/** Everything the tree would put on screen as words. */
function words(node: PreviewHastNode): string {
  if (node.type === "text") return String(node.value ?? "");
  return (node.children ?? []).map(words).join("");
}

function firstElement(node: PreviewHastNode, tagName: string): PreviewHastNode | null {
  if (node.type === "element" && node.tagName === tagName) return node;
  for (const child of node.children ?? []) {
    const found = firstElement(child, tagName);
    if (found !== null) return found;
  }
  return null;
}

describe("previewHardeningPlugin — elements", () => {
  it("drops a <source>, which is a fetch the browser makes on its own", () => {
    const tree = harden([
      element("picture", {}, [
        element("source", { srcSet: "https://tracker.invalid/pixel.png 1x" }),
        element("img", { src: "local.png", alt: "x" }),
      ]),
    ]);

    expect(tags(tree)).not.toContain("source");
    expect(JSON.stringify(tree)).not.toContain("tracker.invalid");
    // The picture inside the wrapper survives, resolved for the file's own dir.
    expect(firstElement(tree, "img")?.properties?.["src"]).toBe("volli-preview:file/local.png");
  });

  it("drops foreign and active subtrees the sanitizer might one day admit", () => {
    for (const tagName of [
      "svg",
      "math",
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "video",
      "audio",
      "track",
      "link",
      "meta",
      "base",
      "canvas",
      "template",
      "noscript",
    ]) {
      const tree = harden([
        element("p", {}, [
          text("before "),
          element(
            tagName,
            { src: "https://tracker.invalid/x", href: "https://tracker.invalid/x" },
            [element("mtext", {}, [text("swallowed")])],
          ),
          text(" after"),
        ]),
      ]);

      expect(tags(tree), tagName).toEqual(["p"]);
      expect(words(tree), tagName).toBe("before  after");
      expect(JSON.stringify(tree), tagName).not.toContain("tracker.invalid");
    }
  });

  it("unwraps an element it does not know, rather than swallowing what it held", () => {
    const tree = harden([element("article", {}, [element("p", {}, [text("Reading")])])]);

    expect(tags(tree)).toEqual(["p"]);
    expect(words(tree)).toBe("Reading");
  });

  it("keeps the elements a document is made of", () => {
    const tree = harden([
      element("details", { open: true }, [
        element("summary", {}, [text("More")]),
        element("p", {}, [element("strong", {}, [text("body")])]),
      ]),
    ]);

    expect(tags(tree)).toEqual(["details", "summary", "p", "strong"]);
  });

  it("keeps a markdown task list's checkbox, which is not raw HTML", () => {
    const tree = harden([
      element("li", { className: ["task-list-item"] }, [
        element("input", { type: "checkbox", checked: true, disabled: true }),
      ]),
    ]);

    expect(firstElement(tree, "input")?.properties).toEqual({
      type: "checkbox",
      checked: true,
      disabled: true,
    });
  });
});

describe("previewHardeningPlugin — attributes", () => {
  it("removes anything that loads, beacons, styles or listens", () => {
    const tree = harden([
      element("p", {
        style: "background:url(https://tracker.invalid/bg.png)",
        background: "https://tracker.invalid/bg.png",
        onClick: "steal()",
        ping: "https://tracker.invalid/beacon",
        title: "kept",
        align: "center",
      }),
    ]);

    expect(firstElement(tree, "p")?.properties).toEqual({ title: "kept", align: "center" });
  });

  it("removes srcset even where the element itself is allowed", () => {
    const tree = harden([
      element("img", { src: "local.png", srcSet: "https://tracker.invalid/2x.png 2x", alt: "x" }),
    ]);

    expect(firstElement(tree, "img")?.properties?.["srcSet"]).toBeUndefined();
    expect(JSON.stringify(tree)).not.toContain("tracker.invalid");
  });

  it("keeps a link to the web and drops a link that would execute", () => {
    const tree = harden([
      element("a", { href: "https://volli.app" }, [text("go")]),
      element("a", { href: "javascript:alert(1)" }, [text("run")]),
      element("a", { href: "#section" }, [text("anchor")]),
    ]);

    const hrefs = (tree.children ?? []).map((child) => child.properties?.["href"]);
    expect(hrefs).toEqual(["https://volli.app", undefined, "#section"]);
  });

  it("resolves every image through the preview's own resolver, wherever it came from", () => {
    const tree = harden(
      [
        element("img", { src: "shot.png" }),
        element("img", { src: "https://tracker.invalid/pixel.png" }),
        element("img", { src: "../../.ssh/id_rsa.png" }),
        element("img", {}),
      ],
      "docs/guide.md",
    );

    expect((tree.children ?? []).map((child) => child.properties?.["src"])).toEqual([
      `volli-preview:file/${encodeURIComponent("docs/shot.png")}`,
      "volli-preview:remote",
      "volli-preview:unresolved",
      "volli-preview:unresolved",
    ]);
  });

  it("leaves text and comments alone rather than rewriting the document", () => {
    const tree = harden([text("plain"), { type: "comment", value: " note " }, element("br")]);

    expect(words(tree)).toBe("plain");
    expect(tags(tree)).toEqual(["br"]);
  });
});
