import { describe, expect, it } from "vite-plus/test";

import {
  artifactBaseName,
  artifactImageMimeType,
  classifyArtifactKind,
  compareArtifactEntries,
  isSafeArtifactEntryName,
  isValidNewArtifactName,
  withMarkdownExtension,
  type ArtifactEntry,
} from "./artifact";

describe("classifyArtifactKind", () => {
  it.each([
    ["notes.md", "markdown"],
    ["notes.MD", "markdown"],
    ["notes.markdown", "markdown"],
    ["photo.png", "image"],
    ["photo.JPG", "image"],
    ["photo.jpeg", "image"],
    ["photo.gif", "image"],
    ["photo.webp", "image"],
    ["diagram.svg", "image"],
    ["data.json", "other"],
    ["archive.tar.gz", "other"],
    ["no-extension", "other"],
  ] as const)("classifies %s as %s", (name, kind) => {
    expect(classifyArtifactKind(name)).toBe(kind);
  });

  it("treats a dotfile (leading dot, no other dot) as having no extension", () => {
    expect(classifyArtifactKind(".gitignore")).toBe("other");
  });

  it("treats a trailing-dot name as having no extension", () => {
    expect(classifyArtifactKind("weird.")).toBe("other");
  });
});

describe("artifactImageMimeType", () => {
  it("maps every recognized image extension to a MIME type", () => {
    expect(artifactImageMimeType("a.png")).toBe("image/png");
    expect(artifactImageMimeType("a.jpg")).toBe("image/jpeg");
    expect(artifactImageMimeType("a.jpeg")).toBe("image/jpeg");
    expect(artifactImageMimeType("a.gif")).toBe("image/gif");
    expect(artifactImageMimeType("a.webp")).toBe("image/webp");
    expect(artifactImageMimeType("a.svg")).toBe("image/svg+xml");
  });

  it("returns null for a non-image extension", () => {
    expect(artifactImageMimeType("a.md")).toBeNull();
  });

  it("returns null when there is no extension", () => {
    expect(artifactImageMimeType("no-extension")).toBeNull();
  });
});

describe("isSafeArtifactEntryName", () => {
  it("accepts an ordinary file name", () => {
    expect(isSafeArtifactEntryName("Design Notes.md")).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(isSafeArtifactEntryName("")).toBe(false);
  });

  it("rejects a forward-slash separator (relative traversal)", () => {
    expect(isSafeArtifactEntryName("../../etc/passwd")).toBe(false);
  });

  it("rejects a backslash separator", () => {
    expect(isSafeArtifactEntryName("sub\\dir.md")).toBe(false);
  });

  it("rejects an absolute path (leading slash)", () => {
    expect(isSafeArtifactEntryName("/etc/passwd")).toBe(false);
  });

  it("rejects the literal current-directory name", () => {
    expect(isSafeArtifactEntryName(".")).toBe(false);
  });

  it("rejects the literal parent-directory name", () => {
    expect(isSafeArtifactEntryName("..")).toBe(false);
  });
});

describe("isValidNewArtifactName", () => {
  it("accepts a plain name", () => {
    expect(isValidNewArtifactName("Design Notes")).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isValidNewArtifactName("  Design Notes  ")).toBe(true);
  });

  it("rejects an all-whitespace name", () => {
    expect(isValidNewArtifactName("   ")).toBe(false);
  });

  it("rejects a name with a separator", () => {
    expect(isValidNewArtifactName("sub/notes")).toBe(false);
  });

  it.each([[".notes"], [".md"], ["  .hidden  "], ["."], [".."]])(
    "rejects a leading-dot name %s (it would be created but then hidden by the tier listing)",
    (raw) => {
      expect(isValidNewArtifactName(raw)).toBe(false);
    },
  );
});

describe("withMarkdownExtension", () => {
  it("appends .md to a bare name", () => {
    expect(withMarkdownExtension("Design Notes")).toBe("Design Notes.md");
  });

  it("leaves an already-.md name untouched", () => {
    expect(withMarkdownExtension("Design Notes.md")).toBe("Design Notes.md");
  });

  it("is case-insensitive about an existing .md extension", () => {
    expect(withMarkdownExtension("Design Notes.MD")).toBe("Design Notes.MD");
  });

  it("trims surrounding whitespace", () => {
    expect(withMarkdownExtension("  Design Notes  ")).toBe("Design Notes.md");
  });
});

describe("artifactBaseName", () => {
  it("strips a simple extension", () => {
    expect(artifactBaseName("Design Notes.md")).toBe("Design Notes");
  });

  it("returns the name unchanged when there is no extension", () => {
    expect(artifactBaseName("README")).toBe("README");
  });
});

function entry(overrides: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return {
    name: "a.md",
    relPath: "a.md",
    tier: "ticket",
    size: 0,
    mtime: 0,
    kind: "markdown",
    ...overrides,
  };
}

describe("compareArtifactEntries", () => {
  it("sorts case-insensitively", () => {
    const entries = [entry({ name: "banana.md" }), entry({ name: "Apple.md" })];
    entries.sort(compareArtifactEntries);
    expect(entries.map((e) => e.name)).toEqual(["Apple.md", "banana.md"]);
  });

  it("orders a lexicographically-earlier lowercase name first", () => {
    expect(
      compareArtifactEntries(entry({ name: "apple.md" }), entry({ name: "banana.md" })),
    ).toBeLessThan(0);
  });

  it("orders a lexicographically-later lowercase name after", () => {
    expect(
      compareArtifactEntries(entry({ name: "banana.md" }), entry({ name: "apple.md" })),
    ).toBeGreaterThan(0);
  });

  it("breaks a case-insensitive tie by raw string comparison (a before b)", () => {
    expect(compareArtifactEntries(entry({ name: "B.md" }), entry({ name: "b.md" }))).toBeLessThan(
      0,
    );
  });

  it("breaks a case-insensitive tie by raw string comparison (a after b)", () => {
    expect(
      compareArtifactEntries(entry({ name: "b.md" }), entry({ name: "B.md" })),
    ).toBeGreaterThan(0);
  });

  it("treats equal names as equal", () => {
    expect(compareArtifactEntries(entry({ name: "a.md" }), entry({ name: "a.md" }))).toBe(0);
  });
});
