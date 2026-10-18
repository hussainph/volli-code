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
      { name: "AGENTS.md", present: false },
      { name: "CLAUDE.md", present: false },
    ]);
  });

  it("marks only the file a repo has as present", () => {
    expect(instructionFiles([{ name: "CLAUDE.md", kind: "file" }])).toEqual([
      { name: "AGENTS.md", present: false },
      { name: "CLAUDE.md", present: true },
    ]);
    expect(instructionFiles([{ name: "AGENTS.md", kind: "file" }])).toEqual([
      { name: "AGENTS.md", present: true },
      { name: "CLAUDE.md", present: false },
    ]);
  });

  it("marks both present in a repo with both, in a fixed order", () => {
    expect(
      instructionFiles([
        { name: "CLAUDE.md", kind: "file" },
        { name: "AGENTS.md", kind: "file" },
      ]),
    ).toEqual([
      { name: "AGENTS.md", present: true },
      { name: "CLAUDE.md", present: true },
    ]);
  });

  it("counts neither a directory of that name nor a differently cased file", () => {
    expect(
      instructionFiles([
        { name: "AGENTS.md", kind: "dir" },
        { name: "claude.md", kind: "file" },
      ]),
    ).toEqual([
      { name: "AGENTS.md", present: false },
      { name: "CLAUDE.md", present: false },
    ]);
  });
});
