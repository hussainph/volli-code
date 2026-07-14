import { describe, it, expect } from "vite-plus/test";
import { isValidBranchName, slugify, ticketBranchName } from "./ticket-branch";

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

describe("isValidBranchName", () => {
  it.each([["volli/VC-12-mcp-server"], ["main"], ["feature/thing"], ["release-1.2.3"], ["a"]])(
    "accepts the valid ref %s",
    (name) => {
      expect(isValidBranchName(name)).toBe(true);
    },
  );

  it.each([
    ["", "empty"],
    ["@", "the single @"],
    ["-leading", "a leading dash"],
    ["/leading", "a leading slash"],
    ["trailing/", "a trailing slash"],
    ["trailing.", "a trailing dot"],
    ["a..b", "a double dot"],
    ["a@{b", "an @{ sequence"],
    ["foo.lock", "a .lock suffix"],
    ["foo.lock/bar", "a .lock component"],
    ["has space", "a space"],
    ["ctrl\x01char", "a control character"],
    [`del${String.fromCharCode(0x7f)}char`, "a DEL character"],
    ["tilde~x", "a reserved ~"],
    ["caret^x", "a reserved ^"],
    ["colon:x", "a reserved :"],
    ["q?x", "a reserved ?"],
    ["star*x", "a reserved *"],
    ["brk[x", "a reserved ["],
    ["back\\x", "a reserved backslash"],
  ])("rejects %s (%s)", (name) => {
    expect(isValidBranchName(name)).toBe(false);
  });
});
