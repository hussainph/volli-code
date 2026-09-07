import { describe, expect, it } from "vite-plus/test";

import { blobUrl, SESSION_ATTACHMENTS_REL_DIR, type NamedBlobLink } from "./blob";
import {
  attachmentHashesByName,
  markdownImageNotice,
  resolveMarkdownImageSrc,
  type MarkdownImageResolution,
} from "./markdown-image";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function link(id: string, hash: string, originalName: string): NamedBlobLink {
  return { linkId: id, blobHash: hash, label: originalName, originalName };
}

describe("attachmentHashesByName", () => {
  it("maps each materialized name to its blob hash", () => {
    const map = attachmentHashesByName([link("l1", HASH_A, "spec.png")]);
    expect(map.get("spec.png")).toBe(HASH_A);
  });

  it("uses the collision-suffixed name, matching what is written to disk", () => {
    // Two links sharing a basename materialize as `spec.png` and `spec-2.png`;
    // the map must answer to the names the agent was actually given.
    const map = attachmentHashesByName([
      link("l1", HASH_A, "spec.png"),
      link("l2", HASH_B, "spec.png"),
    ]);
    expect(map.get("spec.png")).toBe(HASH_A);
    expect(map.get("spec-2.png")).toBe(HASH_B);
  });

  it("is empty for no links", () => {
    expect(attachmentHashesByName([]).size).toBe(0);
  });
});

describe("resolveMarkdownImageSrc", () => {
  const attachments = new Map([
    ["spec.png", HASH_A],
    ["diagram.svg", HASH_B],
  ]);

  it("renders a canonical volli-blob URL", () => {
    expect(resolveMarkdownImageSrc(blobUrl(HASH_A))).toEqual({
      kind: "render",
      src: blobUrl(HASH_A),
    });
  });

  it("normalizes the slashed volli-blob form Electron produces", () => {
    expect(resolveMarkdownImageSrc(`volli-blob://${HASH_A}/`)).toEqual({
      kind: "render",
      src: blobUrl(HASH_A),
    });
  });

  it("refuses a volli-blob URL whose payload is not a hash", () => {
    expect(resolveMarkdownImageSrc("volli-blob:../../secrets")).toEqual({ kind: "unresolved" });
  });

  it.each([
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/svg+xml,%3Csvg%3E",
    "data:image/gif;base64,R0lGOD",
  ])("renders an image data URI: %s", (src: string) => {
    expect(resolveMarkdownImageSrc(src)).toEqual({ kind: "render", src });
  });

  it.each(["data:text/html,<script>alert(1)</script>", "data:application/pdf;base64,AAA", "data:"])(
    "refuses a non-image data URI: %s",
    (src: string) => {
      expect(resolveMarkdownImageSrc(src)).toEqual({ kind: "unresolved" });
    },
  );

  it.each([
    "https://example.com/a.png",
    "http://example.com/a.png",
    "HTTPS://Example.com/A.PNG",
    "ftp://example.com/a.png",
    "ftps://example.com/a.png",
    "wss://example.com/a.png",
  ])("declines to fetch a remote source: %s", (src: string) => {
    expect(resolveMarkdownImageSrc(src)).toEqual({ kind: "remote" });
  });

  it.each(["file:///Users/me/a.png", "javascript:alert(1)", "volli-app:/x.png", "mailto:a@b.c"])(
    "refuses any other scheme: %s",
    (src: string) => {
      expect(resolveMarkdownImageSrc(src)).toEqual({ kind: "unresolved" });
    },
  );

  it.each([
    `${SESSION_ATTACHMENTS_REL_DIR}/spec.png`,
    `./${SESSION_ATTACHMENTS_REL_DIR}/spec.png`,
    `/Users/me/worktree/${SESSION_ATTACHMENTS_REL_DIR}/spec.png`,
    `../${SESSION_ATTACHMENTS_REL_DIR}/spec.png`,
  ])("resolves an attachment named by its materialized path: %s", (src: string) => {
    expect(resolveMarkdownImageSrc(src, attachments)).toEqual({
      kind: "render",
      src: blobUrl(HASH_A),
    });
  });

  it("resolves a windows-separated attachment path", () => {
    expect(resolveMarkdownImageSrc(".volli\\attachments\\spec.png", attachments)).toEqual({
      kind: "render",
      src: blobUrl(HASH_A),
    });
  });

  it("resolves a bare attachment name", () => {
    expect(resolveMarkdownImageSrc("spec.png", attachments)).toEqual({
      kind: "render",
      src: blobUrl(HASH_A),
    });
  });

  it("ignores a query string and fragment", () => {
    expect(resolveMarkdownImageSrc("spec.png?v=2", attachments)).toEqual({
      kind: "render",
      src: blobUrl(HASH_A),
    });
    expect(resolveMarkdownImageSrc("spec.png#top", attachments)).toEqual({
      kind: "render",
      src: blobUrl(HASH_A),
    });
  });

  it("does not answer a repository path with a same-named attachment", () => {
    // `docs/spec.png` is a claim about a repository file; resolving it to an
    // unrelated attachment would be a quiet lie.
    expect(resolveMarkdownImageSrc("docs/spec.png", attachments)).toEqual({ kind: "unresolved" });
  });

  it("refuses a nested path under the attachments directory", () => {
    expect(
      resolveMarkdownImageSrc(`${SESSION_ATTACHMENTS_REL_DIR}/sub/spec.png`, attachments),
    ).toEqual({ kind: "unresolved" });
  });

  it("refuses the attachments directory itself", () => {
    expect(resolveMarkdownImageSrc(`${SESSION_ATTACHMENTS_REL_DIR}/`, attachments)).toEqual({
      kind: "unresolved",
    });
  });

  it("refuses a name nothing is attached under", () => {
    expect(resolveMarkdownImageSrc("missing.png", attachments)).toEqual({ kind: "unresolved" });
  });

  it("resolves nothing when no attachments are supplied", () => {
    expect(resolveMarkdownImageSrc("spec.png")).toEqual({ kind: "unresolved" });
  });

  it.each(["", "   "])("treats an empty source as unresolved: %s", (src: string) => {
    expect(resolveMarkdownImageSrc(src, attachments)).toEqual({ kind: "unresolved" });
  });

  it.each(["?v=2", "#anchor"])(
    "treats a source that is nothing but a suffix as unresolved: %s",
    (src: string) => {
      // Non-empty on the way in, empty once the query/fragment is stripped.
      expect(resolveMarkdownImageSrc(src, attachments)).toEqual({ kind: "unresolved" });
    },
  );

  it("trims surrounding whitespace before deciding", () => {
    expect(resolveMarkdownImageSrc("  spec.png  ", attachments)).toEqual({
      kind: "render",
      src: blobUrl(HASH_A),
    });
  });
});

describe("markdownImageNotice", () => {
  it.each<[MarkdownImageResolution, string | null]>([
    [{ kind: "render", src: blobUrl(HASH_A) }, null],
    [{ kind: "remote" }, "Remote image not loaded"],
    [{ kind: "unresolved" }, "Image unavailable"],
  ])("explains %j", (resolution: MarkdownImageResolution, expected: string | null) => {
    expect(markdownImageNotice(resolution)).toBe(expected);
  });
});
