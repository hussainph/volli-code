import { describe, it, expect } from "vite-plus/test";
import { fileSavePolicy, type FileSavePolicyInput } from "./file-save-policy";

/** An ordinary, fully-read text file — each test varies only what it is about. */
const readable: FileSavePolicyInput = {
  relPath: "src/app.ts",
  binary: false,
  truncated: false,
};

describe("fileSavePolicy", () => {
  it("has no editor for a binary read", () => {
    expect(fileSavePolicy({ ...readable, relPath: "docs/logo.png", binary: true })).toBe(
      "read-only",
    );
  });

  it("refuses to edit a truncated read, so a saved prefix can never eat the rest of the file", () => {
    expect(fileSavePolicy({ ...readable, relPath: "logs/huge.txt", truncated: true })).toBe(
      "read-only",
    );
  });
});

describe("fileSavePolicy markdown artifacts", () => {
  it("autosaves a Markdown artifact under the canonical artifacts directory", () => {
    expect(fileSavePolicy({ ...readable, relPath: ".volli/artifacts/notes.md" })).toBe("autosave");
  });

  it("saves repository Markdown explicitly — a repo .md is part of the code checkout", () => {
    expect(fileSavePolicy({ ...readable, relPath: "README.md" })).toBe("explicit");
    expect(fileSavePolicy({ ...readable, relPath: "docs/CONCEPT.md" })).toBe("explicit");
  });

  it("saves code and extensionless text explicitly", () => {
    expect(fileSavePolicy(readable)).toBe("explicit");
    expect(fileSavePolicy({ ...readable, relPath: "Makefile" })).toBe("explicit");
  });
});

describe("fileSavePolicy artifact-path edges", () => {
  it("does not mistake a directory that merely starts with the artifacts path for the artifacts dir", () => {
    expect(fileSavePolicy({ ...readable, relPath: ".volli/artifacts-old/x.md" })).toBe("explicit");
    expect(fileSavePolicy({ ...readable, relPath: ".volli/artifactsy.md" })).toBe("explicit");
  });

  it("autosaves a Markdown artifact nested inside an artifact bundle", () => {
    expect(fileSavePolicy({ ...readable, relPath: ".volli/artifacts/nested/deep.md" })).toBe(
      "autosave",
    );
  });

  it("does not autosave a non-Markdown file that happens to live in the artifacts dir", () => {
    expect(fileSavePolicy({ ...readable, relPath: ".volli/artifacts/report.html" })).toBe(
      "explicit",
    );
    expect(fileSavePolicy({ ...readable, relPath: ".volli/artifacts/data.json" })).toBe("explicit");
  });

  it("reads the .md extension case-insensitively, and accepts .markdown", () => {
    expect(fileSavePolicy({ ...readable, relPath: ".volli/artifacts/NOTES.MD" })).toBe("autosave");
    expect(fileSavePolicy({ ...readable, relPath: ".volli/artifacts/notes.markdown" })).toBe(
      "autosave",
    );
  });
});

describe("fileSavePolicy precedence", () => {
  it("keeps a truncated Markdown artifact read-only rather than autosaving a prefix over it", () => {
    expect(
      fileSavePolicy({ relPath: ".volli/artifacts/huge.md", binary: false, truncated: true }),
    ).toBe("read-only");
  });

  it("gives an image no editor even when the caller forgot to flag it binary", () => {
    expect(fileSavePolicy({ ...readable, relPath: "docs/logo.png" })).toBe("read-only");
    expect(fileSavePolicy({ ...readable, relPath: ".volli/artifacts/diagram.svg" })).toBe(
      "read-only",
    );
  });

  it("keeps a binary-sniffed Markdown artifact read-only", () => {
    expect(
      fileSavePolicy({ relPath: ".volli/artifacts/odd.md", binary: true, truncated: false }),
    ).toBe("read-only");
  });
});
