import { describe, expect, it } from "vite-plus/test";

import {
  parsePreviewImageSrc,
  previewImageDisplay,
  previewImageSource,
  previewImageSrc,
  svgTextDataUrl,
  type PreviewImageSource,
} from "./markdown-preview-image";

/** The source one image written in `README.md` resolves to. */
function fromReadme(src: string): PreviewImageSource {
  return previewImageSource({ markdownRelPath: "README.md", src });
}

describe("previewImageSource — repository paths", () => {
  it("resolves the README's own icon and screenshot against the repository root", () => {
    expect(fromReadme("apps/desktop/build/icon-source.svg")).toEqual({
      kind: "repo-file",
      relPath: "apps/desktop/build/icon-source.svg",
    });
    expect(fromReadme("apps/docs/src/assets/screenshots/board.png")).toEqual({
      kind: "repo-file",
      relPath: "apps/docs/src/assets/screenshots/board.png",
    });
  });

  it("resolves against the markdown file's OWN directory, not the repository root", () => {
    expect(previewImageSource({ markdownRelPath: "docs/guide.md", src: "shot.png" })).toEqual({
      kind: "repo-file",
      relPath: "docs/shot.png",
    });
    expect(previewImageSource({ markdownRelPath: "docs/guide.md", src: "./img/a.png" })).toEqual({
      kind: "repo-file",
      relPath: "docs/img/a.png",
    });
    expect(
      previewImageSource({ markdownRelPath: "docs/deep/guide.md", src: "../assets/a.png" }),
    ).toEqual({ kind: "repo-file", relPath: "docs/assets/a.png" });
  });

  it("drops a query or fragment a markdown author appended", () => {
    expect(fromReadme("docs/a.png?v=2")).toEqual({ kind: "repo-file", relPath: "docs/a.png" });
    expect(fromReadme("docs/a.png#top")).toEqual({ kind: "repo-file", relPath: "docs/a.png" });
  });

  it("reads a percent-encoded path as the file it names", () => {
    expect(fromReadme("docs/my%20shot.png")).toEqual({
      kind: "repo-file",
      relPath: "docs/my shot.png",
    });
  });

  it("refuses a path that climbs out of the checkout", () => {
    expect(fromReadme("../secrets/id_rsa.png")).toEqual({ kind: "unresolved" });
    expect(previewImageSource({ markdownRelPath: "docs/guide.md", src: "../../etc/x.png" })).toEqual(
      { kind: "unresolved" },
    );
  });

  it("refuses an absolute path: a file preview reads the checkout, not the disk", () => {
    expect(fromReadme("/Users/me/shot.png")).toEqual({ kind: "unresolved" });
  });

  it("refuses a path that names no image format", () => {
    expect(fromReadme("docs/notes.md")).toEqual({ kind: "unresolved" });
    expect(fromReadme("LICENSE")).toEqual({ kind: "unresolved" });
  });

  it("refuses a path that cannot be decoded, or that smuggles a NUL", () => {
    expect(fromReadme("docs/%E0%A4%A.png")).toEqual({ kind: "unresolved" });
    expect(fromReadme("docs/%00shot.png")).toEqual({ kind: "unresolved" });
  });

  it("normalizes an ENCODED traversal instead of taking it at face value", () => {
    expect(fromReadme("docs%2F..%2F..%2Fetc%2Fx.png")).toEqual({ kind: "unresolved" });
    expect(fromReadme("docs%2Fimg%2Fa.png")).toEqual({
      kind: "repo-file",
      relPath: "docs/img/a.png",
    });
  });

  it("refuses a source that resolves to nothing at all", () => {
    expect(previewImageSource({ markdownRelPath: "README.md", src: "./" })).toEqual({
      kind: "unresolved",
    });
  });

  it("refuses an empty or whitespace source", () => {
    expect(fromReadme("")).toEqual({ kind: "unresolved" });
    expect(fromReadme("   ")).toEqual({ kind: "unresolved" });
  });
});

describe("previewImageSource — schemes", () => {
  it("keeps an inert data image", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(fromReadme(src)).toEqual({ kind: "inline", src });
  });

  it("declines a remote badge rather than fetching it", () => {
    expect(fromReadme("https://img.shields.io/badge/x.svg")).toEqual({ kind: "remote" });
    expect(fromReadme("http://example.com/a.png")).toEqual({ kind: "remote" });
    expect(fromReadme("//example.com/a.png")).toEqual({ kind: "remote" });
  });

  it("refuses every other scheme, `file:` and `data:text/html` included", () => {
    expect(fromReadme("file:///Users/me/shot.png")).toEqual({ kind: "unresolved" });
    expect(fromReadme("javascript:alert(1)")).toEqual({ kind: "unresolved" });
    expect(fromReadme("data:text/html;base64,PHNjcmlwdD4=")).toEqual({ kind: "unresolved" });
    expect(fromReadme("volli-blob://abc/")).toEqual({ kind: "unresolved" });
  });

  it("refuses a source that already wears the preview's own scheme", () => {
    // Only the preview's rehype pass mints these, and the renderer's sanitizer
    // deletes the scheme from author markup before that pass runs. Refusing it
    // here too means a file cannot name a repository path it did not resolve.
    expect(fromReadme("volli-preview:file/..%2F..%2Fetc%2Fpasswd")).toEqual({ kind: "unresolved" });
  });
});

describe("previewImageSrc / parsePreviewImageSrc", () => {
  it("round-trips a repository path through the src an <img> carries", () => {
    const source: PreviewImageSource = { kind: "repo-file", relPath: "docs/a b/shot.png" };
    const src = previewImageSrc(source);
    expect(src.startsWith("volli-preview:")).toBe(true);
    expect(src).not.toContain(" ");
    expect(parsePreviewImageSrc(src)).toEqual(source);
  });

  it("round-trips each refusal, so the picture's replacement says which one it was", () => {
    expect(parsePreviewImageSrc(previewImageSrc({ kind: "remote" }))).toEqual({ kind: "remote" });
    expect(parsePreviewImageSrc(previewImageSrc({ kind: "unresolved" }))).toEqual({
      kind: "unresolved",
    });
  });

  it("leaves an inline data image as its own source", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(previewImageSrc({ kind: "inline", src })).toBe(src);
    expect(parsePreviewImageSrc(src)).toEqual({ kind: "inline", src });
  });

  it("reads anything else as unresolved rather than displaying it", () => {
    expect(parsePreviewImageSrc("https://example.com/a.png")).toEqual({ kind: "remote" });
    expect(parsePreviewImageSrc("docs/a.png")).toEqual({ kind: "unresolved" });
    expect(parsePreviewImageSrc(undefined)).toEqual({ kind: "unresolved" });
    expect(parsePreviewImageSrc("volli-preview:file/%E0%A4%A")).toEqual({ kind: "unresolved" });
  });
});

describe("previewImageDisplay", () => {
  it("displays raster bytes through the data URL main already built", () => {
    expect(
      previewImageDisplay({
        relPath: "docs/a.png",
        content: { type: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
      }),
    ).toEqual({ kind: "src", src: "data:image/png;base64,iVBORw0KGgo=" });
  });

  it("displays an SVG, which the workbench reads as editable text", () => {
    // SVG is deliberately a normal editor tab (`IMAGE_EXTENSIONS` excludes it),
    // so main serves it as text and the preview builds the picture itself —
    // without changing what opening the .svg file does.
    const display = previewImageDisplay({
      relPath: "apps/desktop/build/icon-source.svg",
      content: { type: "text", text: "<svg xmlns='http://www.w3.org/2000/svg'/>", truncated: false },
    });
    expect(display).toEqual({
      kind: "src",
      src: svgTextDataUrl("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    });
    expect(svgTextDataUrl("<svg/>").startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  });

  it("refuses a truncated SVG rather than drawing half a picture", () => {
    expect(
      previewImageDisplay({
        relPath: "big.svg",
        content: { type: "text", text: "<svg", truncated: true },
      }),
    ).toEqual({ kind: "notice", notice: "Image too large to preview" });
  });

  it("says an oversize or unreadable image is too large, which is what binary means here", () => {
    expect(previewImageDisplay({ relPath: "docs/huge.png", content: { type: "binary" } })).toEqual({
      kind: "notice",
      notice: "Image too large to preview",
    });
  });

  it("refuses text that is not an SVG", () => {
    expect(
      previewImageDisplay({
        relPath: "docs/notes.png",
        content: { type: "text", text: "not a picture", truncated: false },
      }),
    ).toEqual({ kind: "notice", notice: "Image unavailable" });
  });

  it("percent-encodes the SVG so no byte of it can end the data URL early", () => {
    const url = svgTextDataUrl('<svg><text>a "quoted" & <b>#hash</b></text></svg>');
    expect(url).not.toContain("<");
    expect(url).not.toContain("#");
    expect(url).not.toContain('"');
  });
});
