import { describe, expect, it } from "vite-plus/test";

import {
  isRepoInstructionsResource,
  REPO_INSTRUCTIONS_MAX_BYTES,
  REPO_INSTRUCTIONS_RESOURCE_NAME,
  repoInstructionsResource,
} from "./repo-instructions";

const HEADER = (file: string) =>
  `From ${file} at the workspace root, as it read when this Session started.`;

describe("repoInstructionsResource", () => {
  it("is null when the workspace has no instruction file", () => {
    expect(repoInstructionsResource([])).toBeNull();
  });

  it("delivers AGENTS.md under its header", () => {
    expect(
      repoInstructionsResource([{ file: "AGENTS.md", text: "# Rules\n\nBe kind.\n" }]),
    ).toEqual({
      name: REPO_INSTRUCTIONS_RESOURCE_NAME,
      text: `${HEADER("AGENTS.md")}\n\n# Rules\n\nBe kind.`,
    });
  });

  it("falls back to CLAUDE.md when there is no AGENTS.md", () => {
    expect(repoInstructionsResource([{ file: "CLAUDE.md", text: "Claude rules" }])?.text).toBe(
      `${HEADER("CLAUDE.md")}\n\nClaude rules`,
    );
  });

  it("prefers AGENTS.md over CLAUDE.md, in either order, and sends one file", () => {
    const resource = repoInstructionsResource([
      { file: "CLAUDE.md", text: "claude" },
      { file: "AGENTS.md", text: "agents" },
    ]);
    expect(resource?.text).toBe(`${HEADER("AGENTS.md")}\n\nagents`);
  });

  it("injects identical AGENTS.md and CLAUDE.md once", () => {
    const resource = repoInstructionsResource([
      { file: "AGENTS.md", text: "same rules" },
      { file: "CLAUDE.md", text: "same rules" },
    ]);
    expect(resource?.text.match(/same rules/g)).toHaveLength(1);
  });

  it("lets a blank AGENTS.md fall through to CLAUDE.md, and a blank pair to nothing", () => {
    expect(
      repoInstructionsResource([
        { file: "AGENTS.md", text: "  \n" },
        { file: "CLAUDE.md", text: "claude" },
      ])?.text,
    ).toBe(`${HEADER("CLAUDE.md")}\n\nclaude`);
    expect(repoInstructionsResource([{ file: "AGENTS.md", text: "\n\n" }])).toBeNull();
  });

  it("delivers a file exactly at the cap whole", () => {
    const text = "x".repeat(REPO_INSTRUCTIONS_MAX_BYTES);
    expect(repoInstructionsResource([{ file: "AGENTS.md", text }])?.text).toBe(
      `${HEADER("AGENTS.md")}\n\n${text}`,
    );
  });

  it("truncates over the cap on a line boundary and names the file to read", () => {
    const text = ["one", "two", "three", "four"].join("\n");
    const resource = repoInstructionsResource([{ file: "AGENTS.md", text }], 9);
    expect(resource?.text).toBe(
      [
        HEADER("AGENTS.md"),
        "one\ntwo",
        "[Truncated: AGENTS.md is 18 bytes and only the first 7 are shown. Read AGENTS.md at the workspace root for the rest.]",
      ].join("\n\n"),
    );
  });

  it("counts UTF-8 bytes, never splitting a multi-byte line", () => {
    // "é" is 2 bytes, "€" 3, "𝄞" 4: the first line costs 10 bytes with its newline.
    const text = "é€𝄞\nnext";
    const resource = repoInstructionsResource([{ file: "CLAUDE.md", text }], 10);
    expect(resource?.text).toContain("é€𝄞\n\n[Truncated: CLAUDE.md is 14 bytes");
    expect(resource?.text).not.toContain("next");
  });

  it("keeps only the note when the first line alone is over the cap", () => {
    const resource = repoInstructionsResource([{ file: "AGENTS.md", text: "y".repeat(20) }], 5);
    expect(resource?.text).toBe(
      `${HEADER("AGENTS.md")}\n\n[Truncated: AGENTS.md is 20 bytes and only the first 0 are shown. Read AGENTS.md at the workspace root for the rest.]`,
    );
  });
});

describe("isRepoInstructionsResource", () => {
  it("recognizes the resource by name and nothing else", () => {
    expect(isRepoInstructionsResource({ name: REPO_INSTRUCTIONS_RESOURCE_NAME, text: "" })).toBe(
      true,
    );
    expect(isRepoInstructionsResource({ name: "skills index", text: "" })).toBe(false);
  });
});
