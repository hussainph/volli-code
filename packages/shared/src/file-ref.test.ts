import { describe, expect, it } from "vite-plus/test";

import {
  artifactBaseName,
  baseNameOf,
  classifyFileKind,
  dirNameOf,
  imageMimeType,
  isArtifactRelPath,
  isExpressibleRefPath,
  isSafeArtifactEntryName,
  isSafeRelPath,
  isValidNewArtifactName,
  parseFileRefs,
  scoreFileMatch,
  withMarkdownExtension,
} from "./file-ref";

describe("classifyFileKind", () => {
  it.each([
    ["notes.md", "markdown"],
    ["notes.MD", "markdown"],
    ["notes.markdown", "markdown"],
    ["photo.png", "image"],
    ["photo.JPG", "image"],
    ["photo.jpeg", "image"],
    ["photo.gif", "image"],
    ["photo.webp", "image"],
    // Markup, not raster bytes — it belongs in the editor (see IMAGE_EXTENSIONS).
    ["diagram.svg", "other"],
    ["diagram.SVG", "other"],
    ["data.json", "other"],
    ["archive.tar.gz", "other"],
    ["no-extension", "other"],
  ] as const)("classifies %s as %s", (name, kind) => {
    expect(classifyFileKind(name)).toBe(kind);
  });

  it("classifies by the basename of a full relPath", () => {
    expect(classifyFileKind("src/components/notes.md")).toBe("markdown");
    expect(classifyFileKind("assets/img/diagram.png")).toBe("image");
    expect(classifyFileKind("src/index.ts")).toBe("other");
  });

  it("ignores a dot in a parent directory name", () => {
    expect(classifyFileKind("a.b/notes")).toBe("other");
  });

  it("treats a dotfile (leading dot, no other dot) as having no extension", () => {
    expect(classifyFileKind(".gitignore")).toBe("other");
    expect(classifyFileKind("config/.gitignore")).toBe("other");
  });

  it("treats a trailing-dot name as having no extension", () => {
    expect(classifyFileKind("weird.")).toBe("other");
  });
});

describe("imageMimeType", () => {
  it("maps every recognized image extension to a MIME type", () => {
    expect(imageMimeType("a.png")).toBe("image/png");
    expect(imageMimeType("a.jpg")).toBe("image/jpeg");
    expect(imageMimeType("a.jpeg")).toBe("image/jpeg");
    expect(imageMimeType("a.gif")).toBe("image/gif");
    expect(imageMimeType("a.webp")).toBe("image/webp");
  });

  it("still renders SVG as an image even though it classifies as editable text", () => {
    // The two questions are deliberately separate: `classifyFileKind` decides
    // whether the bytes are text, `imageMimeType` decides whether they can be
    // shown as a picture. SVG answers yes to both.
    expect(imageMimeType("a.svg")).toBe("image/svg+xml");
    expect(classifyFileKind("a.svg")).toBe("other");
  });

  it("accepts a full relPath", () => {
    expect(imageMimeType("assets/logo.svg")).toBe("image/svg+xml");
  });

  it("returns null for a non-image extension", () => {
    expect(imageMimeType("a.md")).toBeNull();
  });

  it("returns null when there is no extension", () => {
    expect(imageMimeType("no-extension")).toBeNull();
  });
});

describe("isArtifactRelPath", () => {
  it("recognizes a path under .volli/artifacts/", () => {
    expect(isArtifactRelPath(".volli/artifacts/notes.md")).toBe(true);
    expect(isArtifactRelPath(".volli/artifacts")).toBe(true);
  });

  it("rejects an ordinary repo path", () => {
    expect(isArtifactRelPath("src/index.ts")).toBe(false);
    expect(isArtifactRelPath(".volli/tickets/VC-1/notes.md")).toBe(false);
    // A sibling that merely shares the prefix string is not under the dir.
    expect(isArtifactRelPath(".volli/artifacts-old.md")).toBe(false);
  });
});

describe("baseNameOf", () => {
  it("returns the segment after the last slash", () => {
    expect(baseNameOf("src/components/notes.md")).toBe("notes.md");
  });

  it("returns the whole string when there is no separator", () => {
    expect(baseNameOf("notes.md")).toBe("notes.md");
  });
});

describe("dirNameOf", () => {
  it("returns the directory portion of a nested path", () => {
    expect(dirNameOf("src/components/notes.md")).toBe("src/components");
  });

  it("returns an empty string at the repo root (no separator)", () => {
    expect(dirNameOf("notes.md")).toBe("");
  });
});

describe("isExpressibleRefPath", () => {
  it.each([["src/main.ts"], ["notes.md"], ["src/lib"], [".volli/artifacts/plan.md"]])(
    "accepts the expressible path %j",
    (relPath) => {
      expect(isExpressibleRefPath(relPath)).toBe(true);
    },
  );

  it.each([
    [""], // empty is never expressible
    ["my notes.md"], // a space truncates the run
    ["src/pages/[slug].tsx"], // `[`/`]` are outside the path char class
    ["src/a+b.ts"], // `+` is outside the path char class
    ["plan.md."], // a trailing dot would be clipped by the parser
    ["Makefile"], // no `/` or `.` — indistinguishable from a bare @mention
  ])("rejects the unexpressible path %j", (relPath) => {
    expect(isExpressibleRefPath(relPath)).toBe(false);
  });

  it("agrees with parseFileRefs: an expressible path round-trips unchanged", () => {
    const relPath = "src/components/notes.md";
    expect(isExpressibleRefPath(relPath)).toBe(true);
    expect(parseFileRefs(`@${relPath}`).map((r) => r.path)).toEqual([relPath]);
  });
});

// ---- parseFileRefs -----------------------------------------------------------

describe("parseFileRefs", () => {
  it("finds a ref at the start of the string", () => {
    expect(parseFileRefs("@src/main.ts here")).toEqual([{ path: "src/main.ts", from: 0, to: 12 }]);
  });

  it("finds a ref after whitespace", () => {
    const md = "see @docs/plan.md";
    const refs = parseFileRefs(md);
    expect(refs).toEqual([{ path: "docs/plan.md", from: 4, to: 17 }]);
    expect(md.slice(refs[0]!.from, refs[0]!.to)).toBe("@docs/plan.md");
  });

  it("finds a ref at the start of a line", () => {
    const refs = parseFileRefs("intro\n@notes.md end");
    expect(refs).toEqual([{ path: "notes.md", from: 6, to: 15 }]);
  });

  it("finds a ref after an opening paren", () => {
    const md = "(@a/b.ts)";
    const refs = parseFileRefs(md);
    expect(refs).toEqual([{ path: "a/b.ts", from: 1, to: 8 }]);
    // The `)` closed the token and is not part of the path.
    expect(md.slice(refs[0]!.from, refs[0]!.to)).toBe("@a/b.ts");
  });

  it("does NOT treat an @ mid-word (an email) as a ref", () => {
    expect(parseFileRefs("mail me at foo@bar.com now")).toEqual([]);
  });

  it("strips trailing sentence punctuation", () => {
    const md = "open @docs/plan.md.";
    const refs = parseFileRefs(md);
    expect(refs).toEqual([{ path: "docs/plan.md", from: 5, to: 18 }]);
  });

  it("strips a run of trailing punctuation but keeps interior dots", () => {
    expect(parseFileRefs("@a/b.min.js!!").map((r) => r.path)).toEqual(["a/b.min.js"]);
  });

  it("requires a slash or dot (a bare @mention is not a ref)", () => {
    expect(parseFileRefs("hi @everyone and @team")).toEqual([]);
  });

  it("accepts a dotted filename with no directory", () => {
    expect(parseFileRefs("@README.md").map((r) => r.path)).toEqual(["README.md"]);
  });

  it("excludes paths containing whitespace (the run stops at the space)", () => {
    // "@my file.md" — only "my" is consumed, which has no slash/dot → no ref.
    expect(parseFileRefs("@my file.md")).toEqual([]);
  });

  it("is dangling-safe: a lone @ or trailing @ yields nothing and never throws", () => {
    expect(parseFileRefs("@")).toEqual([]);
    expect(parseFileRefs("trailing @")).toEqual([]);
    expect(parseFileRefs("a @ b")).toEqual([]);
  });

  it("finds multiple refs across the string", () => {
    const refs = parseFileRefs("@a/x.ts and @b/y.ts");
    expect(refs.map((r) => r.path)).toEqual(["a/x.ts", "b/y.ts"]);
    expect(refs[1]).toEqual({ path: "b/y.ts", from: 12, to: 19 });
  });

  it("does not re-scan an inner @ of an invalid token", () => {
    // The whole "no@slash" run is consumed once; the interior @ is not a
    // boundary (preceded by a letter) anyway.
    expect(parseFileRefs("@no@slash")).toEqual([]);
  });
});

// ---- scoreFileMatch ----------------------------------------------------------

describe("scoreFileMatch", () => {
  it("returns null when the query is not a subsequence of the path", () => {
    expect(scoreFileMatch("xyz", "src/main.ts")).toBeNull();
  });

  it("matches a subsequence (chars in order, not necessarily contiguous)", () => {
    expect(scoreFileMatch("smn", "src/main.ts")).not.toBeNull();
  });

  it("ranks an artifact above an equally-matching ordinary file", () => {
    const artifact = scoreFileMatch("notes", ".volli/artifacts/notes.md");
    const ordinary = scoreFileMatch("notes", "notes.md");
    expect(artifact).not.toBeNull();
    expect(ordinary).not.toBeNull();
    expect(artifact!).toBeGreaterThan(ordinary!);
  });

  it("ranks a shallower path above a deeper one for the same match", () => {
    const shallow = scoreFileMatch("main", "main.ts");
    const deep = scoreFileMatch("main", "a/b/c/d/main.ts");
    expect(shallow).not.toBeNull();
    expect(deep).not.toBeNull();
    expect(shallow!).toBeGreaterThan(deep!);
  });

  it("rewards a basename/word-boundary match over a scattered one", () => {
    const boundary = scoreFileMatch("main", "src/main.ts");
    const scattered = scoreFileMatch("main", "mxaxixn/other.ts");
    expect(boundary).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(boundary!).toBeGreaterThan(scattered!);
  });

  it("treats an empty query as matching everything, ranked by shape", () => {
    const artifact = scoreFileMatch("", ".volli/artifacts/x.md");
    const ordinary = scoreFileMatch("", "deep/nested/x.md");
    expect(artifact).not.toBeNull();
    expect(ordinary).not.toBeNull();
    expect(artifact!).toBeGreaterThan(ordinary!);
  });

  it("is case-insensitive", () => {
    expect(scoreFileMatch("MAIN", "src/main.ts")).not.toBeNull();
    expect(scoreFileMatch("main", "src/MAIN.TS")).not.toBeNull();
  });
});

// ---- name safety (create flow) ----------------------------------------------

describe("isSafeArtifactEntryName", () => {
  it("accepts an ordinary file name", () => {
    expect(isSafeArtifactEntryName("Design Notes.md")).toBe(true);
  });

  it.each([[""], ["../../etc/passwd"], ["sub\\dir.md"], ["/etc/passwd"], ["."], [".."]])(
    "rejects the unsafe name %s",
    (name) => {
      expect(isSafeArtifactEntryName(name)).toBe(false);
    },
  );
});

describe("isValidNewArtifactName", () => {
  it("accepts a plain name, trimming first", () => {
    expect(isValidNewArtifactName("Design Notes")).toBe(true);
    expect(isValidNewArtifactName("  Design Notes  ")).toBe(true);
  });

  it.each([["   "], ["sub/notes"], [".notes"], [".md"], ["  .hidden  "], ["."], [".."]])(
    "rejects the invalid name %s",
    (raw) => {
      expect(isValidNewArtifactName(raw)).toBe(false);
    },
  );
});

describe("withMarkdownExtension", () => {
  it("appends .md to a bare name", () => {
    expect(withMarkdownExtension("Design Notes")).toBe("Design Notes.md");
  });

  it("leaves an already-.md name untouched (case-insensitively) and trims", () => {
    expect(withMarkdownExtension("Design Notes.md")).toBe("Design Notes.md");
    expect(withMarkdownExtension("Design Notes.MD")).toBe("Design Notes.MD");
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

// ---- relPath safety (read/write/reveal) -------------------------------------

describe("isSafeRelPath", () => {
  it("accepts an ordinary project-relative path", () => {
    expect(isSafeRelPath("src/main.ts")).toBe(true);
    expect(isSafeRelPath(".volli/artifacts/notes.md")).toBe(true);
    expect(isSafeRelPath("README.md")).toBe(true);
  });

  it.each([
    [""],
    ["/etc/passwd"],
    ["../escape.md"],
    ["src/../../escape.md"],
    ["a/./b.md"],
    ["a//b.md"],
    ["a\\b.md"],
    ["a\0b.md"],
    [".."],
    ["."],
  ])("rejects the unsafe relPath %j", (relPath) => {
    expect(isSafeRelPath(relPath)).toBe(false);
  });
});
