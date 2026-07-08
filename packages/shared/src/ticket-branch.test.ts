import { describe, it, expect } from "vite-plus/test";
import { slugify, ticketBranchName } from "./ticket-branch";

describe("slugify", () => {
  it("slugifies a basic title", () => {
    expect(slugify("MCP server")).toBe("mcp-server");
  });

  it("collapses punctuation and multiple spaces into single hyphens", () => {
    expect(slugify("Add  --  MCP,   server!!!")).toBe("add-mcp-server");
  });

  it("returns empty string for an all-punctuation title", () => {
    expect(slugify("!!!  @@@ ###")).toBe("");
  });

  it("truncates to 48 chars without leaving a trailing hyphen", () => {
    // 25 single-char words collapse to 25 'a's joined by hyphens (49 chars);
    // slicing to 48 lands on a hyphen, which must be stripped.
    const input = Array(25).fill("a").join(" ");
    const expected = Array(24).fill("a").join("-");
    const result = slugify(input);
    expect(result).toBe(expected);
    expect(result.length).toBeLessThanOrEqual(48);
    expect(result.endsWith("-")).toBe(false);
  });
});

describe("ticketBranchName", () => {
  it("builds a branch from ticket id and title", () => {
    expect(ticketBranchName("VC-12", "MCP server")).toBe("volli/VC-12-mcp-server");
  });

  it("preserves the ticket id case", () => {
    expect(ticketBranchName("VC-99", "Fix bug")).toBe("volli/VC-99-fix-bug");
  });

  it("omits the separator when the title is empty", () => {
    expect(ticketBranchName("VC-7", "")).toBe("volli/VC-7");
  });

  it("omits the separator when the title has no slug characters", () => {
    expect(ticketBranchName("VC-3", "!!! @@@ ###")).toBe("volli/VC-3");
  });
});
