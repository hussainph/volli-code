import { describe, expect, it } from "vite-plus/test";

import { instructionFiles } from "./instruction-files";

describe("instructionFiles", () => {
  it("names both files missing in a repo with neither", () => {
    expect(
      instructionFiles([
        { name: "src", kind: "dir" },
        { name: "README.md", kind: "file" },
      ]),
    ).toEqual([
      { name: "AGENTS.md", state: "missing" },
      { name: "CLAUDE.md", state: "missing" },
    ]);
  });

  it("marks only the file a repo has", () => {
    expect(instructionFiles([{ name: "CLAUDE.md", kind: "file" }])).toEqual([
      { name: "AGENTS.md", state: "missing" },
      { name: "CLAUDE.md", state: "file" },
    ]);
    expect(instructionFiles([{ name: "AGENTS.md", kind: "file" }])).toEqual([
      { name: "AGENTS.md", state: "file" },
      { name: "CLAUDE.md", state: "missing" },
    ]);
  });

  it("marks both in a repo with both, in a fixed order", () => {
    expect(
      instructionFiles([
        { name: "CLAUDE.md", kind: "file" },
        { name: "AGENTS.md", kind: "file" },
      ]),
    ).toEqual([
      { name: "AGENTS.md", state: "file" },
      { name: "CLAUDE.md", state: "file" },
    ]);
  });

  it("calls any symlink a link — to a file, a directory, or nothing — never a file", () => {
    // The listing types every symlink `file`; only `link` says what it is.
    expect(
      instructionFiles([
        { name: "AGENTS.md", kind: "file" },
        { name: "CLAUDE.md", kind: "file", link: true },
      ]),
    ).toEqual([
      { name: "AGENTS.md", state: "file" },
      { name: "CLAUDE.md", state: "link" },
    ]);
  });

  it("counts neither a real directory of that name nor a differently cased file", () => {
    expect(
      instructionFiles([
        { name: "AGENTS.md", kind: "dir" },
        { name: "claude.md", kind: "file" },
      ]),
    ).toEqual([
      { name: "AGENTS.md", state: "missing" },
      { name: "CLAUDE.md", state: "missing" },
    ]);
  });
});
